import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isMainThread, Worker } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  captureRuntimeWorkerSource,
  withRuntimeWorkerGeneration,
} from "./runtime-worker-generation.js";
import { getTrackedWorkerLifecycleSnapshot } from "./worker-cpu.js";
import {
  captureRetainedNativeWorkerSource,
  createRetainedNativeWorker,
  type RetainedNativeWorkerSource,
} from "./worker-native-lifecycle.js";
import {
  assertNativeWorkerDiagnosticMatches,
  assertNativeWorkerFields,
  runNativeResourceLifecycle,
} from "./worker-native-lifecycle.runtime.test-support.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

const sqliteChild = `
  const { DatabaseSync } = require("node:sqlite");
  const { parentPort, workerData } = require("node:worker_threads");
  const db = new DatabaseSync(workerData.databasePath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value); INSERT INTO proof VALUES(1)");
  db.exec("BEGIN IMMEDIATE; INSERT INTO proof VALUES(2)");
  const statement = db.prepare("SELECT value FROM proof");
  const iterator = statement.iterate();
  iterator.next();
  globalThis.retainedSqlite = { db, statement, iterator };
  parentPort.on("message", (input) => {
    const result = db.prepare("SELECT ? * 2 AS value").get(input);
    parentPort.postMessage({ value: result.value });
  });
`;

const workerSource = `
  const { parentPort, workerData, Worker } = require("node:worker_threads");
  const child = new Worker(workerData.childSource, {
    eval: true,
    execArgv: [],
    workerData: { databasePath: workerData.databasePath },
  });
  child.on("message", (value) => parentPort.postMessage(value));
  child.on("error", (error) => { throw error; });
  parentPort.on("message", (message) => {
    if (message === "finish") process.exit(17);
    child.postMessage(message);
  });
`;

const echoWorkerSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", (value) => parentPort.postMessage(value + 1));
`;

function fixtureWorker(source?: RetainedNativeWorkerSource, databasePath?: string) {
  const workerData = databasePath ? { childSource: sqliteChild, databasePath } : undefined;
  return createRetainedNativeWorker(
    databasePath ? workerSource : echoWorkerSource,
    { eval: true, execArgv: [], workerData },
    source,
  );
}

function requestWorker(worker: RetainedNativeWorker) {
  let reply = createDeferredCore<unknown>();
  worker.on("message", (value) => reply.resolve(value));
  worker.on("error", (error) => reply.reject(error));
  worker.on("messageerror", (error) => reply.reject(error));
  return (input: unknown) => {
    reply = createDeferredCore<unknown>();
    worker.postMessage(input, []);
    return reply.promise;
  };
}

function assertWorkerCount(count: number) {
  assert.equal(getTrackedWorkerLifecycleSnapshot().workerCount, count);
}

async function joinWorker(worker: RetainedNativeWorker, count: number) {
  const stopped = worker.stop();
  await stopped.result;
  assert.deepEqual(stopped.read(), { status: "fulfilled", value: undefined });
  assert.equal(worker.threadId, -1);
  assertWorkerCount(count);
}

function assertSqliteReleased(database: DatabaseSync) {
  database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM proof").get()?.count, 1);
  database.exec("ROLLBACK");
}

function report(ending: string, result: object) {
  console.log(JSON.stringify({ ending, ...result }));
}

function observe(worker: Worker | RetainedNativeWorker, context?: AsyncLocalStorage<string>) {
  const messages: unknown[] = [],
    errors: Error[] = [],
    exits: (number | undefined)[] = [];
  const seen: { event: string; context: string | undefined }[] = [];
  const record =
    <T>(event: string, values: T[]) =>
    (value: T) => {
      seen.push({ event, context: context?.getStore() });
      values.push(value);
    };
  worker.on("message", record("message", messages));
  worker.on("error", (error) => {
    assert.ok(error instanceof Error);
    record("error", errors)(error);
  });
  worker.once("exit", record("exit", exits));
  return { messages, errors, exits, seen };
}

function serviceNativeUntil(
  label: string,
  service: () => void,
  done: () => boolean,
  deadline = performance.now() + 10_000,
) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: ${label}\n`);
  for (;;) {
    service();
    if (done()) {
      return;
    }
    assert.ok(performance.now() < deadline, `Deadline waiting for ${label}`);
    Atomics.wait(pause, 0, 0, 1);
  }
}

