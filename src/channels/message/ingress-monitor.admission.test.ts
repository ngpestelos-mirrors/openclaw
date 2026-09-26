import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../../test-utils/state-database-contention.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("channel ingress monitor admission", () => {
  it("keeps delayed inspection in FIFO admission and joins it on stop", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-inspection-"),
    });
    const inspection = createDeferred();
    const entered = createDeferred();
    const inspections: string[] = [];
    const admissions: string[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: () => {
        throw new Error("legacy inspection unexpectedly used");
      },
      inspectAsync: async (raw) => {
        inspections.push(raw.id);
        if (raw.id === "first") {
          entered.resolve();
          await inspection.promise;
        }
        return { eventId: raw.id, laneKey: "lane:a" };
      },
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      onDurableAdmission: (raw) => {
        admissions.push(raw.id);
      },
    });
    const first = monitor.admit({ id: "first", text: "one" });
    const second = monitor.admit({ id: "second", text: "two" });
    await entered.promise;
    let stopped = false;
    const stopping = monitor.stop().then(() => {
      stopped = true;
    });
    try {
      await Promise.resolve();
      expect(inspections).toEqual(["first"]);
      expect(admissions).toEqual([]);
      expect(stopped).toBe(false);
    } finally {
      inspection.resolve();
      await Promise.all([first, second, stopping]);
    }
    expect(inspections).toEqual(["first", "second"]);
    expect(admissions).toEqual(["first", "second"]);
    expect(stopped).toBe(true);
  });

  it("reports whether each durable admission inserted a new row", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-admission-"),
    });
    const admissions: boolean[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "lane:a" }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      onDurableAdmission: (_raw, { isNew }) => {
        admissions.push(isNew);
      },
    });

    try {
      await monitor.admit({ id: "event-one", text: "hello" });
      await monitor.admit({ id: "event-one", text: "hello" });
      expect(admissions).toEqual([true, false]);
    } finally {
      await monitor.stop();
    }
  });
});

it("keeps contended admission pruning responsive, ordered, and joined by stop", async () => {
  await withOpenClawTestState({ layout: "split" }, async (state) => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: state.stateDir,
      now: () => 10,
    });
    await queue.complete("expired", { completedAt: 1 });
    await queue.prune({ completedMaxEntries: 10 });
    const context = captureOpenClawStateWorkerContext();
    const holder = holdStateDatabaseCoordinator(
      context.admission.databasePath,
      context.coordinatorRuntime,
      1_000,
    );
    const admissions: string[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "lane:a" }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      now: () => 10,
      retention: { pruneIntervalMs: 0, completedTtlMs: 5 },
      onDurableAdmission: (raw) => {
        admissions.push(raw.id);
      },
    });
    let work: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await holder.ready;
      const heartbeat = nextTurn().then(() => Atomics.load(holder.released, 0));
      const first = monitor.admit({ id: "first", text: "one" });
      const second = monitor.admit({ id: "second", text: "two" });
      let stopped = false;
      stopping = monitor.stop().then(() => {
        stopped = true;
      });
      work = Promise.allSettled([first, second, stopping]);
      expect(await heartbeat, "heartbeat must run before the foreign writer releases").toBe(0);
      expect(admissions).toEqual([]);
      expect(stopped).toBe(false);
      holder.release();
      await Promise.all([first, second, stopping]);
      expect(admissions).toEqual(["first", "second"]);
      expect(stopped).toBe(true);
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["first", "second"]);
      expect(await queue.prune({ completedMaxEntries: 0 })).toBe(0);
    } finally {
      holder.release();
      await holder.joined;
      await work;
      await (stopping ?? monitor.stop());
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
