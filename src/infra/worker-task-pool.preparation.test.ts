import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import type { WorkerPoolClass } from "./worker-pool-sizing.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "./worker-task-pool.js";
import { holdExit, type MockWorker } from "./worker-task-pool.owned.test-support.js";

type PostedTask = { input: string; taskId: number };
type FakeWorker = MockWorker<PostedTask>;
const workers = vi.hoisted(() => [] as FakeWorker[]);
const cpu = vi.hoisted(() => ({ count: 2 }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => cpu.count,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  const { createMockWorkerClass } = await import("./worker-task-pool.owned.test-support.js");
  return {
    ...actual,
    Worker: createMockWorkerClass(workers, (worker, message) => {
      queueMicrotask(() =>
        worker.emit("message", { status: "ok", taskId: message.taskId, value: message.input }),
      );
    }),
  };
});
vi.mock("./runtime-worker-url.js", () => ({ resolveRuntimeWorkerThreadExecArgv: () => [] }));

const pools: WorkerTaskPool<string, string>[] = [];
function createPool(
  options: {
    workerUrl?: URL;
    sharedCompute?: boolean;
    maxPendingBytes?: number;
    maxPendingTasks?: number;
  } = {},
) {
  const pool = new WorkerTaskPool<string, string>({
    workerUrl: new URL("file:///fixture/preparation-worker.js"),
    maxWorkers: 1,
    idleTimeoutMs: 0,
    ...options,
  });
  pools.push(pool);
  return pool;
}
beforeEach(() => workers.splice(0));
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  cpu.count = 2;
});

function diagnosticRequests() {
  const events: Extract<DiagnosticEventPayload, { type: "worker.request" }>[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type === "worker.request") {
        events.push(event);
      }
    },
    { include: ["worker.request"] },
  );
  return { events, unsubscribe };
}

class Preparation {
  preparation = createDeferredCore();
  captured = ["retained request"];
  observed?: string[];
  controller = new AbortController();
  consumed;
  active;
  constructor(
    pool: WorkerTaskPool<string, string>,
    options: { rejects?: boolean; onConsumed?: () => void; onExecutionSettled?: () => void } = {},
  ) {
    this.consumed = vi.fn(() => {
      options.onConsumed?.();
      this.captured.length = 0;
    });
    this.active = pool.run(
      async () => {
        await this.preparation.promise;
        this.observed = [...this.captured];
        if (options.rejects) {
          throw new Error("late preparation failure");
        }
        return this.captured.join(",");
      },
      {
        signal: this.controller.signal,
        inputBytes: 8,
        onInputConsumed: this.consumed,
        onExecutionSettled: options.onExecutionSettled,
      },
    );
  }
}

function contend() {
  const contender = vi.fn(() => "next pool");
  return { contender, next: createPool({ sharedCompute: true }).run(contender, {}) };
}

function expectRetained(
  fixture: Preparation,
  pool: WorkerTaskPool<string, string>,
  contender: ReturnType<typeof vi.fn>,
) {
  expect(fixture.captured).toEqual(["retained request"]);
  expect(fixture.consumed).not.toHaveBeenCalled();
  expect(contender).not.toHaveBeenCalled();
  expect(pool.getSnapshot().pendingTasks).toBe(1);
}

