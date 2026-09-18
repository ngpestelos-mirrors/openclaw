import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import {
  captureGatewayServiceDefinitionBackup,
  type GatewayServiceDefinitionBackup,
} from "../../daemon/service-definition-backup.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  GatewayServiceDefinitionPublicationSchema,
  type GatewayServiceDefinitionPublication,
} from "../../daemon/service-stage.js";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveNodeRunner, type UpdateCommandOptions } from "./shared.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import {
  runGatewayInstallWithLoadBoundary,
  type UpdateServiceLoadBoundary,
} from "./update-command-service-load.js";

export const DEFINITION_DENIAL = /\bSERVICE_DEFINITION_(?:SEALED|UNKNOWN):[^\n]*/;

/** The installed CLI observed failed health after accepting activation, not a refusal. */
export class GatewayRestartHealthError extends Error {
  override name = "GatewayRestartHealthError";
}

export function isPackageManagerUpdateMode(
  mode: UpdateRunResult["mode"],
): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

function formatCommandFailure(stdout: string, stderr: string): string {
  // Keep the stable denial even when JSON stdout accompanies unrelated stderr warnings.
  const error = safeParseJsonRecord(stdout)?.error;
  const detail =
    `${stderr}\n${stdout}`.match(DEFINITION_DENIAL)?.[0] ??
    (typeof error === "string" ? error : stderr || stdout).trim();
  return detail ? detail.split("\n").slice(-3).join("\n") : "command returned a non-zero exit code";
}

/** Probe the staged target before activation, retaining the original child owner. */
export async function isUpdatedInstallGatewayExecutorSupported(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  executor: UpdateRecoveryFence;
  timeoutMs: number;
  nodeRunner?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const entrypoint = await resolveGatewayInstallEntrypoint(params.root);
  params.executor.assertCurrent();
  if (!entrypoint) {
    return false;
  }
  const argv = [
    params.nodeRunner ?? resolveNodeRunner(),
    entrypoint,
    "gateway",
    "install",
    "--update-executor",
    "check",
    "--json",
  ];
  const check = await withUpdateCommandExecutorChild(
    params.executor,
    params.root,
    (_grant, bindChild) =>
      runCommandWithTimeout(argv, {
        input: "",
        beforeInput: bindChild,
        baseEnv: {},
        cwd: params.root,
        env: { ...params.env, OPENCLAW_NO_RESPAWN: "1" },
        timeoutMs: params.timeoutMs,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        ...(params.signal ? { signal: params.signal } : {}),
        maxOutputBytes: 64 * 1024,
      }),
  );
  params.signal?.throwIfAborted();
  params.executor.assertCurrent();
  const capability = safeParseJsonRecord(check.stdout);
  return (
    check.code === 0 &&
    check.termination === "exit" &&
    check.signal === null &&
    !check.killed &&
    // The child wrapper has joined the complete process tree before returning.
    // Graceful descendant settlement is not an unsupported target capability.
    (check.cleanup === "normal" || check.cleanup === "cooperative") &&
    !check.stdoutTruncatedBytes &&
    !check.outputLimitExceeded &&
    !check.outputErrorStream &&
    capability?.updateExecutor === GATEWAY_UPDATE_EXECUTOR_CONTRACT &&
    capability.targetRootBinding === true
  );
}

type UpdatedInstallGatewayCommandParams = {
  result: { root?: string; mode?: UpdateRunResult["mode"] };
  opts: Pick<UpdateCommandOptions, "json" | "run">;
  invocationEnv: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceInstallEnv?: NodeJS.ProcessEnv | null;
  nodeRunner?: string;
  gatewayPort?: number;
  timeoutMs?: number;
  invocationCwd?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  serviceLoadBoundary?: UpdateServiceLoadBoundary;
  onResponse?: (response: Record<string, unknown>) => void;
};

