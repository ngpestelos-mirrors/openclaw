import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import * as processRunner from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withProtocolGateway } from "../daemon-cli/restart-health-protocol.test-support.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { observeUpdateGatewayReadiness } from "./update-command-readiness.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
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
it.skipIf(!compiledCandidate).each([
  { mode: "none", authority: "allowed" },
  { mode: "token", authority: "allowed" },
  { mode: "token", authority: "wrong-run" },
  { mode: "token", authority: "unbound" },
  { mode: "token", authority: "revoked" },
] as const)(
  "installed readiness with $mode auth and $authority authority",
  async ({ mode, authority }) => {
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
        const siblingRunId = createUpdateRun({ trigger: "cli" }, { env: state.env }).runId;
        let faultInjected = false;
        let statusResult:
          | Awaited<ReturnType<typeof processRunner.runCommandWithTimeout>>
          | undefined;
        const runCommand = processRunner.runCommandWithTimeout;
        vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(
          async (argv, options) => {
            const statusChild = argv.includes("status") && argv.includes("--update-executor");
            if (statusChild && typeof options !== "number") {
              if (authority === "wrong-run") {
                const input = JSON.parse(String(options.input));
                input.executor.runId = siblingRunId;
                options = { ...options, input: JSON.stringify(input) };
                faultInjected = true;
              } else if (authority === "unbound") {
                options = { ...options, beforeInput: undefined };
                faultInjected = true;
              }
            }
            const result = await runCommand(argv, options);
            if (statusChild) {
              statusResult = result;
            }
            if (argv.includes("--update-executor") && argv.includes("check")) {
              expect(result, "Actual installed capability probe result").toMatchObject({
                code: 0,
                termination: "exit",
                signal: null,
                killed: false,
              });
              expect(JSON.parse(result.stdout)).toMatchObject({
                updateExecutor: "root-spawner-v1",
                targetRootBinding: true,
                retainedOwnerBinding: true,
                readinessObservation: 1,
              });
            }
            return result;
          },
        );
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
            if (authority === "allowed") {
              const previous = await observeUpdateGatewayReadiness(readiness);
              expect(previous).toMatchObject({
                readyz: false,
                health: {
                  healthy: false,
                  probeError: expect.stringContaining("protocol mismatch"),
                },
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
            }
            const previousConnections = observed.length;
            const runId = createUpdateRun({ trigger: "cli" }, { env: state.env }).runId;
            const initialVerification = getUpdateRun(runId, { env: state.env })?.verification;
            const verification = withUpdateCommandExecutor(runId, async (owner) => {
              const executorFence = await owner.enter(root);
              const result = resultFixture(root);
              const verified = await verifyUpdatedGateway({
                ...readiness,
                targetRoot: root,
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
            if (authority !== "allowed") {
              await expect(verification).rejects.toBeInstanceOf(UpdateCommandRecoveryPendingError);
              expect(faultInjected).toBe(true);
              expect(observed).toEqual([]);
              expect(getUpdateRun(runId, { env: state.env })?.verification).toEqual(
                initialVerification,
              );
              expect(statusResult?.stdout).toBe("");
              expect(statusResult?.stderr).toContain("UPDATE_NATIVE_AUTHORITY");
              return;
            }
            await verification;
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
          {
            warnings: true,
            beforeChallenge: async () => {
              if (authority !== "revoked") {
                return;
              }
              const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
              try {
                expect(
                  db
                    .prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?")
                    .run("replacement", root).changes,
                ).toBe(1);
                faultInjected = true;
              } finally {
                db.close();
              }
            },
          },
        );
      },
    );
  },
);