it.each<{
  cpus: number;
  workerClass: WorkerPoolClass;
  admitted: number;
  owned?: boolean;
  maxWorkers?: number;
}>([
  { cpus: 1, workerClass: "reader", admitted: 1 },
  { cpus: 2, workerClass: "reader", admitted: 1 },
  { cpus: 8, workerClass: "reader", admitted: 2 },
  { cpus: 128, workerClass: "reader", admitted: 2 },
  { cpus: 128, workerClass: "file-reader", admitted: 2 },
  { cpus: 128, workerClass: "compute", admitted: 4 },
  { cpus: 128, workerClass: "writer", admitted: 1 },
  { cpus: 128, workerClass: "singleton", admitted: 1 },
  { cpus: 128, workerClass: "reader", admitted: 2, owned: true },
  { cpus: 128, workerClass: "reader", admitted: 2, maxWorkers: 1 },
])("bounds $workerClass admission on $cpus CPUs (owned=$owned)", async (testCase) => {
  cpu.count = testCase.cpus;
  const options = {
    workerUrl: new URL("file:///fixture/preparation-worker.js"),
    workerClass: testCase.workerClass,
    maxWorkers: testCase.maxWorkers,
  };
  const pool = testCase.owned
    ? createOwnedWorkerTaskPool<string, string>(options)
    : new WorkerTaskPool<string, string>(options);
  const gate = createDeferredCore();
  const admitted: number[] = [];
  const results = Array.from({ length: 12 }, (_, index) =>
    pool.run(() => {
      admitted.push(index);
      return gate.promise.then(() => String(index));
    }, {}),
  );
  try {
    expect(admitted).toEqual(Array.from({ length: testCase.admitted }, (_, index) => index));
    expect(pool.getSnapshot().maxWorkers).toBe(testCase.admitted);
    gate.resolve();
    await expect(Promise.all(results)).resolves.toEqual(
      Array.from({ length: 12 }, (_, index) => String(index)),
    );
    expect(admitted).toEqual(Array.from({ length: 12 }, (_, index) => index));
    if (
      testCase.workerClass === "reader" ||
      testCase.workerClass === "file-reader" ||
      testCase.workerClass === "compute"
    ) {
      expect(
        workers.map((worker) => worker.options?.resourceLimits?.maxOldGenerationSizeMb),
      ).toEqual(Array(testCase.admitted).fill(512));
    }
  } finally {
    gate.resolve();
    await Promise.all([Promise.allSettled(results), pool.close()]);
  }
});

