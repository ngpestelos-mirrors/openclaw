// Prepare Gateway workers during collection, outside test deadlines.
import "../server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAgent } from "../../agents/agent-create.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunInProgress,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  getRuntimeConfig,
  resetConfigRuntimeState,
  withConfigMutationExclusive,
} from "../../config/config.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { CronService } from "../../cron/service.js";
import { startCronReceiptAuthorityHost } from "../../cron/store/receipt-authority-owner.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "../../plugin-state/plugin-state-store.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";

it.for(["active", "restart-draining", "legacy-retiring"] as const)(
  "deletes real agent storage and permits recreation after %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      {
        label: `agent-delete-${scenario}`,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        await state.writeConfig({
          gateway: { mode: "local", auth: { mode: "token", token: "agent-delete-test-token" } },
          agents: {
            ownership: "explicit",
            defaults: {
              model: "openai/gpt-4.1",
              skipBootstrap: true,
              heartbeat: { every: "0m" },
            },
            entries: { keeper: { workspace: state.workspaceDir } },
          },
          plugins: { slots: { memory: "none" } },
        });
        const workspace = state.path("workspace-doomed");
        const created = await createAgent({ name: "doomed", workspace, skipBootstrap: true });
        expect(created.status).toBe("created");
        const agentId = "doomed";
        const sessionId = "deletion-active-session";
        const sessionKey = `agent:${agentId}:active`;
        const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
        const session = {
          sessionId,
          updatedAt: 1,
          ...(scenario === "active"
            ? { agentHarnessId: "codex", lifecycleRevision: "native-binding-generation" }
            : {}),
        };
        runOpenClawAgentWriteTransaction(
          (database) => writeSessionEntry(database, sessionKey, session, { previousEntry: null }),
          { agentId, path: databasePath, env: state.env },
        );
        await fs.mkdir(state.sessionsDir(agentId), { recursive: true });
        await fs.writeFile(
          path.join(state.sessionsDir(agentId), "owned-attachment.txt"),
          "synthetic",
        );
        await fs.writeFile(path.join(workspace, "owned-work.txt"), "synthetic");
        const scheduler = createTestGatewayScheduler();
        const cron = new CronService({
          scheduler,
          storePath: state.statePath("cron/jobs.json"),
          cronEnabled: false,
          log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        });
        const context = createDirectChatContext({ cron, getRuntimeConfig });
        try {
          if (scenario === "active") {
            const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
            const hotReloadRecovery = vi.fn(async () => {
              throw new Error("Synthetic Gateway hot reload unexpectedly required recovery");
            });
            const server = await startGatewayServer(claim.port, {
              bind: "loopback",
              auth: { mode: "token", token: "agent-delete-test-token" },
              controlUiEnabled: false,
              hotReloadRecovery,
            });
            try {
              await server.startupSettled;
              const client = await connectGatewayClient({
                url: `ws://127.0.0.1:${claim.port}`,
                token: "agent-delete-test-token",
                scopes: ["operator.admin", "operator.read", "operator.write"],
              });
              const nativeApi = await loadBundledPluginFacade<
                typeof import("../../../extensions/codex/native-session-binding.test-api.js")
              >({ pluginId: "codex", artifactBasename: "native-session-binding.test-api.js" });
              const native = nativeApi.createNativeBindingDeletionFixture(
                createPluginRuntimeMock({
                  state: {
                    openSyncKeyedStore: <Value>(
                      options: Parameters<typeof createPluginStateSyncKeyedStore>[1],
                    ) =>
                      createPluginStateSyncKeyedStore<Value>("codex", {
                        ...options,
                        env: state.env,
                      }),
                    openKeyedStore: <Value>(
                      options: Parameters<typeof createPluginStateKeyedStore>[1],
                    ) =>
                      createPluginStateKeyedStore<Value>("codex", { ...options, env: state.env }),
                  },
                }),
                { agentId, sessionId, sessionKey },
              );
              const nativeClient = await nativeApi.attachNativeBindingDeletionClient(
                native.store,
                native.key,
              );
              const registry = getPluginRegistryState()?.activeRegistry;
              if (!registry) {
                throw new Error("Gateway did not publish its plugin registry");
              }
              const plugin = createPluginRecord({ id: "codex" });
              const registration = {
                pluginId: "codex",
                source: "runtime",
                harness: native.harness,
              };
              registry.plugins.push(plugin);
              registry.agentHarnesses.push(registration);
              try {
                const aborted = createDeferred();
                const handle = createEmbeddedRunHandle({
                  runId: "deletion-active-run",
                  abort: () => aborted.resolve(),
                });
                setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
                const deleting = client.request("agents.delete", { agentId, deleteFiles: true });
                try {
                  await withinTest(
                    awaitGateBeforeSettlement(
                      aborted.promise,
                      deleting,
                      "deletion completed before aborting the active run",
                    ),
                    signal,
                  );
                  expect(readAgentDeletionJournal(agentId)?.phase).toBe("draining");
                  expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(true);
                  // Cancellation checkpoints remain writable until the retained run settles.
                  await withinTest(
                    withConfigMutationExclusive(async () => {
                      runOpenClawAgentWriteTransaction(
                        (database) =>
                          writeSessionEntry(
                            database,
                            sessionKey,
                            { ...session, updatedAt: 2, label: "aborted" },
                            { previousEntry: session },
                          ),
                        { agentId, path: databasePath, env: state.env },
                      );
                    }),
                    signal,
                  );
                } finally {
                  clearActiveEmbeddedRun(sessionId, handle, sessionKey);
                  await deleting;
                }
                expect(await deleting).toMatchObject({
                  ok: true,
                  failed: [],
                  removed: expect.arrayContaining([{ path: workspace, method: "trash" }]),
                });
                expect(await deleting).not.toHaveProperty("purgeFailed");
                expect(native.store.lookup(native.key)).toBeUndefined();
                expect(nativeClient.subscribed()).toBe(false);
                expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(false);
                expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
                for (const pathname of [
                  workspace,
                  state.agentDir(agentId),
                  state.sessionsDir(agentId),
                  databasePath,
                ]) {
                  await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
                }
                await expect(
                  client.request("agents.create", { name: agentId, workspace }),
                ).resolves.toMatchObject({ ok: true, agentId });
                expect(readAgentDeletionJournal(agentId)).toBeUndefined();
                expect(hotReloadRecovery).not.toHaveBeenCalled();
              } finally {
                registry.agentHarnesses.splice(registry.agentHarnesses.indexOf(registration), 1);
                registry.plugins.splice(registry.plugins.indexOf(plugin), 1);
                await native.harness.dispose?.();
                nativeClient.close();
                vi.restoreAllMocks();
                await disconnectGatewayClient(client);
              }
            } finally {
              await server.close();
              await claim.release();
            }
            return;
          }
          beginAgentDeletionJournal({
            agentId,
            operationId: "interrupted-deletion",
            agentDir: state.agentDir(agentId),
            workspaceDir: workspace,
            sessionsDir: state.sessionsDir(agentId),
            deleteFiles: true,
            ...(scenario === "restart-draining" ? { phase: "draining" as const } : {}),
          });
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          resetConfigRuntimeState();
          startCronReceiptAuthorityHost();
          await resumeAgentDeletions(context);
          expect(context.logGateway.warn).not.toHaveBeenCalled();
          expect(readAgentDeletionJournal(agentId)?.cleanupCompleted).toBe(true);
          for (const pathname of [
            workspace,
            state.agentDir(agentId),
            state.sessionsDir(agentId),
            databasePath,
          ]) {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expect(getRuntimeConfig().agents?.entries).not.toHaveProperty(agentId);
          expect(
            await createAgent({ name: agentId, workspace, skipBootstrap: true }),
          ).toMatchObject({
            status: "created",
            agentId,
          });
          expect(readAgentDeletionJournal(agentId)).toBeUndefined();
        } finally {
          cron.stop();
          await cron.waitForIdle();
          await scheduler.stop();
        }
      },
    );
  },
);
