import { setImmediate } from "node:timers/promises";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import "./subagent-registry.mocks.shared.js";
import "./subagent-registry.persistence.mocks.test-support.js";
// Preserve fixture setup before importing the registry's owners.
// oxfmt-ignore
import { useSubagentPersistenceFixture } from "./subagent-registry.persistence-fixture.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { callGateway } from "../../../gateway/call.js";
import * as workerAdmission from "../../../infra/sqlite-worker-broker-admission.js";
import type { Job } from "../../../infra/sqlite-worker-broker.types.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { holdStateDatabaseCoordinator } from "../../../test-utils/state-database-contention.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDiskAsyncOrThrow } from "./subagent-registry-state.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";

const fixture = useSubagentPersistenceFixture();

it("keeps ordinary subagent registration responsive while coordinator custody is held", async () => {
  await fixture.allocateStateDir();
  vi.mocked(callGateway).mockResolvedValue({ status: "pending" });
  openOpenClawStateDatabase();
  const context = captureOpenClawStateWorkerContext();
  expect(context.admission.databasePath.startsWith(fixture.stateDir)).toBe(true);
  // Settle worker startup before holding the coordinator used by this registration.
  await persistSubagentRunsToDiskAsyncOrThrow(new Map(), [], { context });
  const runId = "contended-registration";
  const childSessionKey = "agent:main:subagent:contended-registration";
  const contended = createDeferred();
  const checks = new WeakMap<Job, number>();
  let observedContention = false;
  const borrowLifecycle = workerAdmission.borrowSqliteWorkerLifecycle;
  const observeContention = vi
    .spyOn(workerAdmission, "borrowSqliteWorkerLifecycle")
    .mockImplementation((job, actor) => {
      const delegate = borrowLifecycle(job, actor);
      if (
        !delegate &&
        job.lifecyclePreparation &&
        job.request.type === "execute" &&
        (job.request.stateDatabasePath ?? actor.databasePath) === context.admission.databasePath
      ) {
        const command: unknown = deserialize(job.request.input);
        if (
          isRecord(command) &&
          command.type === "subagents.persistChanges" &&
          isRecord(command.input) &&
          Array.isArray(command.input.values) &&
          command.input.values.some((row: unknown) => isRecord(row) && row.run_id === runId)
        ) {
          const count = (checks.get(job) ?? 0) + 1;
          checks.set(job, count);
          // The second check follows a failed native coordinator acquisition.
          if (count === 2) {
            observedContention = true;
            contended.resolve();
          }
        }
      }
      return delegate;
    });
  // Release a regressed synchronous waiter independently of the blocked test thread.
  const holder = holdStateDatabaseCoordinator(
    context.admission.databasePath,
    context.coordinatorRuntime,
    1_000,
  );
  let registration: Promise<void> | undefined;
  let registrationSettled = false;
  const failures: unknown[] = [];
  try {
    await holder.ready;
    registration = Promise.resolve(
      registerSubagentRun({
        runId,
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "Register while a foreign coordinator owner holds custody",
        cleanup: "keep",
        expectsCompletionMessage: false,
        taskRowOwnership: "gateway_best_effort",
      }),
    );
    const settlement = registration.finally(() => {
      registrationSettled = true;
    });
    await Promise.race([contended.promise, settlement, holder.joined]);
    await setImmediate();
    await setImmediate();
    expect(
      Atomics.load(holder.released, 0),
      "registration must let the event loop run before the coordinator holder releases",
    ).toBe(0);
    expect(observedContention).toBe(true);
    expect(registrationSettled).toBe(false);
    expect(subagentRuns.has(runId)).toBe(false);
  } catch (error) {
    failures.push(error);
  } finally {
    holder.release();
    for (const result of await Promise.allSettled([registration, holder.joined])) {
      if (result.status === "rejected" && !failures.includes(result.reason)) {
        failures.push(result.reason);
      }
    }
    observeContention.mockRestore();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Registration responsiveness or worker settlement failed");
  }
  const durable = loadSubagentRegistryFromSqlite().get(runId);
  expect(durable).toMatchObject({ runId, childSessionKey, execution: { status: "running" } });
  expect(subagentRuns.get(runId)).toEqual(durable);
  await fixture.settle();
});
