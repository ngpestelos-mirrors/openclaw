import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import {
  getTaskActivitySnapshot,
  recordTaskActivityEvent,
} from "../tasks/task-registry-activity.js";
import { getTaskById } from "../tasks/task-registry.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "../tasks/task-registry.test-support.js";
import { createAgentHarnessTaskRuntime } from "./agent-harness-task-runtime.js";

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
        const flowId = expectDefined(task.parentFlowId, "native task flow id");
        const snapshots: unknown[] = [];
        const capture = () =>
          snapshots.push({
            task: getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId),
            flow: getTaskFlowRegistryStore().loadSnapshot().flows.get(flowId),
          });
        capture();
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
          progressSummary: content,
          eventSummary: content,
        });
        capture();
        runtime.finalizeTaskRunByRunId({
          runId,
          status: "failed",
          endedAt: Date.now(),
          error: content,
          terminalSummary: content,
        });
        capture();
        runtime.setDetachedTaskDeliveryStatusByRunId({
          runId,
          deliveryStatus: "pending",
          error: content,
        });
        capture();
        expect(snapshots.map((snapshot) => JSON.stringify(snapshot).includes(content))).toEqual(
          Array(4).fill(!incognito),
        );
        const killed = runtime.createRunningTaskRun({
          runId: "example:killed",
          task: content,
          notifyPolicy: "silent",
        });
        runtime.finalizeTaskRunByRunId({
          runId: "example:killed",
          status: "cancelled",
          endedAt: Date.now(),
          error: SUBAGENT_KILL_TASK_ERROR,
        });
        expect(getTaskRegistryStore().loadSnapshot().tasks.get(killed.taskId)).toMatchObject({
          status: "cancelled",
          error: SUBAGENT_KILL_TASK_ERROR,
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
