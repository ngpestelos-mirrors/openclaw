import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import type { TaskMutationContext } from "./task-executor.types.js";
import {
  prepareTaskFlowRegistryRead,
  type TaskFlowRegistryRead,
} from "./task-flow-runtime-internal.js";
import type { TaskInitialWorkerCommand } from "./task-initial-worker.types.js";
import { captureTaskNotificationTarget } from "./task-notification.operation.js";
import { captureTaskRegistryReadFence } from "./task-registry-listener-state.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import {
  assertTaskRegistryOwnerCurrent,
  prepareTaskRegistryProjectionAsync,
  tasks,
} from "./task-registry-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type { TaskRecord } from "./task-registry.types.js";

type NotificationMutation = Extract<
  TaskInitialWorkerCommand,
  { type: "tasks.acknowledgeStateChange" }
>;
const pendingNotificationMutations = new WeakMap<
  TaskRegistryStore,
  Map<string, Set<Promise<TaskRecord | null>>>
>();

function pendingFor(mutation: TaskMutationContext) {
  return pendingNotificationMutations
    .get(mutation.store)
    ?.get(mutation.context.admission.identity.key);
}

/** Retain the original notification store through transport and mutation settlement. */
export function captureTaskNotificationMutationOwner(
  assertDeliveryCurrent: () => void,
  taskId: string,
) {
  const mutation = captureTaskMutationContext();
  const assertCurrent = () => {
    assertDeliveryCurrent();
    mutation.assertStores();
  };
  const startMutation = (command: NotificationMutation): Promise<TaskRecord | null> => {
    assertCurrent();
    const key = mutation.context.admission.identity.key;
    let byDatabase = pendingNotificationMutations.get(mutation.store);
    if (!byDatabase) {
      byDatabase = new Map();
      pendingNotificationMutations.set(mutation.store, byDatabase);
    }
    let pending = byDatabase.get(key);
    if (!pending) {
      pending = new Set();
      byDatabase.set(key, pending);
    }
    const owned = pending;
    const databases = byDatabase;
    // Register custody before another notification prepares; start storage on the next microtask.
    const operation = Promise.resolve().then(async () => {
      assertCurrent();
      const { settleTaskRecordTransitionAsync } =
        await import("./task-executor-transition.async.js");
      const { receipt } = await settleTaskRecordTransitionAsync(mutation, command, assertCurrent);
      return receipt ? cloneTaskRecord(receipt.task) : null;
    });
    const settlement = operation.finally(() => {
      owned.delete(operation);
      if (owned.size === 0) {
        databases.delete(key);
      }
    });
    owned.add(operation);
    return settlement;
  };
  return {
    async prepare<T>(
      consume: (readFlow: TaskFlowRegistryRead["getTaskFlowById"]) => T,
    ): Promise<T> {
      assertCurrent();
      await captureTaskRegistryReadFence(mutation.context.admission);
      assertCurrent();
      for (;;) {
        const pending = pendingFor(mutation);
        if (pending?.size) {
          await Promise.allSettled(pending);
          assertCurrent();
          continue;
        }
        await prepareTaskRegistryProjectionAsync(mutation.context, mutation.store);
        assertCurrent();
        assertTaskRegistryOwnerCurrent(mutation.context, mutation.store);
        const parentFlowId = tasks.get(taskId)?.parentFlowId;
        const flows = parentFlowId
          ? await prepareTaskFlowRegistryRead(mutation.context)
          : undefined;
        if (parentFlowId) {
          assertCurrent();
          await prepareTaskRegistryProjectionAsync(mutation.context, mutation.store);
          assertCurrent();
        }
        if (
          parentFlowId !== tasks.get(taskId)?.parentFlowId ||
          (parentFlowId && !flows) ||
          pendingFor(mutation)?.size
        ) {
          continue;
        }
        flows?.assertCurrent();
        return consume((flowId) => flows?.getTaskFlowById(flowId));
      }
    },
    bindStateChange: (task: TaskRecord, eventAt: number) => {
      assertCurrent();
      const input = {
        taskId: task.taskId,
        expectedTask: captureTaskNotificationTarget(task),
        eventAt,
      };
      let acknowledgement: Promise<TaskRecord | null> | undefined;
      return (): Promise<TaskRecord | null> => {
        assertCurrent();
        acknowledgement ??= startMutation({ type: "tasks.acknowledgeStateChange", input });
        return acknowledgement;
      };
    },
    markMissingOwner: (task: TaskRecord) =>
      startMutation({
        type: "tasks.acknowledgeStateChange",
        input: {
          taskId: task.taskId,
          expectedTask: captureTaskNotificationTarget(task),
          missingOwner: true,
        },
      }),
  };
}