async function runCallbackContext() {
  const context = new AsyncLocalStorage<string>();
  const source = `
    const { parentPort } = require("node:worker_threads");
    parentPort.on("message", (value) => {
      if (value === "fail") {
        const diagnostic = (error, fields) => Object.assign(error, fields, {
          stack: error.name + ": " + error.message + "\\n    at native callback fixture",
        });
        const shared = diagnostic(new Error("shared member"));
        const leaf = diagnostic(new RangeError("deep cause"), { code: "E_LEAF" });
        const middle = diagnostic(new TypeError("middle cause", { cause: leaf }), { code: "E_MIDDLE" });
        const failure = Object.assign(
          new AggregateError([shared, shared], "synthetic callback context error", { cause: middle }),
          { code: "E_ROOT", errcode: 73, errno: -5 },
        );
        failure.stack = "AggregateError: synthetic callback context error\\n    at native callback fixture";
        throw failure;
      }
      parentPort.postMessage(value + 1, []);
    });
  `;
  const expected = ["message", "error", "exit"].map((event) => ({
    event,
    context: "constructor-A",
  }));
  async function callbacks(worker: Worker | RetainedNativeWorker) {
    const awaiters =
      worker instanceof Worker
        ? {
            message: createDeferredCore<unknown>(),
            exit: createDeferredCore<number | undefined>(),
          }
        : undefined;
    if (awaiters) {
      worker.on("message", awaiters.message.resolve);
      worker.on("error", awaiters.message.reject);
      worker.once("exit", awaiters.exit.resolve);
    }
    const events = context.run("service-B", () => observe(worker, context));
    try {
      await context.run("service-B", async () => {
        worker.postMessage(41, []);
        if (worker instanceof Worker) {
          assert.ok(awaiters);
          assert.equal(await awaiters.message.promise, 42);
        } else {
          serviceNativeUntil(
            "callback message",
            () => worker.service(),
            () => events.messages.length > 0 || events.errors.length > 0,
          );
        }
        assert.deepEqual(events.messages, [42]);
        assert.deepEqual(events.errors, []);
        worker.postMessage("fail", []);
        if (worker instanceof Worker) {
          assert.ok(awaiters);
          assert.equal(await awaiters.exit.promise, 1);
        } else {
          serviceNativeUntil(
            "callback exit",
            () => worker.service(),
            () => events.exits.length > 0,
          );
          assert.equal(worker.threadId, -1);
          assert.deepEqual(worker.stop().read(), { status: "fulfilled", value: undefined });
        }
        assert.deepEqual(events.exits, [1]);
        assert.deepEqual(events.seen, expected);
        assert.equal(events.errors.length, 1);
      });
    } finally {
      await worker.terminate();
    }
    assert.equal(worker.threadId, -1);
    return events;
  }
  const options = { eval: true, execArgv: [] };
  const direct = await callbacks(context.run("constructor-A", () => new Worker(source, options)));
  const directError = direct.errors[0];
  assert.ok(directError);
  assertNativeWorkerFields(directError, {
    message: "synthetic callback context error",
    code: "E_ROOT",
  });
  // Bun already omits these fields at its first native hop; both paths must preserve what arrives.
  if (!process.versions.bun) {
    assertNativeWorkerFields(directError, { errcode: 73, errno: -5 });
    const middle = directError.cause;
    assert.ok(middle instanceof Error);
    assert.equal(Reflect.get(middle, "code"), "E_MIDDLE");
    const leaf = middle.cause;
    assert.ok(leaf instanceof Error);
    assertNativeWorkerFields(leaf, { message: "deep cause", code: "E_LEAF" });
    const members: unknown = Reflect.get(directError, "errors");
    assert.ok(Array.isArray(members));
    assert.equal(members.length, 2);
    assert.equal(members[0], members[1]);
  }

  const retained = await callbacks(
    context.run("constructor-A", () => createRetainedNativeWorker(source, options)),
  );
  assert.match(String(retained.errors[0]), /synthetic callback context error/);
  assertNativeWorkerDiagnosticMatches(retained.errors[0], directError);
  report("callback-context", {
    directSeen: direct.seen,
    retainedSeen: retained.seen,
    diagnosticsPreserved: true,
    joined: true,
  });
}

