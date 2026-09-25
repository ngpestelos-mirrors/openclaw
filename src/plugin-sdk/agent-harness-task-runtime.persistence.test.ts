import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import {
  getTaskActivitySnapshot,
  recordTaskActivityEvent,
} from "../tasks/task-registry-activity.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { getTaskById, cancelTaskById } from "../tasks/task-registry.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "../tasks/task-registry.test-support.js";
import { getTaskRunOwner } from "../tasks/task-run-owner.js";
import {
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskRuntime,
  createAgentHarnessCommandTask,
} from "./agent-harness-task-runtime.js";

it.each([false, true])(
  "keeps live task activity separate from durable content (Incognito: %s)",
  async (incognito) => {
    await withTaskRegistryTempDir(
      async () => {
        const requesterSessionKey = incognito
          ? "agent:main:dashboard:incognito-native"
          : "agent:main:main";
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-harness",
          scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey }),
        });
        const content = "SYNTHETIC_TASK_CONTENT";
        const runId = "example:child";
        const task = runtime.createRunningTaskRun({
          runId,
          task: content,
          label: content,
          progressSummary: content,
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          detail: { nativeTurnId: "turn-1" },
        });
        const expectedTask = captureAgentHarnessTaskAssignment(task);
        const flowId = expectDefined(task.parentFlowId, "native task flow id");
        recordTaskActivityEvent(task, {
          runId,
          seq: 1,
          ts: Date.now(),
          stream: "assistant",
          data: { text: content },
        });
        expect(getTaskActivitySnapshot(task.taskId)?.lastActivity).toBe(content);

        runtime.recordTaskRunProgressByRunId({
          runId,
          expectedTask,
          progressSummary: content,
          eventSummary: content,
        });
        runtime.finalizeTaskRunByRunId({
          runId,
          expectedTask,
          status: "failed",
          endedAt: Date.now(),
          error: content,
          terminalSummary: content,
        });
        const persisted = expectDefined(
          getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId),
          "persisted native task",
        );
        const flow = expectDefined(
          getTaskFlowRegistryStore().loadSnapshot().flows.get(flowId),
          "persisted native task flow",
        );
        expect(persisted).toMatchObject({
          taskId: task.taskId,
          ownerKey: requesterSessionKey,
          requesterSessionKey,
          runId,
          status: "failed",
          detail: { nativeTurnId: "turn-1" },
        });
        expect(JSON.stringify({ persisted, flow }).includes(content)).toBe(!incognito);
        resetTaskRegistryForTests({ persist: false });
        expect(getTaskById(task.taskId)).toEqual(persisted);
        expect(getTaskActivitySnapshot(task.taskId)).toBeUndefined();
      },
      { durableStore: true },
    );
  },
);

it.each([
  "cancelled",
  "succeeded",
  "replacement",
  "same-scope replacement",
  "replacement before stop",
  "revoked",
  "incognito",
] as const)("binds command cancellation to its original task outcome (%s)", async (scenario) => {
  await withTaskRegistryTempDir(
    async () => {
      let current = true;
      let stops = 0;
      let replacement: ReturnType<typeof updateTask> | undefined;
      const ownerKey =
        scenario === "incognito" ? "agent:main:dashboard:incognito-command" : "agent:main:command";
      const command = await createAgentHarnessCommandTask({
        scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
        runId: "native-command:original",
        taskKind: "test-native-command",
        command: "SYNTHETIC_TASK_CONTENT",
        startedAt: Date.now(),
        assertCurrent() {
          if (!current) {
            throw new Error("source retired");
          }
        },
        async cancel(_reason, assertTaskCurrent) {
          stops += 1;
          if (scenario === "replacement") {
            replacement = updateTask(command.task.taskId, {
              runId: "native-command:successor",
              status: "cancelled",
            });
          } else if (scenario === "same-scope replacement") {
            replacement = updateTask(command.task.taskId, { taskKind: "successor-command" });
            assertTaskCurrent();
          } else {
            await command.finish({
              status: scenario === "succeeded" ? "succeeded" : "cancelled",
              endedAt: Date.now(),
            });
          }
        },
      });
      try {
        if (scenario === "revoked") {
          current = false;
        }
        if (scenario === "replacement before stop") {
          replacement = updateTask(command.task.taskId, { taskKind: "successor-command" });
        }
        const result = await cancelTaskById({ cfg: {}, taskId: command.task.taskId });
        expect(result.cancelled).toBe(scenario === "cancelled" || scenario === "incognito");
        expect(stops).toBe(
          scenario === "revoked" || scenario === "replacement before stop" ? 0 : 1,
        );
        if (scenario === "incognito") {
          expect(JSON.stringify(getTaskById(command.task.taskId))).not.toContain(
            "SYNTHETIC_TASK_CONTENT",
          );
        }
        if (scenario === "replacement") {
          expect(replacement).toMatchObject({
            runId: "native-command:successor",
            status: "cancelled",
          });
          await expect(command.finish({ status: "failed", endedAt: Date.now() })).resolves.toBe(
            "retired",
          );
          expect(getTaskById(command.task.taskId)?.runId).toBe("native-command:successor");
        }
        if (scenario === "same-scope replacement" || scenario === "replacement before stop") {
          expect(replacement).toMatchObject({ taskKind: "successor-command", status: "running" });
          const outcome = await command
            .finish({ status: "failed", endedAt: Date.now() })
            .catch(() => "rejected");
          const successor = expectDefined(getTaskById(command.task.taskId), "replacement task");
          expect(successor).toMatchObject({ taskKind: "successor-command", status: "running" });
          expect(outcome).toBe("retired");
          expect(getTaskRunOwner(successor)).toBeUndefined();
        }
      } finally {
        command.release();
      }
    },
    { durableStore: true },
  );
});
