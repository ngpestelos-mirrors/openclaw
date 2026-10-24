import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withProtocolGateway } from "../daemon-cli/restart-health-protocol.test-support.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

// Only the retained parent has the old dialect. The separately executed installed
// CLI uses its own unmodified client and authenticates to the real fixture socket.
const retainedProtocol = MIN_CLIENT_PROTOCOL_VERSION - 1;
vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (options: Parameters<typeof actual.callGateway>[0]) =>
      actual.callGateway({
        ...options,
        minProtocol: retainedProtocol,
        maxProtocol: retainedProtocol,
      }),
  };
});

afterEach(() => vi.restoreAllMocks());

const compiledCandidate = !resolveRuntimeWorkerUrl(
  runtimeProcessEntrypoints.updateMigratedFinalize,
).pathname.endsWith(".ts");

// This receiver validates its own installed package root. Source-mode adapters
// cannot impersonate that root; the normal compiled-worker lane supplies it.
it.skipIf(!compiledCandidate).each(["none", "token"] as const)(
  "verifies a new installed Gateway from an old updater with %s auth",
  async (mode) => {
    await withOpenClawTestState(
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_PROFILE: "target-readiness-fixture",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.target-readiness-fixture",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-target-readiness-fixture.service",
          OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Target Readiness Fixture",
          OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        },
      },
      async (state) => {
        const root = state.path("installed");
        const control = state.path("control");
        await fs.mkdir(root);
        await fs.mkdir(control);
        vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        await prepareCandidateAuthorityRuntime(root);
        await withProtocolGateway(
          mode,
          async ({ port, config, observed, failures, httpRequests }) => {
            await state.writeConfig(config);
            const readiness = {
              serviceEnv: state.env,
              nodeRunner: process.execPath,
              gatewayPort: port,
              expectedVersion: "2026.10.23",
              expectedBuildId: "fixture-target",
              timeoutMs: 10_000,
              waitForStartup: false,
              requireRunningService: false,
            };
            const previous = await observeUpdateGatewayReadiness(readiness);
            expect(previous).toMatchObject({
              readyz: false,
              health: { healthy: false, probeError: expect.stringContaining("protocol mismatch") },
            });
            const previousConnections = observed.length;
            expect(previousConnections).toBeGreaterThan(0);
            for (const connect of observed) {
              expect(connect).toMatchObject({
                minProtocol: retainedProtocol,
                maxProtocol: retainedProtocol,
                client:
                  mode === "none"
                    ? { id: "gateway-client", mode: "backend" }
                    : { id: "cli", mode: "cli" },
              });
            }
            expect(failures).toEqual(
              Array.from({ length: previousConnections }, () => "protocol-mismatch"),
            );
            const runId = createUpdateRun({ trigger: "cli" }, { env: state.env }).runId;
            await withUpdateCommandExecutor(runId, async (owner) => {
              const executorFence = await owner.enter(root);
              const result = resultFixture(root);
              const verified = await verifyUpdatedGateway({
                ...readiness,
                result,
                opts: { json: true, run: { runId, env: state.env, executorFence } },
              });
              expect(verified.ok).toBe(true);
              expect(verified.pluginWarnings).toEqual([
                expect.objectContaining({ pluginId: "fixture-plugin" }),
              ]);
              expect(getUpdateRun(runId, { env: state.env })?.verification).toMatchObject({
                port,
                runningVersion: "2026.10.23",
                runningBuildId: "fixture-target",
                versionMatch: true,
                settled: true,
                readyz: true,
                channelsReady: false,
                pluginErrors: [expect.stringContaining("fixture plugin unavailable")],
              });
              executorFence.assertCurrent();
            });
            expect(failures).toEqual(
              Array.from({ length: previousConnections }, () => "protocol-mismatch"),
            );
            const targetConnections = observed.slice(previousConnections);
            expect(targetConnections.length).toBeGreaterThan(0);
            expect(
              targetConnections.every(
                (connect) =>
                  connect.minProtocol === PROTOCOL_VERSION &&
                  connect.maxProtocol === PROTOCOL_VERSION,
              ),
            ).toBe(true);
            expect(httpRequests).toContain("/healthz");
            expect(httpRequests).toContain("/readyz");
          },
          { warnings: true },
        );
      },
    );
  },
);