async function runBlockedLifecycle(ending: "terminate" | "natural-exit", databasePath: string) {
  const worker = fixtureWorker(undefined, databasePath);
  const { messages, errors, exits } = observe(worker);
  worker.on("messageerror", (error) => errors.push(error));
  const deadline = performance.now() + 10_000;

  function serviceUntil(
    label: string,
    done: () => boolean,
    port: Pick<RetainedNativeWorker, "service"> = worker,
  ): void {
    // Service only the named producer; preserve the shared blocked-lifecycle deadline.
    serviceNativeUntil(
      label,
      () => port.service(),
      () => {
        if (errors[0]) {
          throw errors[0];
        }
        return done();
      },
      deadline,
    );
  }

  let observer: DatabaseSync | undefined;
  try {
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    worker.postMessage(21, []);
    serviceUntil("nested SQLite result", () => messages.length > 0);
    assert.deepEqual(messages, [{ value: 42 }]);
    assert.equal(worker.started, true);
    assert.ok(worker.threadId > 0);
    assert.equal(exits.length, 0);

    const database = new DatabaseSync(databasePath);
    observer = database;
    database.exec("PRAGMA busy_timeout=0");
    assert.throws(() => database.exec("BEGIN IMMEDIATE"), /locked|busy/i);

    if (ending === "natural-exit") {
      worker.postMessage("finish", []);
      serviceUntil("natural native exit", () => exits.length > 0);
      assert.deepEqual(exits, [17]);
    }
    const stopped = worker.stop();
    let promiseCallbackRanWhileBlocked = false;
    void stopped.result.then(() => {
      promiseCallbackRanWhileBlocked = true;
    });
    if (ending === "terminate") {
      assert.equal(stopped.read().status, "pending");
    }
    serviceUntil("retained native join", () => stopped.read().status !== "pending", stopped);
    assert.deepEqual(stopped.read(), { status: "fulfilled", value: undefined });
    assert.equal(worker.threadId, -1);
    assert.equal(exits.length, 1);
    assert.equal(microtaskRan, false);
    assert.equal(promiseCallbackRanWhileBlocked, false);

    assertSqliteReleased(database);
    report(ending, {
      value: 42,
      nativeJoined: true,
      nestedSqliteReleased: true,
      promiseCallbackRanWhileBlocked,
    });
  } finally {
    observer?.close();
    await worker.terminate();
  }
}