describe("public worker task preparation custody", () => {
  it.each([undefined, "reader"] as const)(
    "retains lazy inherited options (class=%s)",
    async (selectedClass) => {
      const releaseResources = vi.fn(async () => {});
      const readOptions = vi.fn();
      class Limits {
        get stackSizeMb() {
          return 8;
        }
      }
      class PoolOptions {
        #release = releaseResources;
        workerUrl = new URL("file:///fixture/preparation-worker.js");
        maxWorkers = 1;
        constructor(readonly workerClass: WorkerPoolClass | undefined) {}
        get workerOptions() {
          readOptions();
          return { resourceLimits: new Limits() };
        }
        prepareWorker() {
          return { options: {}, releaseResources: this.#release };
        }
      }
      const pool = new WorkerTaskPool<string, string>(new PoolOptions(selectedClass));
      pools.push(pool);
      expect(readOptions).not.toHaveBeenCalled();
      await expect(pool.run("prepared", {})).resolves.toBe("prepared");
      expect(readOptions).toHaveBeenCalledOnce();
      expect(workers[0]?.options?.resourceLimits?.stackSizeMb).toBe(8);
      expect(workers[0]?.options?.resourceLimits?.maxOldGenerationSizeMb).toBe(
        selectedClass ? 512 : undefined,
      );
      expect(releaseResources).not.toHaveBeenCalled();
      await pool.close();
      expect(releaseResources).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])("attributes private worker requests (owned=%s)", async (owned) => {
    const { events, unsubscribe } = diagnosticRequests();
    const pool = owned
      ? createOwnedWorkerTaskPool<string, string>({
          workerUrl: new URL("file:///fixture/openclaw-state-read.worker.js"),
          maxWorkers: 1,
          idleTimeoutMs: 0,
        })
      : createPool({
          workerUrl: new URL("file:///synthetic-private-root/synthetic-private-worker.js"),
        });
    const gate = createDeferredCore<string>();
    try {
      const task =
        "runTask" in pool
          ? pool.runTask(() => gate.promise, {
              diagnosticOperation: "cron.synthetic-private-suffix",
            })
          : undefined;
      const result = task?.result ?? pool.run("synthetic-private-input", {});
      if (owned) {
        await waitForDiagnosticEventsDrained();
        expect(events[0]).toMatchObject({ phase: "queued", requestClass: "cron" });
      }
      gate.resolve("synthetic-private-input");
      await expect(result).resolves.toBe("synthetic-private-input");
      await task?.close();
      await waitForDiagnosticEventsDrained();
      expect(events.map((event) => (owned ? event.requestClass : event.kind))).toEqual(
        Array(3).fill(owned ? "cron" : "extension"),
      );
      expect(events.map((event) => event.phase)).toEqual(["queued", "started", "completed"]);
      expect(JSON.stringify(events)).not.toContain("synthetic-private");
    } finally {
      gate.resolve("cleanup");
      await pool.close();
      await waitForDiagnosticEventsDrained();
      unsubscribe();
    }
  });

  it("releases a rejected factory before its caller catches and immediately retries", async () => {
    const pool = createPool({ maxPendingTasks: 1 });
    await pool.run("warm", {});
    const worker = workers[0]!;
    const reason = new Error("factory rejected before dispatch");
    const consumed = vi.fn();
    const retried = pool
      .run(
        async () => {
          throw reason;
        },
        { onInputConsumed: consumed },
      )
      .catch((error: unknown) => {
        expect(error).toBe(reason);
        expect(consumed).toHaveBeenCalledOnce();
        expect(pool.getSnapshot().pendingTasks).toBe(0);
        return pool.run("immediate retry", {});
      });
    await expect(retried).resolves.toBe("immediate retry");
    expect(workers).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.posted.mock.calls.map(([message]) => message.input)).toEqual([
      "warm",
      "immediate retry",
    ]);
  });

  it.each(["preparation-first", "exit-first"] as const)(
    "retains preparation custody until native exit (%s)",
    async (order) => {
      const pool = createPool({ sharedCompute: true, maxPendingBytes: 8 });
      await expect(pool.run("warm", {})).resolves.toBe("warm");
      const worker = workers[0]!;
      const native = holdExit(worker);
      const context = new AsyncLocalStorage<string>();
      const assertContext = () => expect(context.getStore()).toBe("input owner");
      const executionSettled = vi.fn(assertContext);
      const reason = new Error("preparation canceled");
      const fixture = context.run(
        "input owner",
        () =>
          new Preparation(pool, {
            rejects: order === "exit-first",
            onConsumed: assertContext,
            onExecutionSettled: executionSettled,
          }),
      );
      const { preparation, captured, controller, consumed, active } = fixture;
      const rejected = expect(active).rejects.toBe(reason);
      const { contender, next } = contend();
      const rotation = pool.rotate();
      controller.abort(reason);
      try {
        await native.entered;
        expect(captured).toEqual(["retained request"]);
        expect(pool.getSnapshot().pendingTasks).toBe(1);
        await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
          code: "overloaded",
        });
        if (order === "exit-first") {
          native.release();
          await rejected;
          expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
          await rotation;
        } else {
          preparation.resolve();
          await nextTurn();
          expect(fixture.observed).toEqual(["retained request"]);
          expect(executionSettled).not.toHaveBeenCalled();
        }
        expectRetained(fixture, pool, contender);
        const closed = vi.fn();
        const closing = pool.close().then(closed);
        await nextTurn();
        expect(closed).not.toHaveBeenCalled();
        preparation.resolve();
        native.release();
        await Promise.all([closing, rotation, rejected]);
        await expect(next).resolves.toBe("next pool");
        expect(fixture.observed).toEqual(["retained request"]);
        expect(captured).toEqual([]);
        expect(consumed).toHaveBeenCalledOnce();
        expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
        await expect(active).rejects.toBe(reason);
        expect(worker.posted.mock.calls.map(([message]) => message.input)).toEqual(["warm"]);
        expect(pool.getSnapshot().pendingTasks).toBe(0);
      } finally {
        preparation.resolve();
        native.release();
        await rejected;
        await Promise.allSettled([active, next, rotation, pool.close()]);
      }
    },
  );

  it("retains preparation custody across failed mocked stops until the same worker exits", async () => {
    const pool = createPool({ sharedCompute: true, maxPendingBytes: 8 });
    await pool.run("warm", {});
    const worker = workers[0]!;
    const firstFailure = new Error("automatic stop failed");
    const retryFailure = new Error("explicit stop failed");
    worker.terminate.mockRejectedValueOnce(firstFailure).mockRejectedValueOnce(retryFailure);
    const reason = new Error("canceled during preparation");
    const fixture = new Preparation(pool);
    const { preparation, captured, consumed, controller, active } = fixture;
    const outcome = active.catch((error: unknown) => error);
    const { contender, next } = contend();
    controller.abort(reason);
    try {
      const originalFailure = await outcome;
      expect(originalFailure).toMatchObject({
        cause: firstFailure,
        errors: [reason, firstFailure],
      });
      await expect(pool.close()).rejects.toBe(retryFailure);
      preparation.resolve();
      await nextTurn();
      expect(fixture.observed).toEqual(["retained request"]);
      expectRetained(fixture, pool, contender);
      expect(workers).toHaveLength(1);
      await pool.close();
      await expect(next).resolves.toBe("next pool");
      expect(worker.terminate).toHaveBeenCalledTimes(3);
      expect(consumed).toHaveBeenCalledOnce();
      expect(captured).toEqual([]);
      expect(pool.getSnapshot().pendingTasks).toBe(0);
      expect(worker.posted.mock.calls.map(([message]) => message.input)).toEqual(["warm"]);
      expect(await outcome).toBe(originalFailure);
    } finally {
      preparation.resolve();
      await Promise.allSettled([active, pool.close(), next]);
    }
  });

  it.each([
    { ending: "close", failure: "settlement" },
    { ending: "abort", failure: "both" },
  ])(
    "reports $failure cleanup failure through close after $ending rejects the result",
    async ({ ending, failure }) => {
      const pool = createPool({ maxPendingBytes: 8 });
      const completed = createDeferredCore();
      const reason = new Error("original preparation cancellation");
      const cleanupError = new Error("input cleanup failed");
      const settlementError = new Error("execution receipt failed");
      const onConsumed = () => {
        completed.resolve();
        if (failure !== "settlement") {
          throw cleanupError;
        }
      };
      const executionSettled = vi.fn(() => {
        throw settlementError;
      });
      const { preparation, controller, consumed, active } = new Preparation(pool, {
        onConsumed,
        onExecutionSettled: executionSettled,
      });
      const rejected = expect(active).rejects.toBe(reason);
      const closing = ending === "close" ? pool.close(reason) : undefined;
      const closeOutcome = closing?.then(
        () => undefined,
        (error: unknown) => error,
      );
      if (ending === "abort") {
        controller.abort(reason);
      }
      try {
        await rejected;
        expect(executionSettled).toHaveBeenCalledExactlyOnceWith({ retired: true });
        expect(consumed).not.toHaveBeenCalled();
        preparation.resolve();
        await completed.promise;
        await nextTurn();
        let closeFailure: unknown;
        if (!closing) {
          expect(pool.getSnapshot().pendingTasks).toBe(1);
          await expect(pool.run("over capacity", { inputBytes: 1 })).rejects.toMatchObject({
            code: "overloaded",
          });
          closeFailure = await pool.close().catch((error: unknown) => error);
        } else {
          closeFailure = await closeOutcome;
        }
        if (failure === "both") {
          expect(closeFailure).toBeInstanceOf(AggregateError);
          expect(closeFailure).toMatchObject({
            errors: [settlementError, cleanupError],
            cause: settlementError,
          });
        } else {
          expect(closeFailure).toBe(settlementError);
        }
        await pool.close();
        expect(consumed).toHaveBeenCalledOnce();
        expect(executionSettled).toHaveBeenCalledOnce();
        expect(pool.getSnapshot().pendingTasks).toBe(0);
        expect(workers).toHaveLength(0);
        await expect(active).rejects.toBe(reason);
      } finally {
        preparation.resolve();
        await Promise.allSettled([active, closing, pool.close()]);
      }
    },
  );
});
