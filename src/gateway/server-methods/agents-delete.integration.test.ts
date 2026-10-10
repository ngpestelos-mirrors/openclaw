import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { movePathToTrash } from "../../plugin-sdk/browser-maintenance.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { beginAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { deleteGatewayAgent } from "./agents-delete.js";

vi.mock("../../plugin-sdk/browser-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/browser-maintenance.js")>()),
  movePathToTrash: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it.for(["active", "restart-draining", "legacy-retiring"] as const)(
  "deletes real agent storage and permits recreation after %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState({ label: `agent-delete-${scenario}` }, async (state) => {
      await state.writeConfig({
        agents: { entries: { keeper: { workspace: state.workspaceDir } } },
      });
      const workspace = state.path("workspace-doomed");
      const created = await createAgent({ name: "doomed", workspace, skipBootstrap: true });
      expect(created.status).toBe("created");
      const agentId = "doomed";
      const sessionId = "deletion-active-session";
      const sessionKey = `agent:${agentId}:active`;
      const databasePath = path.join(state.agentDir(agentId), "openclaw-agent.sqlite");
      const session = { sessionId, updatedAt: 1 };
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
      vi.mocked(movePathToTrash).mockImplementation(async (pathname) => {
        expect(path.relative(state.root, pathname)).not.toMatch(/^\.\.(?:\/|$)/);
        expect(pathname).not.toBe(state.root);
        await fs.rm(pathname, { recursive: true, force: true });
        return pathname;
      });
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
          const aborted = createDeferred();
          const handle = createEmbeddedRunHandle({
            runId: "deletion-active-run",
            abort: () => aborted.resolve(),
          });
          setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId);
          const deleting = deleteGatewayAgent(agentId, true, context);
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
          expect(await deleting).toMatchObject({ ok: true, failed: [] });
          expect(isEmbeddedAgentRunInProgress(sessionId)).toBe(false);
        } else {
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
          await resumeAgentDeletions(context);
          expect(context.logGateway.warn).not.toHaveBeenCalled();
        }
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
        expect(await createAgent({ name: agentId, workspace, skipBootstrap: true })).toMatchObject({
          status: "created",
          agentId,
        });
        expect(readAgentDeletionJournal(agentId)).toBeUndefined();
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    });
  },
);