async function runGenerationLifecycle(directory: string, databasePath: string) {
  // Source-loader startup can register its worker after the entry module begins.
  await nextTurn();
  const initialWorkers = getTrackedWorkerLifecycleSnapshot().workerCount;
  const order: string[] = [];
  const marker = new URL("./native-generation-marker.js", import.meta.url);
  const retainedMarker = new URL("./retained-native-generation-marker.js", import.meta.url);
  let nativeJoined = false;
  let siblingJoined = false;
  let terminalSamplesRejected = false;
  let directoryReleased = false;
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: generation close ordering\n`);
  await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => (url.href === marker.href ? retainedMarker : url));
      const binding = captureRuntimeWorkerSource(marker);
      assert.equal(binding.moduleUrl.href, retainedMarker.href);
      const generation = binding.runtimeGeneration;
      assert.ok(generation);
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: generation });
      assertWorkerCount(initialWorkers);
      const queuedOwner = { source };
      const siblingOwner = { source };
      const firstOwnerFinished = createDeferredCore();
      // Domain owners share the captured source through the existing generation contract.
      source.retain(queuedOwner, async () => {
        try {
          order.push("owner-close-start");
          await nextTurn();
          assertWorkerCount(initialWorkers);
          const worker = fixtureWorker(queuedOwner.source, databasePath);
          const request = requestWorker(worker);
          assert.deepEqual(await request(21), { value: 42 });
          assert.ok(worker.threadId > 0);
          assertWorkerCount(initialWorkers + 2);
          order.push("queued-worker-started");
          assert.deepEqual(await request(9), { value: 18 });
          order.push("worker-usable-during-close");
          await joinWorker(worker, initialWorkers + 1);
          nativeJoined = true;
          order.push("native-joined");
          await assert.rejects(worker.cpuUsage());
          await assert.rejects(worker.getHeapStatistics());
          terminalSamplesRejected = true;
          const database = new DatabaseSync(databasePath);
          try {
            assertSqliteReleased(database);
          } finally {
            database.close();
          }
        } finally {
          firstOwnerFinished.resolve();
        }
      });
      source.retain(siblingOwner, async () => {
        await firstOwnerFinished.promise;
        await nextTurn();
        assert.equal(nativeJoined, true);
        assertWorkerCount(initialWorkers + 1);
        order.push("sibling-owner-close");
        const sibling = fixtureWorker(siblingOwner.source);
        assert.equal(await requestWorker(sibling)(41), 42);
        assertWorkerCount(initialWorkers + 2);
        await joinWorker(sibling, initialWorkers + 1);
        siblingJoined = true;
        order.push("sibling-native-joined");
      });
      order.push("operation");
    },
    async () => {
      assert.equal(nativeJoined, true);
      assert.equal(siblingJoined, true);
      assert.equal(terminalSamplesRejected, true);
      assertWorkerCount(initialWorkers);
      assert.equal(existsSync(databasePath), true);
      order.push("release");
      rmSync(directory, { recursive: true, force: true });
      directoryReleased = true;
    },
  );
  assert.equal(existsSync(directory), false);
  report("generation", {
    order,
    nativeJoined,
    siblingJoined,
    supervisorJoined: true,
    directoryReleased,
    terminalSamplesRejected,
  });
}

async function runExplicitUnboundLifecycle() {
  await nextTurn();
  const initialWorkers = getTrackedWorkerLifecycleSnapshot().workerCount;
  let ambientReleased = false;
  const source = await withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => {
        const mapped = new URL(url);
        mapped.searchParams.set("native-lifecycle-test-generation", "ambient");
        return mapped;
      });
      const marker = new URL("./native-generation-marker.js", import.meta.url);
      assert.notEqual(captureRuntimeWorkerSource(marker).moduleUrl.href, marker.href);
      const unbound = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      assertWorkerCount(initialWorkers);
      return unbound;
    },
    async () => {
      ambientReleased = true;
      assertWorkerCount(initialWorkers);
    },
  );
  assert.equal(ambientReleased, true);
  process.stderr.write(`native lifecycle fixture pid=${process.pid}: explicit unbound source\n`);
  const worker = fixtureWorker(source);
  try {
    assert.equal(await requestWorker(worker)(41), 42);
    assertWorkerCount(initialWorkers + 2);
  } finally {
    await worker.terminate();
  }
  assert.equal(worker.threadId, -1);
  assertWorkerCount(initialWorkers + 1);
  const idleSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  assert.equal(idleSource, source);
  let ownerClosed = false;
  source.retain({}, async () => {
    // Already admitted owners may finish queued work while shutdown drains them.
    const queued = fixtureWorker(idleSource);
    assert.equal(await requestWorker(queued)(41), 42);
    await queued.terminate();
    assertWorkerCount(initialWorkers + 1);
    ownerClosed = true;
  });
  await drainGlobalSingletonLifecycleState();
  assert.equal(ownerClosed, true);
  assertWorkerCount(initialWorkers);
  assert.throws(() => source.create(echoWorkerSource, { eval: true }), /closing/);
  const renewed = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  assert.notEqual(renewed, source);
  await drainGlobalSingletonLifecycleState();
  report("explicit-unbound", {
    ambientReleased,
    value: 42,
    nativeJoined: true,
    idleReused: true,
    shutdownJoined: true,
  });
}

assert.equal(isMainThread, true, "the fixture must block the process main thread");
const ending = process.argv[2];
const directory = process.argv[3];
assert.ok(directory);
const databasePath = path.join(directory, "nested.sqlite");
const scenarios: Record<string, () => Promise<void>> = {
  terminate: () => runBlockedLifecycle("terminate", databasePath),
  "natural-exit": () => runBlockedLifecycle("natural-exit", databasePath),
  generation: () => runGenerationLifecycle(directory, databasePath),
  "explicit-unbound": runExplicitUnboundLifecycle,
  "native-resource": () => runNativeResourceLifecycle(directory, serviceNativeUntil),
  "resource-idle-broker": () =>
    runNativeResourceLifecycle(directory, serviceNativeUntil, "idle-broker"),
  "resource-late-attachment": () =>
    runNativeResourceLifecycle(directory, serviceNativeUntil, "late-attachment"),
  "callback-context": runCallbackContext,
};
assert.ok(ending && Object.hasOwn(scenarios, ending));
const run = scenarios[ending];
assert.ok(run);
await run();
