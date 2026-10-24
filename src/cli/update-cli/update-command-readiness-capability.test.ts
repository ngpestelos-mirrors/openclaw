import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createGatewayRestartDeadline,
  GatewayRestartDeadlineError,
} from "../daemon-cli/restart-health-deadline.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { prepareUpdatedInstallGatewayReadiness } from "./update-command-service-command.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

afterEach(() => vi.restoreAllMocks());

const legacy = {
  updateExecutor: "root-spawner-v1",
  targetRootBinding: true,
  retainedOwnerBinding: true,
};
const capabilityCases = [
  { name: "tagged legacy", output: JSON.stringify(legacy), legacy: true },
  { name: "malformed", output: "{" },
  { name: "failed", output: JSON.stringify(legacy), exitCode: 1 },
  { name: "unbound", output: JSON.stringify({ ...legacy, targetRootBinding: false }) },
  { name: "unsupported", output: JSON.stringify({ ...legacy, readinessObservation: 2 }) },
  { name: "truncated", output: JSON.stringify(legacy) + " ".repeat(70_000) },
] as const;
const currentCandidate = `import { finished } from "node:stream/promises";
  import { writeFileSync } from "node:fs";
  if (process.argv.includes("check")) {
    process.stdout.write(${JSON.stringify(JSON.stringify({ ...legacy, readinessObservation: 1 }))});
    await finished(process.stdin.resume());
  } else {
    await finished(process.stdin.resume());
    writeFileSync("entered-status", "entered");
    setInterval(() => {}, 1_000);
  }`;

// Only capability stdout is synthetic. Process execution, parent admission,
// PID/start binding, fencing and child settlement use their production owners.
async function withCandidate<T>(
  script: string,
  run: (root: string, env: NodeJS.ProcessEnv, runId: string) => Promise<T>,
) {
  return await withOpenClawTestState(
    { env: { OPENCLAW_UPDATE_RUN_HANDOFF: undefined } },
    async (state) => {
      const root = state.path("installed");
      const control = state.path("control");
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.mkdir(control);
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await fs.writeFile(path.join(root, "dist", "index.mjs"), script);
      const runId = createUpdateRun({ trigger: "cli" }, { env: state.env }).runId;
      return await run(root, state.env, runId);
    },
  );
}

it.each(capabilityCases)("readiness capability: $name", async (scenario) => {
  await withCandidate(
    `import { finished } from "node:stream/promises";
     process.stdout.write(${JSON.stringify(scenario.output)});
     await finished(process.stdin.resume());
     process.exitCode = ${"exitCode" in scenario ? scenario.exitCode : 0};`,
    async (root, serviceEnv, runId) => {
      await withUpdateCommandExecutor(runId, async (owner) => {
        const executor = await owner.enter(root);
        const prepared = prepareUpdatedInstallGatewayReadiness({
          root,
          serviceEnv,
          executor,
          nodeRunner: process.execPath,
          timeoutMs: 5_000,
          signal: new AbortController().signal,
          assertCurrent: executor.assertCurrent,
        });
        if ("legacy" in scenario) {
          await expect(prepared).resolves.toBeUndefined();
        } else {
          await expect(prepared).rejects.toThrow(
            "Target runtime cannot fence update-owned readiness observation.",
          );
        }
      });
    },
  );
});

