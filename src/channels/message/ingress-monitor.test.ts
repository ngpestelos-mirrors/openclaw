import { describe, expect, it, vi } from "vitest";
import {
  GatewayDrainingError,
  isGatewaySubordinateWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../process/gateway-work-admission.js";
import { createChannelIngressError } from "./ingress-errors.js";
import {
  CHANNEL_INGRESS_RETENTION_DEFAULTS,
  createChannelIngressMonitor,
  type ChannelIngressMonitorLifecycle,
} from "./ingress-monitor.js";
import {
  createMonitor,
  PermanentIngressError,
  useIngressMonitorQueueFixture,
  type RawEvent,
  type StoredEvent,
} from "./ingress-monitor.test-harness.js";
import type { ChannelIngressQueue } from "./ingress-queue.js";
import {
  ChannelIngressUnavailableError,
  isChannelIngressUnavailableError,
} from "./ingress-unavailable.js";

const withQueue = useIngressMonitorQueueFixture();

describe("channel ingress monitor", () => {
  it("creates named plain and reasoned ingress errors", () => {
    const PayloadError = createChannelIngressError("TestIngressPayloadError");
    const PermanentError = createChannelIngressError<"invalid-event">("TestIngressPermanentError", {
      withReason: true,
    });

    expect(PayloadError.name).toBe("TestIngressPayloadError");
    const payloadError = new PayloadError("invalid");
    expect(payloadError).toMatchObject({
      name: "TestIngressPayloadError",
      message: "invalid",
    });
    expect(payloadError).toBeInstanceOf(PayloadError);
    expect("reason" in payloadError).toBe(false);
    expect(new PermanentError("invalid-event", "invalid")).toMatchObject({
      name: "TestIngressPermanentError",
      reason: "invalid-event",
      message: "invalid",
    });
  });

  it("applies standard retention with explicit per-channel overrides", async () => {
    for (const [retention, completedMaxEntries] of [
      ["standard", 20_000],
      [{ completedMaxEntries: 1_000 }, 1_000],
    ] as const) {
      await withQueue(async (queue) => {
        let currentTime = CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        const prune = vi.spyOn(queue, "prune");
        const monitor = createMonitor(queue, vi.fn(), {
          retention,
          now: () => currentTime,
        });
        monitor.start();
        await monitor.waitForIdle();

        expect(prune).toHaveBeenCalledOnce();
        expect(prune).toHaveBeenCalledWith({
          completedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.completedTtlMs,
          completedMaxEntries,
          failedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedTtlMs,
          failedMaxEntries: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedMaxEntries,
          now: expect.any(Number),
        });

        currentTime += CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs;
        monitor.requestDrain();
        await monitor.waitForPumpIdle();
        expect(prune).toHaveBeenCalledTimes(2);
        await monitor.stop();
      });
    }
  });

  it("does not prune zero-interval retention from startup or idle polls", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const monitor = createMonitor(queue, vi.fn(), {
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      vi.useFakeTimers();
      try {
        monitor.start();
        await vi.advanceTimersByTimeAsync(65);
        await monitor.stop();

        expect(prune).not.toHaveBeenCalled();
      } finally {
        try {
          await monitor.stop();
        } finally {
          vi.useRealTimers();
        }
      }
    });
  });

  it("skips ignored events and prunes once before one admission enqueue", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const enqueue = vi.spyOn(queue, "enqueue");
      const monitor = createMonitor(queue, vi.fn(), {
        inspect: (raw) =>
          raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      await expect(monitor.admit({ id: "ignored", lane: "a", text: "receipt" })).resolves.toEqual({
        kind: "ignored",
      });
      expect(prune).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();

      await monitor.admit({ id: "event-one", lane: "a", text: "hello" });
      expect(prune).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledOnce();
      expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...enqueue.mock.invocationCallOrder),
      );
      await monitor.stop();
    });
  });

  it("prunes zero-interval retention once before a multi-event batch", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const enqueue = vi.spyOn(queue, "enqueue");
      const monitor = createMonitor(queue, vi.fn(), {
        inspect: (raw) =>
          raw.id === "ignored" ? null : { eventId: raw.id, laneKey: `lane:${raw.lane}` },
        retention: { pruneIntervalMs: 0, completedMaxEntries: 10 },
      });

      await monitor.admitBatch([
        { id: "ignored", lane: "a", text: "receipt" },
        { id: "event-batch-1", lane: "a", text: "first" },
        { id: "event-batch-2", lane: "b", text: "second" },
        { id: "event-batch-3", lane: "c", text: "third" },
      ]);

      expect(prune).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(Math.max(...prune.mock.invocationCallOrder)).toBeLessThan(
        Math.min(...enqueue.mock.invocationCallOrder),
      );
      await monitor.stop();
    });
  });

  it("adopts terminal no-dispatch events", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(queue, vi.fn());
      monitor.start();
      await expect(
        monitor.admit({ id: "event-terminal", lane: "a", text: "ignored" }),
      ).resolves.toMatchObject({ kind: "durable" });
      await monitor.waitForIdle();

      await expect(
        queue.enqueue("event-terminal", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("fans adoption finalization through before completing the claim", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onAdoptionFinalizing();
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-finalizing", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await expect(
        queue.enqueue("event-finalizing", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "completed" });
      await monitor.stop();
    });
  });

  it("dead-letters a claim whose decoded lane identity changed", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        "event-original",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "event-original", lane: "changed", text: "hello" }),
        },
        { laneKey: "lane:original" },
      );
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      await expect(
        queue.enqueue("event-original", { version: 1, rawEvent: "duplicate" }),
      ).resolves.toMatchObject({ kind: "failed", record: { reason: "invalid-event" } });
      await monitor.stop();
    });
  });
  it("rechecks identity against a derived lane for legacy rows", async () => {
    await withQueue(async (queue) => {
      await queue.enqueue("event-derived", {
        version: 1,
        rawEvent: JSON.stringify({ id: "event-derived", lane: "a", text: "hello" }),
      });
      const deliver = vi.fn();
      const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
        queue,
        inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
        payload: {
          storage: "raw-event",
          version: 1,
          serialize: (raw) => JSON.stringify(raw),
          deserialize: (body) => JSON.parse(body) as RawEvent,
          createClaimError: (kind) => new PermanentIngressError(kind),
        },
        deliver,
        pollIntervalMs: 10,
        retention: { pruneIntervalMs: 60_000 },
        drain: {
          deriveLaneKey: () => "lane:a",
          resolveNonRetryableFailure: (error) =>
            error instanceof PermanentIngressError
              ? { reason: "invalid-event", message: error.message }
              : null,
        },
      });
      monitor.start();
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });
  it("drains a newly admitted unrelated lane while another delivery is active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        if (raw.id === "event-first") {
          await firstDone;
        }
        await lifecycle.onAdopted();
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "b", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("can await claim startup without waiting for active delivery", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery = () => {};
      const deliveryGate = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const deliver = vi.fn(async () => {
        await deliveryGate;
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();

      await monitor.admit({ id: "event-started", lane: "a", text: "hello" });
      await monitor.waitForPumpIdle();

      expect(deliver).toHaveBeenCalledOnce();
      releaseDelivery();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("drains the next same-lane event after adoption while delivery remains active", async () => {
    await withQueue(async (queue) => {
      let releaseFirst: (() => void) | undefined;
      const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const delivered: string[] = [];
      const monitor = createMonitor(queue, async (raw, lifecycle) => {
        delivered.push(raw.id);
        await lifecycle.onAdopted();
        if (raw.id === "event-first") {
          await firstDone;
        }
      });
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));

      await monitor.admit({ id: "event-second", lane: "a", text: "fast" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-second"]));

      releaseFirst?.();
      await monitor.waitForIdle();
      await monitor.stop();
    });
  });

  it("re-arms a coalesced idle wake for a later retryable delivery", async () => {
    await withQueue(async (queue) => {
      let releaseFirst = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseRetry = () => {};
      const retryGate = new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      const delivered: string[] = [];
      let retryAttempts = 0;
      const monitor = createMonitor(
        queue,
        async (raw) => {
          delivered.push(raw.id);
          if (raw.id === "event-first") {
            await firstGate;
          } else if (retryAttempts++ === 0) {
            await retryGate;
            return { kind: "failed-retryable", error: new Error("retry") };
          }
          return { kind: "completed" };
        },
        undefined,
        undefined,
        undefined,
        60_000,
        0,
      );
      monitor.start();
      await monitor.admit({ id: "event-first", lane: "first", text: "slow" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first"]));
      await monitor.admit({ id: "event-retry", lane: "retry", text: "retry" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-first", "event-retry"]));

      releaseFirst();
      await vi.waitFor(async () =>
        expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(["event-retry"]),
      );
      releaseRetry();
      await vi.waitFor(() =>
        expect(delivered).toEqual(["event-first", "event-retry", "event-retry"]),
      );
      await monitor.waitForIdle();

      await monitor.stop();
    });
  });

  // Telegram and Slack release the ingress lane while a turn is deferred, so a
  // newer same-lane event can be claimed and fail while the older one is still
  // held. Cancelling that deferred owner reopens its row without consuming retry
  // budget, leaving an eligible lane head behind its own newer sibling's backoff.
  it("dispatches a reopened lane head while its newer sibling waits out backoff", async () => {
    await withQueue(async (queue) => {
      const delivered: string[] = [];
      let cancelHead: (() => Promise<void>) | undefined;
      const monitor = createMonitor(
        queue,
        async (raw, lifecycle) => {
          delivered.push(raw.id);
          if (raw.id !== "event-head") {
            return { kind: "failed-retryable", error: new Error("tail delivery failed") };
          }
          if (cancelHead) {
            return { kind: "completed" };
          }
          cancelHead = async () => await lifecycle.onCancelled?.();
          return { kind: "deferred" };
        },
        {
          deferredLaneOccupancy: "release",
          retryPolicy: { baseMs: 60_000, maxMs: 60_000 },
        },
      );
      monitor.start();
      await monitor.admit({ id: "event-head", lane: "a", text: "head" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head"]));
      await monitor.admit({ id: "event-tail", lane: "a", text: "tail" });
      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail"]));
      // The failed tail is pending inside its backoff; the head is still claimed.
      await vi.waitFor(async () =>
        expect(
          (await queue.listPending({ limit: "all", orderBy: "received" })).map((event) => event.id),
        ).toEqual(["event-tail"]),
      );

      expect(cancelHead).toBeDefined();
      await cancelHead?.();

      await vi.waitFor(() => expect(delivered).toEqual(["event-head", "event-tail", "event-head"]));
      await monitor.waitForIdle();
      // The tail still never starts early: it stays parked for its own backoff.
      expect(delivered).toEqual(["event-head", "event-tail", "event-head"]);

      await monitor.stop();
    });
  });

  it("defers a claimed event across restart drain without consuming retry budget", async () => {
    await withQueue(async (queue) => {
      const event = {
        id: "event-restart-drain",
        lane: "a",
        text: "recover me",
      } satisfies RawEvent;
      const storedEvent = {
        version: 1,
        rawEvent: JSON.stringify(event),
      } satisfies StoredEvent;
      const drainErrors: unknown[] = [];
      const oldDeliver = vi.fn(
        async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
          try {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          } catch (error) {
            drainErrors.push(error);
            throw error;
          }
        },
      );
      const monitorOptions = {
        retryPolicy: {
          maxAttempts: 8,
          deadLetterMinAgeMs: 0,
          baseMs: 0,
          maxMs: 0,
        },
      } as const;
      const oldMonitor = createMonitor(
        queue,
        oldDeliver,
        monitorOptions,
        undefined,
        undefined,
        60_000,
      );
      let successorMonitor: ReturnType<typeof createMonitor> | undefined;
      oldMonitor.start();
      try {
        await oldMonitor.waitForIdle();

        let markPendingScanStarted = () => {};
        const pendingScanStarted = new Promise<void>((resolve) => {
          markPendingScanStarted = resolve;
        });
        let releasePendingScan = () => {};
        const pendingScanGate = new Promise<void>((resolve) => {
          releasePendingScan = resolve;
        });
        const listUnsettled = queue.listUnsettled!.bind(queue);
        let gateNextPendingScan = true;
        queue.listUnsettled = async (...args) => {
          if (gateNextPendingScan) {
            gateNextPendingScan = false;
            markPendingScanStarted();
            await pendingScanGate;
          }
          return await listUnsettled(...args);
        };

        oldMonitor.requestDrain();
        await pendingScanStarted;
        markGatewayRestartDraining();
        await queue.enqueue(event.id, storedEvent, { laneKey: "lane:a" });
        releasePendingScan();
        await vi.waitFor(() => expect(drainErrors.length).toBeGreaterThan(0));

        for (let cycle = 0; cycle < 8; cycle += 1) {
          oldMonitor.requestDrain();
          await oldMonitor.waitForIdle();
        }

        expect(drainErrors[0]).toBeInstanceOf(GatewayDrainingError);
        expect(drainErrors).toHaveLength(1);
        expect(oldDeliver).toHaveBeenCalledOnce();
        await expect(queue.listClaims()).resolves.toEqual([]);
        await expect(queue.listPending()).resolves.toEqual([
          expect.objectContaining({ id: event.id, attempts: 0 }),
        ]);
        await expect(queue.listFailed?.()).resolves.toEqual([]);

        await oldMonitor.stop();
        resetGatewayWorkAdmission();
        const successorDeliver = vi.fn(
          async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
            await runWithGatewayIndependentRootWorkAdmission(async () => {
              await lifecycle.onAdopted();
            });
          },
        );
        successorMonitor = createMonitor(
          queue,
          successorDeliver,
          monitorOptions,
          undefined,
          undefined,
          60_000,
        );
        successorMonitor.start();
        await successorMonitor.waitForIdle();

        expect(successorDeliver).toHaveBeenCalledOnce();
        expect(oldDeliver).toHaveBeenCalledOnce();
        await expect(
          queue.enqueue(event.id, { version: 1, rawEvent: "duplicate" }),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        await successorMonitor?.stop();
        await oldMonitor.stop();
        resetGatewayWorkAdmission();
      }
    });
  });

  it("reports active delivery work until the channel callback settles", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery: (() => void) | undefined;
      const deliveryDone = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const activity: boolean[] = [];
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          await lifecycle.onAdopted();
          await deliveryDone;
        },
        (active) => activity.push(active),
      );
      monitor.start();
      await monitor.waitForIdle();
      activity.length = 0;

      await monitor.admit({ id: "event-active", lane: "a", text: "slow" });
      await vi.waitFor(() => expect(activity).toContain(true));
      expect(activity.at(-1)).toBe(true);

      releaseDelivery?.();
      await monitor.waitForIdle();
      expect(activity.at(-1)).toBe(false);
      await monitor.stop();
    });
  });

  it("isolates activity observer failures from delivery bookkeeping", async () => {
    await withQueue(async (queue) => {
      const observerError = new Error("observer failed");
      const onError = vi.fn();
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createMonitor(
        queue,
        deliver,
        () => {
          throw observerError;
        },
        onError,
      );
      monitor.start();

      await monitor.admit({ id: "event-observer", lane: "a", text: "hello" });
      await monitor.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(observerError);
      await monitor.stop();
    });
  });

  it("keeps a started delivery admissible after its detached pump root releases", async () => {
    await withQueue(async (queue) => {
      let releaseDeliver = () => {};
      const deliverGate = new Promise<void>((resolve) => {
        releaseDeliver = resolve;
      });
      let admissionClosedDuringDelivery: boolean | undefined;
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await deliverGate;
        admissionClosedDuringDelivery = isGatewaySubordinateWorkAdmissionClosed();
        await lifecycle.onAdopted();
      });
      let markPumpTaskSettled = () => {};
      const pumpTaskSettled = new Promise<void>((resolve) => {
        markPumpTaskSettled = resolve;
      });
      // Mirror the production webhook-spool combination: the pump runs on its
      // own detached root and does not wait for deliveries before returning.
      const monitor = createMonitor(queue, deliver, {
        waitForDeliveryIdleBeforeRepump: false,
        runPumpTask: (work) =>
          runWithGatewayIndependentRootWorkContinuation(work).finally(() => markPumpTaskSettled()),
      });
      monitor.start();
      try {
        // Admit inside its own root and let it release right away, the way an
        // ack-first webhook request root releases once the 200 is written.
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await monitor.admit({ id: "event-detached-root", lane: "a", text: "hello" });
        });
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        // The pump returns while the delivery is still in flight; every root
        // the dispatch could have inherited is released at this point.
        await pumpTaskSettled;
        releaseDeliver();

        await vi.waitFor(() => expect(admissionClosedDuringDelivery).toBeDefined());
        expect(admissionClosedDuringDelivery).toBe(false);
        await monitor.waitForIdle();
        await expect(queue.listPending()).resolves.toEqual([]);
        await expect(queue.listClaims()).resolves.toEqual([]);
      } finally {
        releaseDeliver();
        await monitor.stop();
      }
    });
  });

  it("dispatches outside an already-released inherited root instead of refusing", async () => {
    await withQueue(async (queue) => {
      let releaseDeliver = () => {};
      const deliverGate = new Promise<void>((resolve) => {
        releaseDeliver = resolve;
      });
      let admissionClosedDuringDelivery: boolean | undefined;
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await deliverGate;
        admissionClosedDuringDelivery = isGatewaySubordinateWorkAdmissionClosed();
        await lifecycle.onAdopted();
      });
      // No runPumpTask: the pump chain inherits the admitting caller's context,
      // the way a transport request that enqueues an event does.
      const monitor = createMonitor(queue, deliver, {}, undefined, undefined, 60_000);
      let markPendingScanStarted = () => {};
      const pendingScanStarted = new Promise<void>((resolve) => {
        markPendingScanStarted = resolve;
      });
      let releasePendingScan = () => {};
      const pendingScanGate = new Promise<void>((resolve) => {
        releasePendingScan = resolve;
      });
      const listUnsettled = queue.listUnsettled!.bind(queue);
      let gateNextPendingScan = true;
      queue.listUnsettled = async (...args) => {
        if (gateNextPendingScan) {
          gateNextPendingScan = false;
          markPendingScanStarted();
          await pendingScanGate;
        }
        return await listUnsettled(...args);
      };
      monitor.start();
      try {
        // Admit inside a root that releases as soon as the enqueue returns;
        // the gated scan keeps the claim from happening until after that.
        await runWithGatewayIndependentRootWorkAdmission(async () => {
          await monitor.admit({ id: "event-released-root", lane: "a", text: "hello" });
          await pendingScanStarted;
        });
        releasePendingScan();
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        releaseDeliver();

        await vi.waitFor(() => expect(admissionClosedDuringDelivery).toBeDefined());
        expect(admissionClosedDuringDelivery).toBe(false);
        await monitor.waitForIdle();
        await expect(queue.listClaims()).resolves.toEqual([]);
      } finally {
        releaseDeliver();
        releasePendingScan();
        await monitor.stop();
      }
    });
  });

  it("can prepare the durable queue before starting the drain", async () => {
    await withQueue(async (queue) => {
      const queueFactory = vi.fn(() => queue);
      const monitor = createMonitor(queueFactory, vi.fn());

      monitor.ensureQueueAvailable();
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(monitor.isRunning()).toBe(false);

      monitor.start();
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(monitor.isRunning()).toBe(true);
      await monitor.stop();
    });
  });

  it("fails start once when the durable queue cannot be opened", async () => {
    const denial = new Error(
      'openChannelIngressQueue is only available for trusted plugins in this release. Plugin "slack" loaded with origin "config"',
    );
    const queueFactory = vi.fn((): ChannelIngressQueue<StoredEvent> => {
      throw denial;
    });
    const onError = vi.fn();
    const monitor = createMonitor(queueFactory, vi.fn(), undefined, onError, undefined, 1);

    vi.useFakeTimers();
    try {
      // The typed rethrow is the gateway's only way to tell dead inbound apart from
      // an ordinary channel crash; the denial stays reachable as the cause.
      const startError = (() => {
        try {
          monitor.start();
          return expect.unreachable("start must fail while the durable queue is denied");
        } catch (error) {
          return error;
        }
      })();
      expect(startError).toBeInstanceOf(ChannelIngressUnavailableError);
      expect((startError as Error).cause).toBe(denial);
      expect(isChannelIngressUnavailableError(startError)).toBe(true);
      // A channel plugin is free to wrap the start failure in its own error.
      expect(
        isChannelIngressUnavailableError(new Error("slack start failed", { cause: startError })),
      ).toBe(true);
      expect(isChannelIngressUnavailableError(denial)).toBe(false);
      expect(monitor.isRunning()).toBe(false);
      // An armed poll timer would have retried the denied factory many times over this window.
      await vi.advanceTimersByTimeAsync(25);
      expect(queueFactory).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();

      // Accepted transport input still fails closed rather than being silently dropped.
      const admissionAssertion = expect(
        monitor.admit({ id: "event-denied", lane: "a", text: "hello" }),
      ).rejects.toBe(denial);
      const timerRun = vi.runAllTimersAsync();
      // A failed assertion can settle first; join the clock driver before restoring timers.
      try {
        await Promise.all([admissionAssertion, timerRun]);
      } finally {
        await timerRun;
      }
    } finally {
      try {
        await monitor.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
