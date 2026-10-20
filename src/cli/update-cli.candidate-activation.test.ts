import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { sanitizeTriageUpdateFailure } from "../commands/triage-update.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { UpdateDoctorConfigChange } from "../infra/update-doctor-config.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
} from "../infra/update-doctor-result.js";
import { resolveUpdateInstallRoot } from "../infra/update-install-root.js";
import { renderUpdateRunReport } from "../infra/update-run-report.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  commandCalls,
  doctorCommandCall,
  expectNoSideEffects,
  freshRestartCalls,
  getErrorOutput,
  getLogOutput,
  lastWriteJsonCall,
  packageInstallCommandCall,
  requireValue,
} from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import { candidateStartupStep as startupStep } from "./update-cli-lifecycle.test-support.js";
import {
  candidateValidation,
  inferenceRepair,
  loadInstalledPluginIndexInstallRecords,
  restartHealthTestControl,
  resumeScheduledTaskAutoStartAfterUpdate,
  serviceDefinitionMutationCapability,
  serviceLoaded,
  serviceReadRuntime,
  serviceRestart,
  serviceStart,
  serviceStop,
  spawn,
  suspendScheduledTaskAutoStartForUpdate,
  syncPluginsForUpdateChannel,
  triageCommand,
} from "./update-cli-mocks.test-support.js";
import {
  defaultRuntime,
  ExitError,
  getUpdateRun,
  invokeUpdateCli,
  resolveGatewayInstallEntrypoint,
  runCommandWithTimeout,
  runDaemonRestart,
  runExec,
  updateCommand,
  updateGitCheckout,
} from "./update-cli-modules.test-support.js";
import { pluginSyncResult } from "./update-cli/update-cli-config.test-support.js";
import { recoveryVerificationStep } from "./update-cli/update-cli-failure-recovery.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const nodeExecutable = resolveTestNodeExecPath();
  const {
    mockFileBackedPathExists,
    mockNpmGlobalCommands,
    mockNpmGlobalRoot,
    mockPackageInstallAtCaseDir,
    mockRunningManagedGateway,
    mockStoppedManagedGitGateway,
    primeServiceCommand,
    profileStateDir,
    reportCandidateSteps,
    setStdoutTty,
    setTty,
    setupInstalledPackageAtNodeModules,
    setupInstalledPackageRoot,
    tempDirs,
  } = createUpdateCliFixture();

  async function expectPackageVersion(root: string, version: string) {
    expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
      version,
    });
  }

  function callOrder(mock: { mock: { invocationCallOrder: number[] } }, index = 0) {
    return requireValue(mock.mock.invocationCallOrder[index], "expected call order");
  }
  async function stoppedPackage(
    platform: NodeJS.Platform,
    prefix: string,
    env?: NodeJS.ProcessEnv,
  ) {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const dir = tempDirs.make(prefix);
    const installed = await setupInstalledPackageRoot(dir);
    primeServiceCommand(
      [nodeExecutable, installed.entryPath, "gateway", "run"],
      env,
      env?.OPENCLAW_SERVICE_MARKER && platform === "win32"
        ? resolveGatewayTaskScriptPath(process.env)
        : undefined,
    );
    serviceLoaded.mockResolvedValue(true);
    serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    mockFileBackedPathExists();
    return { ...installed, platformSpy };
  }

  it.each(["config-change", "legacy-config-change", "invalid"] as const)(
    "validates the staged candidate without inference while the previous gateway serves (%s)",
    async (outcome) => {
      const valid = outcome !== "invalid";
      const legacyConfigChange = outcome === "legacy-config-change";
      const { nodeModules, pkgRoot, entryPath } = await setupInstalledPackageAtNodeModules(
        path.join(tempDirs.make("openclaw-update-candidate-order-"), "lib", "node_modules"),
        "1.0.0",
      );
      mockNpmGlobalRoot(nodeModules);
      mockFileBackedPathExists();
      mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      const doctorChanges: UpdateDoctorConfigChange[] = [
        { kind: "key", key: "meta" },
        { kind: "key", key: "plugins" },
        { kind: "key", key: "wizard" },
        { kind: "migration", message: "Enabled the configured provider plugin." },
      ];
      if (outcome === "config-change") {
        const runCommand = requireValue(
          vi.mocked(runCommandWithTimeout).getMockImplementation(),
          "configured updater commands",
        );
        vi.mocked(runCommandWithTimeout).mockImplementation(async (argv, options) => {
          if (argv.at(-1) === "--doctor") {
            const env = typeof options === "number" ? undefined : options.env;
            const resultPath = requireValue(
              env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV],
              "Doctor receipt path",
            );
            await writeUpdatePostInstallDoctorResult({
              resultPath,
              result: { status: "ok", configChanges: doctorChanges },
            });
          }
          return runCommand(argv, options);
        });
      }
      const events: string[] = [];
      spawn.mockImplementationOnce((_node, _argv, options: { env: NodeJS.ProcessEnv }) => {
        const resultPath = options.env.OPENCLAW_UPDATE_POST_CORE_RESULT_PATH;
        if (!resultPath) {
          throw new Error("post-core result path missing");
        }
        const childResultPath = `${resultPath}.child`;
        const child = new EventEmitter();
        queueMicrotask(() => {
          void withEnvAsync(
            {
              OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
              ...options.env,
              OPENCLAW_UPDATE_POST_CORE_RESULT_PATH: childResultPath,
            },
            async () => {
              const { resumePostCoreUpdate } =
                await import("./update-cli/update-command-resume.js");
              await resumePostCoreUpdate({
                root: pkgRoot,
                channel: "stable",
                opts: { yes: true, json: true },
                timeoutMs: 30_000,
              });
            },
          )
            .then(async () => {
              // Real child environments cannot overlap the parent. Restore this
              // emulated child before its result lets the parent resume.
              await fs.rename(childResultPath, resultPath);
              child.emit("exit", 0, null);
              child.emit("close", 0, null);
            })
            .catch((error: unknown) => {
              child.emit("error", error);
              child.emit("close", 1, null);
            });
        });
        return child;
      });
      let candidateRoot: string | undefined;
      candidateValidation.mockImplementation(async (options) => {
        const { root } = options;
        candidateRoot = root;
        events.push("validate");
        expect(serviceStop).not.toHaveBeenCalled();
        expect(await serviceReadRuntime()).toMatchObject({ status: "running" });
        expect(root).not.toBe(pkgRoot);
        await expectPackageVersion(root, "9999.0.0");
        await expectPackageVersion(pkgRoot, "1.0.0");
        return reportCandidateSteps(options, {
          status: valid ? "ok" : "error",
          durationMs: 1,
          logTail: ["candidate readiness failed"],
          reason: "runtime-verification-failed",
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          doctorConfigWrites: outcome === "config-change",
          ...(legacyConfigChange || outcome === "config-change"
            ? { doctorConfigChanges: doctorChanges }
            : {}),
          steps: [startupStep(root, valid)],
        });
      });
      serviceStop.mockImplementationOnce(async () => {
        events.push("stop");
        await expectPackageVersion(pkgRoot, "1.0.0");
        serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
      });
      syncPluginsForUpdateChannel.mockImplementationOnce(async ({ config }) => {
        events.push("plugins");
        expect(await serviceReadRuntime()).toMatchObject({ status: "stopped" });
        return pluginSyncResult(config);
      });

      if (valid) {
        await updateCommand({ yes: true, json: true }).catch((cause: unknown) => {
          throw new Error(`${getErrorOutput()}\n${JSON.stringify(lastWriteJsonCall())}`, { cause });
        });
        expect(events).toEqual(["validate", "stop", "plugins"]);
        expect(spawn).toHaveBeenCalledOnce();
        expect(runExec).toHaveBeenCalledWith(
          expect.any(String),
          [entryPath, "config", "validate", "--json"],
          expect.objectContaining({ env: { OPENCLAW_UPDATE_IN_PROGRESS: "0" } }),
        );
        expect(process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBeUndefined();
        const result = lastWriteJsonCall() as UpdateRunResult;
        expect(result.status).toBe("ok");
        expect(getUpdateRun(requireValue(result.runId, "updated run id"))).toMatchObject({
          status: "succeeded",
          downtimeMs: expect.any(Number),
          verification: { readyz: true, serviceRunning: true },
        });
      } else {
        await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
        expect(events).toEqual(["validate"]);
        expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
        expect(freshRestartCalls()).toHaveLength(0);
        await expectPackageVersion(pkgRoot, "1.0.0");
        expect(lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "runtime-verification-failed",
        });
        await expect(
          fs.access(requireValue(candidateRoot, "candidate root")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      const result = lastWriteJsonCall() as UpdateRunResult;
      const record = getUpdateRun(requireValue(result.runId, "run id"));
      expect(inferenceRepair).not.toHaveBeenCalled();
      expect(record?.repair).toEqual([]);
      expect(record?.steps.some((step) => step.step === "repairing")).toBe(false);
      if (outcome === "config-change") {
        expect(record?.reason).toBeNull();
        expect(
          record?.steps.flatMap((step) => (step.configChange ? [step.configChange] : [])),
        ).toEqual(doctorChanges);
      }
      if (legacyConfigChange) {
        const warning =
          "Doctor changed config keys meta, plugins, wizard during update checks. Check those settings after the update; this version cannot verify that they were applied.";
        expect(record?.steps).toContainEqual(
          expect.objectContaining({
            step: expect.stringMatching(/^warning:/),
            status: "completed",
            detail: warning,
          }),
        );
        expect(renderUpdateRunReport(requireValue(record, "update run")).lines).toContain(
          `Warning: ${warning}`,
        );
        expect(doctorCommandCall()).toBeDefined();
      }
    },
  );

  it.each(["owned-running", "no-restart"] as const)(
    "uses compatibility-checked package update without full-state startup (%s)",
    async (mode) => {
      const root = await mockPackageInstallAtCaseDir("openclaw-update-startup-admission");
      mockFileBackedPathExists();
      mockRunningManagedGateway([
        process.execPath,
        path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      await invokeUpdateCli({
        yes: true,
        json: true,
        restart: mode !== "no-restart",
      }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(candidateValidation).toHaveBeenCalled();
      expect(doctorCommandCall()).toBeDefined();
      expect(await fs.readdir(path.dirname(profileStateDir()))).not.toContain(
        `.${path.basename(profileStateDir())}-update-checkpoints`,
      );
    },
  );

  it("keeps the live package unchanged when its executor is rebound during candidate validation", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-update-revoked-executor");
    mockFileBackedPathExists();
    const before = await fs.readFile(path.join(root, "package.json"));
    candidateValidation.mockImplementationOnce(async (options) => {
      const { createManagedHandoffLeaseStore } =
        await import("../infra/update-managed-service-handoff-lease.js");
      const store = createManagedHandoffLeaseStore();
      const found = store.read(resolveUpdateInstallRoot(root));
      if (found.kind !== "current") {
        throw new Error("Expected the real startup executor before candidate validation");
      }
      await Promise.resolve();
      expect(store.bind(found.lease, process.pid)).not.toBeNull();
      return reportCandidateSteps(options, {
        status: "ok",
        steps: [startupStep(options.root)],
      });
    });
    await expect(updateCommand({ yes: true, json: true })).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "package.json"))).toEqual(before);
    expect(doctorCommandCall()).toBeUndefined();
    expectNoSideEffects(serviceStop, serviceRestart);
  });

  it("refuses activation when successful Doctor leaves the validated candidate schema unapplied", async () => {
    const root = await mockPackageInstallAtCaseDir("openclaw-update-incomplete-migration");
    mockFileBackedPathExists();
    vi.mocked(resolveGatewayInstallEntrypoint).mockResolvedValue(
      path.join(root, "dist", "index.js"),
    );
    candidateValidation.mockImplementationOnce(async (options) =>
      reportCandidateSteps(options, {
        status: "ok",
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        steps: [startupStep(root)],
      }),
    );

    await expect(updateCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));

    expect(doctorCommandCall()).toBeDefined();
    expectNoSideEffects(serviceStart, serviceRestart, runDaemonRestart);
    expect(freshRestartCalls()).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      status: "error",
      reason: "openclaw doctor",
      steps: expect.arrayContaining([
        expect.objectContaining({
          exitCode: 1,
          stderrTail: expect.stringContaining(String(OPENCLAW_STATE_SCHEMA_VERSION + 1)),
        }),
      ]),
    });
  });

  it("stages and validates before suspending and stopping a running managed gateway", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const processOnSpy = vi.spyOn(process, "on");
    const processOffSpy = vi.spyOn(process, "off");
    suspendScheduledTaskAutoStartForUpdate.mockResolvedValue(true);
    resumeScheduledTaskAutoStartAfterUpdate.mockResolvedValue(true);
    const root = await mockPackageInstallAtCaseDir("openclaw-update-stop-service");
    vi.mocked(resolveGatewayInstallEntrypoint)
      .mockReset()
      .mockResolvedValue(path.join(root, "dist", "index.js"));
    mockRunningManagedGateway([
      nodeExecutable,
      path.join(root, "dist", "index.js"),
      "gateway",
      "run",
    ]);
    serviceDefinitionMutationCapability.mockResolvedValue({ kind: "sealed", detail: "fixture" });
    mockFileBackedPathExists();

    await updateCommand({ yes: true }).catch((cause: unknown) => {
      throw new Error(`${getErrorOutput()}\n${getLogOutput()}`, { cause });
    });
    platformSpy.mockRestore();

    const doctorCall = doctorCommandCall();
    expect(doctorCall).toBeDefined();
    expect(doctorCall?.[1].env).toMatchObject({
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    });
    expect(getLogOutput()).toContain("Gateway: restarted and verified.");
    const npmInstallCallIndex = vi
      .mocked(runCommandWithTimeout)
      .mock.calls.findIndex(
        (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
      );
    const serviceStopCall = serviceStop.mock.calls[0]?.[0] as
      | { env?: NodeJS.ProcessEnv }
      | undefined;
    expect(serviceStopCall?.env).toMatchObject({
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    const suspendOrder = callOrder(suspendScheduledTaskAutoStartForUpdate);
    const sigintListenerIndex = processOnSpy.mock.calls.findIndex(([event]) => event === "SIGINT");
    for (const action of [
      suspendScheduledTaskAutoStartForUpdate,
      resumeScheduledTaskAutoStartAfterUpdate,
    ]) {
      expect(action).toHaveBeenCalledWith(
        expect.objectContaining({
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        }),
        expect.objectContaining({ beforeMutation: expect.any(Function) }),
      );
    }
    expect(callOrder(processOnSpy, sigintListenerIndex)).toBeLessThan(suspendOrder);
    expect(suspendOrder).toBeLessThan(callOrder(serviceStop));
    const validationOrder = callOrder(candidateValidation);
    expect(callOrder(vi.mocked(runCommandWithTimeout), npmInstallCallIndex)).toBeLessThan(
      validationOrder,
    );
    expect(validationOrder).toBeLessThan(suspendOrder);
    expect(callOrder(serviceStop)).toBeLessThan(callOrder(resumeScheduledTaskAutoStartAfterUpdate));
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
      expect(processOnSpy).toHaveBeenCalledWith(signal, expect.any(Function));
      expect(processOffSpy).toHaveBeenCalledWith(signal, expect.any(Function));
    }
    processOnSpy.mockRestore();
    processOffSpy.mockRestore();
  });

  it.each([
    { platform: "darwin" as const, handoff: undefined },
    { platform: "win32" as const, handoff: "1" },
  ])(
    "quiesces a stopped loaded managed gateway on $platform before package replacement",
    async ({ platform, handoff }) => {
      const { nodeModules, platformSpy } = await stoppedPackage(
        platform,
        `openclaw-update-stopped-loaded-${platform}-`,
        { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      );
      mockNpmGlobalRoot(nodeModules);
      const stopStarted = createDeferredCore();
      const stopFinished = createDeferredCore();
      serviceStop.mockImplementationOnce(() => {
        stopStarted.resolve();
        return stopFinished.promise;
      });

      try {
        await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: handoff }, async () => {
          const updatePromise = updateCommand({ yes: true });
          const firstOutcome = await Promise.race([
            stopStarted.promise.then(() => "stop" as const),
            updatePromise.then(() => "update" as const),
          ]);

          expect(firstOutcome).toBe("stop");
          expect(serviceStop).toHaveBeenCalledOnce();
          expect(packageInstallCommandCall()).toBeDefined();
          expect(candidateValidation).toHaveBeenCalledOnce();
          await expectPackageVersion(path.join(nodeModules, "openclaw"), "2026.4.21");
          const pluginRecordCallsBeforeStop =
            loadInstalledPluginIndexInstallRecords.mock.calls.length;
          stopFinished.resolve();
          await updatePromise;
          expect(loadInstalledPluginIndexInstallRecords.mock.calls.length).toBeGreaterThan(
            pluginRecordCallsBeforeStop,
          );
        });
      } finally {
        platformSpy.mockRestore();
      }

      expect(packageInstallCommandCall()).toBeDefined();
      expect(loadInstalledPluginIndexInstallRecords).toHaveBeenCalled();
      expect(serviceStop.mock.invocationCallOrder[0]).toBeLessThan(
        requireValue(
          loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder.at(-1),
          "owned managed update context capture order",
        ),
      );
    },
  );

  it("leaves an ordinary stopped Scheduled Task stopped during package replacement", async () => {
    const { nodeModules, platformSpy } = await stoppedPackage(
      "win32",
      "openclaw-update-stopped-win32-",
    );
    mockNpmGlobalRoot(nodeModules);

    try {
      await withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, async () => {
        await updateCommand({ yes: true });
      });
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(serviceStop, serviceRestart);
    expect(packageInstallCommandCall()).toBeDefined();
  });

  it("leaves an enabled LaunchAgent untouched when staged installation fails", async () => {
    const { nodeModules, platformSpy } = await stoppedPackage(
      "darwin",
      "openclaw-update-stopped-launchagent-failure-",
      { OPENCLAW_STATE_DIR: profileStateDir() },
    );
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g") {
        throw new Error("package replacement failed");
      }
    });

    try {
      await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19999" }, async () => {
        await expect(updateCommand({ yes: true, timeout: "17" })).rejects.toEqual(new ExitError(1));
      });
    } finally {
      platformSpy.mockRestore();
    }

    expectNoSideEffects(serviceStop, serviceStart, serviceRestart);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(freshRestartCalls()).toEqual([]);

    const packageInstallCallIndex = commandCalls().findIndex(
      ([argv]) => argv[0] === "npm" && argv[1] === "i" && argv[2] === "-g",
    );
    expect(commandCalls()[packageInstallCallIndex]?.[0]).toContain("--prefix");
  });

  it.each([false, true])(
    "attempts recovery after Git mutation throws and preserves failed readiness (json=%s)",
    async (json) => {
      mockStoppedManagedGitGateway();
      setTty(true);
      setStdoutTty(true);
      const cause = new Error(
        json ? "The pipe is being closed (0x800700e8)" : "ENOSPC while replacing runtime files",
      );
      const failure = new Error(
        json
          ? `SQLite read-only worker failed to start for state.sqlite: ${cause.message}`
          : `updater interrupted after mutation: ${"replacement verification detail; ".repeat(12)}`,
        { cause },
      );
      vi.mocked(updateGitCheckout).mockImplementationOnce(async ({ opts }) => {
        await requireValue(opts.beforeGitMutation, "Git mutation admission")({});
        restartHealthTestControl.snapshot = {
          runtime: { status: "stopped", pid: null, state: "stopped" },
          portUsage: { port: 18789, status: "free", listeners: [], hints: [] },
          healthy: false,
          staleGatewayPids: [],
          waitOutcome: "timeout",
          probeError: "Gateway remains stopped after interrupted mutation.",
        };
        throw failure;
      });

      await expect(
        withEnvAsync({ OPENCLAW_UPDATE_RUN_HANDOFF: undefined }, () => updateCommand({ json })),
      ).rejects.toEqual(new ExitError(1));
      expect(serviceStop).toHaveBeenCalledOnce();
      expect(freshRestartCalls()).toHaveLength(1);
      expectNoSideEffects(serviceStart, serviceRestart);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      expect(triageCommand).toHaveBeenCalledTimes(json ? 0 : 1);
      const reportedFailure = json
        ? { result: lastWriteJsonCall() }
        : triageCommand.mock.calls[0]?.[1]?.recovery?.updateFailure;
      expect(reportedFailure).toMatchObject({
        result: {
          status: "error",
          mode: "git",
          reason: "update-failed",
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          verification: { serviceRunning: false, readyz: false, settled: false },
          steps: [
            expect.objectContaining({ name: "updater-runtime-retention", exitCode: 0 }),
            expect.objectContaining({ exitCode: 1, stderrTail: formatErrorMessage(failure) }),
            expect.objectContaining({ name: "post-stop-checks", exitCode: 0 }),
            recoveryVerificationStep([
              {
                check: "gateway-recovery",
                code: "gateway-probe-failed",
                message:
                  "Failed to restart managed gateway service after failed update: Error: Service runtime: status=stopped, state=stopped",
              },
            ]),
          ],
        },
      });
      expect(getLogOutput()).not.toMatch(/keep the gateway stopped/i);
      expect(getLogOutput()).toContain("openclaw update repair");
      if (!json) {
        const recovery = expectDefined(
          triageCommand.mock.calls[0]?.[1]?.recovery,
          "captured failed-update recovery",
        );
        const diagnostic = sanitizeTriageUpdateFailure(recovery.updateFailure, {
          env: {},
          stateDir: profileStateDir(),
        });
        expect(diagnostic).toMatchObject({
          error: expect.stringContaining("updater interrupted after mutation"),
        });
        expect(diagnostic.error).toContain(cause.message);
      }
    },
  );
});
