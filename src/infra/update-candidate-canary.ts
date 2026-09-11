import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { signalProcessTree } from "../process/kill-tree.js";
import {
  parseOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  prepareUpdateCandidateRehearsal,
  type UpdateCandidateRehearsal,
} from "./update-candidate-rehearsal.js";
import { cleanupUpdateTemporaryDirectory } from "./update-maintenance.js";
import { resolveUpdateDoctorExecutionPolicy } from "./update-runner-doctor.js";
import type { UpdateStepResult } from "./update-runner-types.js";

type CanaryPhase =
  | "snapshot"
  | "doctor"
  | "health"
  | "config"
  | "plugins"
  | "runtime"
  | "startup"
  | "readiness";
type CanaryResult = {
  phase: CanaryPhase;
  durationMs: number;
  logTail: string[];
  steps: UpdateStepResult[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
} & (
  | { status: "ok" }
  | {
      status: "error";
      reason: "doctor-failed" | "runtime-verification-failed";
    }
);

function readValidationFailure(stdout: string): string | undefined {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(result)) {
    return undefined;
  }
  if (isRecord(result.error) && typeof result.error.message === "string") {
    return result.error.message;
  }
  if (Array.isArray(result.findings)) {
    const messages = result.findings
      .filter((finding) => isRecord(finding) && finding.severity === "error")
      .slice(0, 3)
      .flatMap((finding) =>
        isRecord(finding) && typeof finding.message === "string"
          ? [
              [finding.message, typeof finding.fixHint === "string" ? finding.fixHint : undefined]
                .filter(Boolean)
                .join(" "),
            ]
          : [],
      );
    return messages.length ? messages.join("\n") : undefined;
  }
  return undefined;
}

