import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withFollowupRequest } from "../../agents/subagents/completion/session-followup-completion.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { getTaskById } from "../../tasks/task-registry.js";
import { getTaskRegistryStore } from "../../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../../tasks/task-registry.store.sqlite.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import {
  registerSessionFollowupTask,
  settleUnstartedGatewayAgentTask,
} from "./agent-run-task-tracking.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
});

it.each(["current", "replaced before commit", "revoked before cleanup"] as const)(
  "settles only the original unstarted followup receipt (%s)",
  async (admission) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const { runId, sessionKey, context, entry } = createTrackedDispatch();
      const authority = new AbortController();
      const requesterSessionKey = "agent:main:cleanup-requester";
      const tracking = await withFollowupRequest(
        {
          runId,
          requesterSessionKey,
          requesterSessionId: "cleanup-requester",
          requesterAgentId: "main",
          targetAgentId: "main",
          targetSessionKey: sessionKey,
          custody: {
            run: (work) => work(),
            signal: authority.signal,
            assertCurrent: () => authority.signal.throwIfAborted(),
            release: () => {},
          },
        },
        () =>
          registerSessionFollowupTask({
            followup: { kind: "session_followup", requesterSessionKey },
            runId,
            sessionKey,
            task: "Retain the original rejection receipt",
            requesterOrigin: undefined,
            assertCurrent: () => {
              expect(context.chatAbortControllers.get(runId)).toBe(entry);
            },
          }),
      );
      if (tracking.kind !== "receipt" || !tracking.completion) {
        throw new Error("Expected a real followup completion receipt");
      }
      const { completion, task } = tracking;
      const original = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
      expect(original?.status).toBe("running");
      const entered = createDeferred();
      const release = createDeferred();
      const store = getTaskRegistryStore();
      const mutate = store.runInitialMutationAsync.bind(store);
      vi.spyOn(store, "runInitialMutationAsync").mockImplementation(async (...args) => {
        if (args[1].type === "tasks.finalizeActive") {
          entered.resolve();
          await release.promise;
        }
        return mutate(...args);
      });
      if (admission === "revoked before cleanup") {
        authority.abort(new Error("Requester revoked before acceptance"));
      }
      const cleanup = settleUnstartedGatewayAgentTask({
        tracking,
        runId,
        admittedRunEntry: entry,
        context,
        outcome: { status: "error", reason: "failed", error: "Rejected before execution" },
      });
      const replacement = { ...entry, controller: new AbortController() };
      try {
        if (admission !== "revoked before cleanup") {
          await Promise.race([
            entered.promise,
            cleanup.then(() => {
              throw new Error("Cleanup did not reach the terminal worker boundary");
            }),
          ]);
          expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)).toEqual(
            original,
          );
          if (admission === "replaced before commit") {
            context.chatAbortControllers.set(runId, replacement);
          }
        }
        release.resolve();
        await cleanup;
        const stored = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId);
        expect(getTaskById(task.taskId)).toEqual(stored);
        if (admission === "replaced before commit") {
          expect(stored).toEqual(original);
          expect(context.chatAbortControllers.get(runId)).toBe(replacement);
          expect(context.logGateway.warn).toHaveBeenCalledWith(
            expect.stringContaining("Follow-up admission was replaced before cleanup"),
          );
        } else {
          expect(stored).toMatchObject({ status: "failed", error: "Rejected before execution" });
          expect(context.logGateway.warn).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        await cleanup;
        completion.close();
      }
    });
  },
);