export async function refreshUpdatedGatewayService(
  params: UpdatedInstallGatewayCommandParams & {
    serviceEnv: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    onDefinitionBackup?: (backup: GatewayServiceDefinitionBackup) => void;
    onWarnings?: (warnings: readonly string[]) => void;
  },
): Promise<void> {
  const { assertCurrent } = params;
  const backup = await withGatewayServiceOperationLock(params.serviceEnv, async () => {
    const command = await resolveGatewayService().readCommand(params.serviceEnv, {
      requireEffective: true,
    });
    assertCurrent();
    return command
      ? await captureGatewayServiceDefinitionBackup({
          env: params.serviceEnv,
          command,
          assertCurrent,
        })
      : undefined;
  }).catch((error: unknown) => {
    assertCurrent();
    throw new Error(
      `SERVICE_DEFINITION_UNKNOWN: Service backup failed: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  });
  if (backup) {
    // Failed children must retain the unsealed receipt's guard against unverified rewrites.
    params.onDefinitionBackup?.(backup);
    params.onWarnings?.([`Gateway service definition backup: ${backup.backupPaths.join(", ")}`]);
  }
  const warnings: string[] = [];
  let publication: GatewayServiceDefinitionPublication | undefined;
  await runUpdatedInstallGatewayCommand(
    {
      ...params,
      onResponse: (response) => {
        if (Array.isArray(response.warnings)) {
          warnings.push(
            ...response.warnings.filter((value): value is string => typeof value === "string"),
          );
        }
        const parsed = GatewayServiceDefinitionPublicationSchema.safeParse(
          response.action === "install" && response.ok === true
            ? response.definitionPublication
            : undefined,
        );
        if (parsed.success) {
          publication = parsed.data;
        }
      },
    },
    "install",
  ).catch(async (error: unknown) => {
    assertCurrent();
    if (backup && !DEFINITION_DENIAL.test(formatErrorMessage(error))) {
      try {
        await withGatewayServiceOperationLock(params.serviceEnv, () => backup.seal("original"));
      } catch (verificationError) {
        assertCurrent();
        params.onWarnings?.([
          `Could not verify the original service definition after installer failure; retained the backup: ${formatErrorMessage(verificationError)}`,
        ]);
      }
    }
    throw error;
  });
  if (backup) {
    const published = publication;
    if (published) {
      try {
        await withGatewayServiceOperationLock(params.serviceEnv, () => backup.seal(published));
      } catch (error) {
        assertCurrent();
        params.onWarnings?.(warnings);
        throw new Error(
          `SERVICE_DEFINITION_UNKNOWN: Could not verify the installer publication: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
    } else {
      warnings.push(
        "The installer did not return service publication facts; the backup is retained for manual recovery.",
      );
    }
  }
  if (warnings.length) {
    params.onWarnings?.(warnings);
  }
}

// Loaded before package replacement: activation dependencies must stay eager.
// Candidate version/preservation guards reject older targets before repair, without retry.
export async function runUpdatedInstallGatewayCommand(
  params: UpdatedInstallGatewayCommandParams,
  action: "install" | "restart",
  preserveDefinition = false,
): Promise<"accepted" | "unverified"> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (params.opts.run !== run || run?.executorFence !== executor) {
      throw new Error("Native command lost its original update executor.");
    }
    executor?.assertCurrent();
    params.assertCurrent?.();
  };
  assertCurrent();
  const installing = action === "install";
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  assertCurrent();
  if (!entrypoint) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }
  const args = ["gateway", action];
  if (installing) {
    args.push("--force");
    if (params.gatewayPort !== undefined) {
      args.push("--port", String(params.gatewayPort));
    }
  } else if (preserveDefinition) {
    args.push("--preserve-definition");
  }
  // Capture one structured child result in both outer output modes.
  args.push("--json");
  const nodeRunner = params.nodeRunner ?? resolveNodeRunner();
  const commandEnv = resolveUpdatedInstallCommandEnv({
    processEnv: installing
      ? (params.serviceInstallEnv ?? params.invocationEnv)
      : params.invocationEnv,
    serviceEnv: installing ? undefined : params.serviceEnv,
    invocationCwd: params.invocationCwd,
  });
  if (executor) {
    commandEnv.OPENCLAW_NO_RESPAWN = "1";
  }
  params.signal?.throwIfAborted();
  assertCurrent();
  const boundary = params.serviceLoadBoundary;
  const installTimeoutMs = params.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS;
  const reportResponse = (stdout: string) => {
    const response = safeParseJsonRecord(stdout);
    if (response) {
      params.onResponse?.(response);
    }
  };
  if (installing && boundary) {
    return await runGatewayInstallWithLoadBoundary({
      argv: [nodeRunner, entrypoint, ...args, "--defer-activation"],
      cwd: params.result.root,
      env: commandEnv,
      signal: params.signal,
      timeoutMs: installTimeoutMs,
      onOutput: reportResponse,
      boundary: {
        ...boundary,
        // The handoff adds an executor fence; it must not replace the repair owner.
        assertCurrent: () => {
          assertCurrent();
          boundary.assertCurrent();
        },
      },
    });
  }
  if (run && !executor) {
    throw new UpdateCommandRecoveryPendingError(
      "Native command requires its original update executor.",
    );
  }
  if (executor) {
    if (
      !params.result.root ||
      !(await isUpdatedInstallGatewayExecutorSupported({
        root: params.result.root,
        env: commandEnv,
        executor,
        timeoutMs: installTimeoutMs,
        nodeRunner,
        signal: params.signal,
      }))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Target runtime cannot fence update-owned native commands.",
      );
    }
    assertCurrent();
  }

  const runChild = (
    grant?: UpdateCommandChildGrant,
    bindChild?: (pid: number, argv?: readonly string[]) => void,
  ) => {
    const argv = [nodeRunner, entrypoint, ...args, ...(grant ? ["--update-executor", "run"] : [])];
    return runCommandWithTimeout(argv, {
      // The complete owned env must not regain selectors removed during capture.
      baseEnv: {},
      ...(grant
        ? {
            input: JSON.stringify({
              executor: grant,
              action,
              targetRoot: resolveUpdateInstallRoot(params.result.root!),
            }),
            beforeInput: bindChild,
          }
        : {}),
      cwd: params.result.root,
      env: commandEnv,
      timeoutMs: installing ? installTimeoutMs : params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    });
  };
  const res = executor
    ? await withUpdateCommandExecutorChild(executor, params.result.root!, runChild)
    : await runChild();
  params.signal?.throwIfAborted();
  assertCurrent();
  const exited =
    res.termination === "exit" &&
    res.signal === null &&
    !res.killed &&
    res.cleanup !== "forced" &&
    res.cleanup !== "uncertain";
  const complete = !res.stdoutTruncatedBytes && !res.outputLimitExceeded && !res.outputErrorStream;
  const response = complete ? safeParseJsonRecord(res.stdout) : undefined;
  if (exited && res.code === 0) {
    if (response) {
      params.onResponse?.(response);
    }
    return response?.action === action &&
      response.ok === true &&
      action === "restart" &&
      (response.result === "restarted" || response.result === "scheduled")
      ? "accepted"
      : "unverified";
  }
  const operation = installing ? "refresh" : action;
  const message = `updated install ${operation} failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`;
  if (
    exited &&
    res.code === 1 &&
    action === "restart" &&
    response?.action === "restart" &&
    response.ok === false &&
    response.result === "restart-health-failed" &&
    typeof response.error === "string"
  ) {
    throw new GatewayRestartHealthError(message);
  }
  if (executor && message.includes("UPDATE_NATIVE_AUTHORITY:")) {
    throw new UpdateCommandRecoveryPendingError(message);
  }
  throw new Error(message);
}
