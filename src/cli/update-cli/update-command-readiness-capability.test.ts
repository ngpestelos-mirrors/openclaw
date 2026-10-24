import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { GatewayRestartDeadlineError } from "../daemon-cli/restart-health-deadline.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { prepareUpdatedInstallGatewayReadiness } from "./update-command-service-command.js";

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
        if ("legacy" in scenario) await expect(prepared).resolves.toBeUndefined();
        else
          await expect(prepared).rejects.toThrow(
            "Target runtime cannot fence update-owned readiness observation.",
          );
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
        if (!target) throw new Error("Current capability did not prepare readiness");
        if (fault === "deadline") {
          await expect(invoke(target)).rejects.toThrow(/readiness observation failed|cleanup/i);
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

it("returns canonical timeout for cancellation after capability negotiation", async () => {
  await withCandidate(currentCandidate, async (root, serviceEnv, runId) => {
    await withUpdateCommandExecutor(runId, async (owner) => {
      const executor = await owner.enter(root);
      const controller = new AbortController();
      const onProgress = vi.fn(() =>
        controller.abort(new GatewayRestartDeadlineError("after-capability cancellation")),
      );
      const observation = await observeUpdateGatewayReadiness({
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
      expect(onProgress).toHaveBeenCalledOnce();
      expect(observation).toMatchObject({
        readyz: false,
        health: {
          healthy: false,
          waitOutcome: "timeout",
          probeError: expect.stringContaining("after-capability cancellation"),
        },
      });
      await expect(fs.access(path.join(root, "entered-status"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      executor.assertCurrent();
    });
  });
});