it.each(["closed-owner", "deadline"] as const)(
  "does not retain readiness authority after %s",
  async (fault) => {
    await withCandidate(currentCandidate, async (root, serviceEnv, runId) => {
      const invoke = (
        target: NonNullable<Awaited<ReturnType<typeof prepareUpdatedInstallGatewayReadiness>>>,
      ) => target({ gatewayPort: 19101, timeoutMs: 1_000, waitForStartup: false });
      const prepared = await withUpdateCommandExecutor(runId, async (owner) => {
        const executor = await owner.enter(root);
        const target = await prepareUpdatedInstallGatewayReadiness({
          root,
          serviceEnv,
          executor,
          nodeRunner: process.execPath,
          timeoutMs: 5_000,
          signal: new AbortController().signal,
          assertCurrent: executor.assertCurrent,
        });
        expect(target).toBeTypeOf("function");
        if (!target) {
          throw new Error("Current capability did not prepare readiness");
        }
        if (fault === "deadline") {
          await expect(invoke(target)).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
          expect(await fs.readFile(path.join(root, "entered-status"), "utf8")).toBe("entered");
        }
        return target;
      });
      if (fault === "closed-owner") {
        await expect(invoke(prepared)).rejects.toThrow(/admission is closed|no longer current/i);
        await expect(fs.access(path.join(root, "entered-status"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  },
);

it("bounds target recovery while retaining the completed observation", async ({ signal }) => {
  const receipt = {
    health: {
      runtime: { status: "stopped", detail: "fixture stopped before recovery" },
      portUsage: { port: 19101, status: "free", listeners: [], hints: [] },
      healthy: false,
      staleGatewayPids: [],
    },
    readyz: false,
    http: { healthz: 503, readyz: 503, coreReady: false },
  };
  await withCandidate(
    `import { finished } from "node:stream/promises";
     process.stdout.write(process.argv.includes("check")
       ? ${JSON.stringify(JSON.stringify({ ...legacy, readinessObservation: 1 }))}
       : ${JSON.stringify(JSON.stringify(receipt))});
     await finished(process.stdin.resume());`,
    async (root, serviceEnv, runId) => {
      await withUpdateCommandExecutor(runId, async (owner) => {
        const executor = await owner.enter(root);
        const release = createDeferred();
        const recovered = createDeferred();
        const deadline = createGatewayRestartDeadline({ timeoutMs: 5_000 });
        const recoverHealth: NonNullable<
          Parameters<typeof observeUpdateGatewayReadiness>[0]["recoverHealth"]
        > = vi.fn(async (health) => {
          try {
            await release.promise;
            return { health, launchAgentRecovery: null };
          } finally {
            recovered.resolve();
          }
        });
        const work = observeUpdateGatewayReadiness({
          targetRoot: root,
          executor,
          serviceEnv,
          nodeRunner: process.execPath,
          gatewayPort: 19101,
          deadline,
          waitForStartup: false,
          recoverHealth,
        });
        try {
          const observation = await withinTest(work, signal);
          expect(recoverHealth).toHaveBeenCalledOnce();
          expect(observation).toMatchObject({
            readyz: false,
            health: {
              runtime: { status: "stopped", detail: "fixture stopped before recovery" },
              healthy: false,
              waitOutcome: "timeout",
              startupPhase: "timed out during Gateway recovery",
            },
            http: { healthz: 503, readyz: 503, coreReady: false },
          });
          expect(await deadline.cleanup).toBe("confirmed");
          executor.assertCurrent();
        } finally {
          release.resolve();
          if (vi.mocked(recoverHealth).mock.calls.length > 0) {
            await recovered.promise;
          }
          await work.catch(() => undefined);
          deadline.dispose();
        }
      });
    },
  );
}, 15_000);

it("preserves pending recovery for cancellation after capability negotiation", async () => {
  await withCandidate(currentCandidate, async (root, serviceEnv, runId) => {
    await expect(
      withUpdateCommandExecutor(runId, async (owner) => {
        const executor = await owner.enter(root);
        const controller = new AbortController();
        const onProgress = vi.fn(() =>
          controller.abort(new GatewayRestartDeadlineError("after-capability cancellation")),
        );
        const observation = observeUpdateGatewayReadiness({
          targetRoot: root,
          executor,
          serviceEnv,
          nodeRunner: process.execPath,
          gatewayPort: 19101,
          timeoutMs: 5_000,
          signal: controller.signal,
          waitForStartup: false,
          onProgress,
        });
        await expect(observation).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
        expect(onProgress).toHaveBeenCalledOnce();
        await expect(fs.access(path.join(root, "entered-status"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    ).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
  });
});

it.each(["incomplete", "malformed-final", "completed-timeout"] as const)(
  "does not infer a failed Gateway from a %s target observation",
  async (outcome) => {
    const receipt = {
      health: {
        runtime: { status: "running", pid: process.pid },
        portUsage: { port: 19101, status: "free", listeners: [], hints: [] },
        healthy: false,
        staleGatewayPids: [],
        waitOutcome: "timeout",
        startupPhase: "startup migration",
      },
      readyz: false,
    };
    await withCandidate(
      `import { finished } from "node:stream/promises";
       import { writeFileSync } from "node:fs";
       import { setTimeout } from "node:timers/promises";
       if (process.argv.includes("check")) {
         process.stdout.write(${JSON.stringify(JSON.stringify({ ...legacy, readinessObservation: 1 }))});
         await finished(process.stdin.resume());
       } else {
         await finished(process.stdin.resume());
         await setTimeout(50);
         writeFileSync("emitted-startup", "yes");
         process.stderr.write("Gateway readiness (readiness): startup migration; service=running\\n");
         ${outcome === "incomplete" ? "setInterval(() => {}, 1_000);" : `process.stdout.write(${JSON.stringify(JSON.stringify(outcome === "malformed-final" ? {} : receipt))});`}
       }`,
      async (root, serviceEnv, runId) => {
        await withUpdateCommandExecutor(runId, async (owner) => {
          const executorFence = await owner.enter(root);
          const recoverHealth = vi.fn(() => {
            throw new Error("A pending observation must not initiate recovery");
          });
          const initialVerification = getUpdateRun(runId, { env: serviceEnv })?.verification;
          const verification = verifyUpdatedGateway({
            targetRoot: root,
            result: resultFixture(root),
            opts: { json: true, run: { runId, env: serviceEnv, executorFence } },
            serviceEnv,
            nodeRunner: process.execPath,
            gatewayPort: 19101,
            timeoutMs: 5_000,
            recoverHealth,
          });
          if (outcome !== "completed-timeout") {
            await expect(verification).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
            await expect(verification).rejects.toThrow(/startup migration/);
            expect(getUpdateRun(runId, { env: serviceEnv })?.verification).toEqual(
              initialVerification,
            );
          } else {
            await expect(verification).resolves.toMatchObject({
              ok: false,
              stopReason: "gateway-readiness-pending",
            });
            expect(getUpdateRun(runId, { env: serviceEnv })?.verification).toMatchObject({
              serviceRunning: true,
              pid: process.pid,
              settled: false,
              readyz: false,
            });
          }
          expect(await fs.readFile(path.join(root, "emitted-startup"), "utf8")).toBe("yes");
          expect(recoverHealth).not.toHaveBeenCalled();
          executorFence.assertCurrent();
        });
      },
    );
  },
);