async function waitBounded(
  promise: Promise<unknown>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, milliseconds));
        abort = resolve;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          resolve();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function terminateCanary(
  child: ChildProcess,
  closed: Promise<unknown>,
  deadline: number,
): Promise<void> {
  if (!child.pid) {
    return;
  }
  const options = { detached: process.platform !== "win32" };
  const signal = (kind: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      signalProcessTree(child.pid!, kind, { ...options, onComplete: resolve });
    });
  await waitBounded(
    Promise.all([signal("SIGTERM"), closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
  // A reaped group leader does not prove its descendants have exited.
  await waitBounded(
    Promise.all([signal("SIGKILL"), closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
}

/** Rehearse the exact candidate against private SQLite snapshots while the serving generation stays up. */
export async function validateUpdateCandidateCanary(params: {
  root: string;
  config: OpenClawConfig;
  stateDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
  rehearsal?: UpdateCandidateRehearsal;
  assertCurrent?: () => void;
  /** Emit at completion; replaying after the canary shifts persisted step timestamps. */
  onStep?: (step: UpdateStepResult) => void;
}): Promise<CanaryResult> {
  const started = Date.now();
  const budget = Math.max(1, params.timeoutMs ?? 300_000);
  const deadline = started + budget;
  const workDeadline = deadline - Math.min(2_000, Math.floor(budget / 10));
  const remaining = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    const milliseconds = workDeadline - Date.now();
    if (milliseconds <= 0) {
      throw new Error("Update validation timed out");
    }
    return milliseconds;
  };
  let rehearsal = params.rehearsal;
  const sourceEnv = params.env ?? process.env;
  const logTail: string[] = [];
  const steps: UpdateStepResult[] = [];
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let phase: CanaryPhase = "snapshot";
  let stepStarted = started;
  let stepName = "Preparing update checks";
  const stepLog: string[] = [];
  let env: NodeJS.ProcessEnv = { ...sourceEnv };
  const capture = (chunk: Buffer | string) => {
    const safe = redactSupportString(
      String(chunk),
      { env, stateDir: params.stateDir },
      { maxLength: 20_000 },
    );
    const lines = safe
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(-512));
    logTail.push(...lines);
    stepLog.push(...lines);
    stepLog.splice(0, Math.max(0, stepLog.length - 40));
    logTail.splice(0, Math.max(0, logTail.length - 40));
  };
  const launch = (entry: string, args: string[]) => {
    params.assertCurrent?.();
    const child = spawn(params.nodeRunner ?? process.execPath, [entry, ...args], {
      cwd: params.root,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stdoutBytes = 0;
    let outputExceeded = false;
    const flushers = [child.stdout, child.stderr].map((stream) => {
      // Node entrypoints emit UTF-8; pipe chunks need not end at code-point boundaries.
      stream.setEncoding("utf8");
      let pending = "";
      let droppingLine = false;
      stream.on("data", (chunk: string) => {
        let text = chunk;
        if (droppingLine) {
          const newline = text.indexOf("\n");
          if (newline < 0) {
            return;
          }
          text = text.slice(newline + 1);
          droppingLine = false;
        }
        pending += text;
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          capture(line);
        }
        if (pending.length > 64 * 1024) {
          // Discard an oversized unterminated line whole, never through a secret.
          pending = "";
          droppingLine = true;
          capture("[oversized log line omitted]");
        }
      });
      return () => {
        if (pending) {
          capture(pending);
          pending = "";
        }
      };
    });
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= 1024 * 1024) {
        stdout += chunk;
      } else {
        outputExceeded = true;
      }
    });
    let exited = false;
    const closed = new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        capture(error.message);
        exited = true;
        resolve(null);
      });
      child.once("close", (code) => {
        for (const flush of flushers) {
          flush();
        }
        exited = true;
        resolve(code);
      });
    });
    return {
      child,
      closed,
      hasExited: () => exited,
      stdout: () => stdout,
      outputExceeded: () => outputExceeded,
    };
  };
  try {
    const entry = await resolveGatewayInstallEntrypoint(params.root);
    if (!entry) {
      throw new Error("The update is missing its Gateway executable");
    }
    const continuationEntry = path.join(
      params.root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    phase = "runtime";
    try {
      await fs.lstat(continuationEntry);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      const message = "This version uses the current updater to finish installation";
      const step: UpdateStepResult = {
        name: "Checking update recovery",
        command: "--check",
        cwd: params.root,
        durationMs: Date.now() - started,
        exitCode: null,
        stdoutTail: message,
        advisory: { kind: "candidate-runtime-unavailable", message },
      };
      steps.push(step);
      params.onStep?.(step);
      // Older targets also lack the isolated canary CLI; retain their shipped finalization path.
      return { status: "ok", phase, durationMs: Date.now() - started, logTail, steps };
    }
    phase = "snapshot";
    const policy = resolveUpdateDoctorExecutionPolicy({
      targetVersion: await readPackageVersion(params.root),
      allowGatewayServiceRepair: false,
    });
    if (!policy.fix) {
      throw new Error(
        "This version cannot safely check migrations without changing the running service",
      );
    }
    rehearsal ??= await prepareUpdateCandidateRehearsal({
      candidateRoot: params.root,
      config: params.config,
      stateDir: params.stateDir,
      env: sourceEnv,
      nodeRunner: params.nodeRunner,
      timeoutMs: remaining(),
      signal: params.signal,
    });
    env = { ...rehearsal.env };
    const { port } = rehearsal;
    const commands: Array<{ phase: CanaryPhase; name: string; args: string[]; entry?: string }> = [
      {
        phase: "doctor",
        name: "Checking data migrations",
        args: ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
      },
      {
        phase: "health",
        name: "Checking update health",
        args: ["doctor", "--lint", "--json", "--severity-min", "error"],
      },
      {
        phase: "config",
        name: "Checking configuration",
        args: ["config", "validate", "--json"],
      },
      {
        phase: "plugins",
        name: "Checking plugins",
        args: ["plugins", "list", "--json"],
      },
      {
        phase: "runtime",
        name: "Checking update recovery",
        // After a schema bump only a fresh candidate may finalize the run;
        // prove its full recovery import graph before live state changes.
        entry: continuationEntry,
        args: ["--check"],
      },
    ];
    for (const command of commands) {
      phase = command.phase;
      env.OPENCLAW_UPDATE_IN_PROGRESS = phase === "doctor" ? "1" : "0";
      remaining();
      stepStarted = Date.now();
      stepName = command.name;
      stepLog.length = 0;
      const running = launch(command.entry ?? entry, command.args);
      let code: number | null = null;
      try {
        await waitBounded(
          running.closed.then((value) => {
            code = value;
          }),
          remaining(),
          params.signal,
        );
      } finally {
        await terminateCanary(running.child, running.closed, deadline);
      }
      if (code === 0 && phase === "plugins") {
        const inventory: unknown = running.outputExceeded()
          ? undefined
          : JSON.parse(running.stdout());
        const plugins =
          isRecord(inventory) && Array.isArray(inventory.plugins) ? inventory.plugins : undefined;
        const registry =
          isRecord(inventory) && isRecord(inventory.registry) ? inventory.registry : undefined;
        const diagnostics = [
          ...(isRecord(inventory) && Array.isArray(inventory.diagnostics)
            ? inventory.diagnostics
            : []),
          ...(Array.isArray(registry?.diagnostics) ? registry.diagnostics : []),
        ];
        if (
          !plugins ||
          plugins.some((plugin) => isRecord(plugin) && plugin.status === "error") ||
          diagnostics.some((diagnostic) => isRecord(diagnostic) && diagnostic.level === "error")
        ) {
          code = 1;
          capture("Plugin checks reported errors");
        }
      }
      if (code === 0 && phase === "runtime") {
        const contract: unknown = running.outputExceeded()
          ? undefined
          : JSON.parse(running.stdout());
        candidateSchemaVersions = parseOpenClawSchemaVersions(contract);
        if (!candidateSchemaVersions) {
          code = 1;
          capture("The update did not report its supported database versions");
        }
      }
      const step: UpdateStepResult = {
        name: command.name,
        command: command.args.join(" "),
        cwd: params.root,
        durationMs: Date.now() - stepStarted,
        exitCode: code,
      };
      steps.push(step);
      if (code !== 0) {
        const summary = !running.hasExited()
          ? `${command.name} timed out.`
          : (readValidationFailure(running.outputExceeded() ? "" : running.stdout()) ??
            stepLog.at(-1) ??
            `${command.name} failed (exit code ${code ?? "unknown"}).`);
        step.failureSummary = redactSupportString(
          summary,
          { env, stateDir: params.stateDir },
          { maxLength: 1024 },
        );
        step.stderrTail = stepLog.join("\n");
        throw new Error(step.failureSummary);
      }
      params.onStep?.(step);
    }
    if (!candidateSchemaVersions) {
      throw new Error("The update did not report its supported database versions");
    }
    phase = "startup";
    remaining();
    const gatewayStart = Date.now();
    stepStarted = gatewayStart;
    stepName = "Checking Gateway startup";
    stepLog.length = 0;
    const running = launch(entry, [
      "gateway",
      "run",
      "--update-canary",
      "--bind",
      "loopback",
      "--port",
      String(port),
    ]);
    try {
      for (const endpoint of ["startupz", "readyz"] as const) {
        phase = endpoint === "startupz" ? "startup" : "readiness";
        while (true) {
          remaining();
          if (running.hasExited()) {
            throw new Error("The updated Gateway exited before it was ready");
          }
          try {
            const response = await fetch(`http://127.0.0.1:${port}/${endpoint}`, {
              signal: AbortSignal.any([
                AbortSignal.timeout(Math.min(1_000, remaining())),
                ...(params.signal ? [params.signal] : []),
              ]),
            });
            const payload: unknown = await response.json();
            if (
              response.status === 200 &&
              (endpoint === "readyz" || (isRecord(payload) && payload.status === "started"))
            ) {
              capture(
                `${endpoint}: ${endpoint === "startupz" ? "started" : "ready"} (${Date.now() - started}ms)`,
              );
              break;
            }
          } catch {
            // The listener may not exist yet; only the common deadline permits another probe.
          }
          await sleep(Math.min(100, remaining()), undefined, { signal: params.signal });
        }
      }
      const step: UpdateStepResult = {
        name: "Checking Gateway startup",
        command: "gateway run",
        cwd: params.root,
        durationMs: Date.now() - gatewayStart,
        exitCode: 0,
      };
      steps.push(step);
      params.onStep?.(step);
    } finally {
      await terminateCanary(running.child, running.closed, deadline);
    }
    return {
      status: "ok",
      phase,
      durationMs: Date.now() - started,
      logTail,
      candidateSchemaVersions,
      steps,
    };
  } catch (error) {
    const summary = redactSupportString(
      error instanceof Error ? error.message : String(error),
      { env, stateDir: params.stateDir },
      { maxLength: 1024 },
    );
    let failed = steps.at(-1);
    if (!failed || failed.exitCode === 0 || failed.advisory) {
      failed = {
        name: stepName,
        command: "update validation",
        cwd: params.root,
        durationMs: Date.now() - stepStarted,
        exitCode: 1,
      };
      steps.push(failed);
    }
    failed.failureSummary ??= summary;
    failed.stderrTail ??= stepLog.join("\n");
    if (!logTail.includes(summary)) {
      capture(summary);
    }
    params.onStep?.(failed);
    return {
      status: "error",
      reason:
        phase === "doctor" || phase === "health" ? "doctor-failed" : "runtime-verification-failed",
      phase,
      durationMs: Date.now() - started,
      logTail,
      candidateSchemaVersions,
      steps,
    };
  } finally {
    if (!params.rehearsal && rehearsal) {
      await cleanupUpdateTemporaryDirectory({
        directory: rehearsal.stateDir,
        root: params.root,
        name: "Removing temporary update files",
        onWarning: (step) => {
          steps.push(step);
          params.onStep?.(step);
        },
      });
    }
  }
}
