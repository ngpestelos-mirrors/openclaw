import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import type { ChannelIngressMonitorLifecycle } from "./ingress-monitor.js";
import {
  createMonitor,
  useIngressMonitorQueueFixture,
  waitForAbort,
  type RawEvent,
} from "./ingress-monitor.test-harness.js";

const withQueue = useIngressMonitorQueueFixture();

describe("channel ingress monitor shutdown", () => {
  it("releases a pre-adoption delivery for retry before disposing on stop", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await waitForAbort(lifecycle.abortSignal);
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-retry", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      await expect(queue.listClaims()).resolves.toEqual([]);
      await expect(queue.listPending()).resolves.toEqual([
        expect.objectContaining({ id: "event-stop-retry", lastError: expect.any(String) }),
      ]);
      await expect(monitor.waitForIdle()).resolves.toBeUndefined();
    });
  });

  it("joins a settlement write before disposing the drain on stop", async () => {
    await withQueue(async (queue) => {
      let markReleaseStarted = () => {};
      const releaseStarted = new Promise<void>((resolve) => {
        markReleaseStarted = resolve;
      });
      let releaseSettlement = () => {};
      const settlementGate = new Promise<void>((resolve) => {
        releaseSettlement = resolve;
      });
      const release = queue.release.bind(queue);
      const order: string[] = [];
      const blockedRelease: typeof queue.release = async (idOrClaim, releaseOptions) => {
        markReleaseStarted();
        await settlementGate;
        const result = await release(idOrClaim, releaseOptions);
        order.push("committed");
        return result;
      };
      queue.release = vi.fn(blockedRelease);
      const monitor = createMonitor(queue, async () => ({
        kind: "failed-retryable",
        error: new Error("retry later"),
      }));
      monitor.start();
      await monitor.admit({ id: "event-stop-settlement", lane: "a", text: "hello" });
      await releaseStarted;

      const stopping = monitor.stop().then(() => order.push("stopped"));
      try {
        await monitor.waitForPumpIdle();
        releaseSettlement();
        await stopping;
        expect(order).toEqual(["committed", "stopped"]);
      } finally {
        releaseSettlement();
        await stopping;
      }
    });
  });

  it("completes deliveries whose terminal result races a stop abort", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "completed" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-completed", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // Side effects finished and the channel reported completed; settling the
      // claim for retry would replay already-delivered work on restart.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toEqual([]);
    });
  });

  it("keeps deferred handoffs with their owner when a stop abort races the return", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onDeferred();
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "deferred" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-stop-deferred-race", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // The deferred owner still owns the claim; releasing it for retry would
      // replay work the owner is completing.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
    });
  });

  it("keeps a deferred handoff when stop abort races a conflicting completed return", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn(async (_raw: RawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        lifecycle.onDeferred();
        await waitForAbort(lifecycle.abortSignal);
        return { kind: "completed" as const };
      });
      const monitor = createMonitor(queue, deliver);
      monitor.start();
      await monitor.admit({ id: "event-deferred-then-completed", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());

      await monitor.stop();

      // A recorded handoff owns the claim, so stop cannot rewrite the
      // conflicting terminal return and release the row for replay.
      await expect(queue.listPending()).resolves.toEqual([]);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
    });
  });

  it("clears a queued drain request when abort wins an active pump", async () => {
    await withQueue(async (queue) => {
      let markPruneStarted = () => {};
      const pruneStarted = new Promise<void>((resolve) => {
        markPruneStarted = resolve;
      });
      let releasePrune = () => {};
      const pruneGate = new Promise<void>((resolve) => {
        releasePrune = resolve;
      });
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        markPruneStarted();
        await pruneGate;
        return await prune(...args);
      };
      const abortController = new AbortController();
      const monitor = createMonitor(queue, vi.fn(), undefined, undefined, abortController.signal);
      monitor.start();
      await pruneStarted;

      await monitor.admit({ id: "event-abort-requested", lane: "a", text: "hello" });
      abortController.abort();
      releasePrune();

      await expect(monitor.waitForIdle()).resolves.toBeUndefined();
      await monitor.stop();
    });
  });

  it("stops with an outstanding deferred claim without waiting for adoption", async () => {
    await withQueue(async (queue) => {
      let deferredSignal: AbortSignal | undefined;
      const monitor = createMonitor(queue, async (_raw, lifecycle) => {
        deferredSignal = lifecycle.abortSignal;
        lifecycle.onDeferred();
      });
      monitor.start();
      await monitor.admit({ id: "event-stop-deferred", lane: "a", text: "hello" });
      await vi.waitFor(() => expect(deferredSignal).toBeDefined());

      await expect(monitor.stop()).resolves.toBeUndefined();

      expect(deferredSignal?.aborted).toBe(true);
      await expect(queue.listClaims()).resolves.toHaveLength(1);
    });
  });

  it.each(["onDeferred", "onAdoptionFinalizing"] as const)(
    "waits for tracked %s claims to settle before drain disposal",
    async (handoff) => {
      await withQueue(async (queue) => {
        let deferredLifecycle: ChannelIngressMonitorLifecycle | undefined;
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            deferredLifecycle = lifecycle;
            lifecycle[handoff]();
          },
          { deferredClaims: "wait-on-stop" },
        );
        monitor.start();
        await monitor.admit({ id: "event-tracked-deferred", lane: "a", text: "hello" });
        await vi.waitFor(() => expect(deferredLifecycle).toBeDefined());

        let stopped = false;
        const stopping = monitor.stop().then(() => {
          stopped = true;
        });
        await vi.waitFor(() => expect(deferredLifecycle?.abortSignal.aborted).toBe(true));
        expect(stopped).toBe(false);

        await deferredLifecycle?.onAbandoned();
        await stopping;
        expect(stopped).toBe(true);
      });
    },
  );

  it.each(
    (["cancel", "adopt", "completed", "failed"] as const).flatMap((settlementKind) =>
      [false, true].map((waitForDeliveryIdleOnStop) => ({
        settlementKind,
        waitForDeliveryIdleOnStop,
      })),
    ),
  )(
    "joins the $settlementKind write before disposal with delivery wait=$waitForDeliveryIdleOnStop",
    async ({ settlementKind, waitForDeliveryIdleOnStop }) => {
      await withQueue(async (queue) => {
        const started = createDeferredCore();
        const writeStarted = createDeferredCore();
        const commit = createDeferredCore();
        const order: string[] = [];
        const pauseWrite = async (write: () => Promise<boolean>) => {
          writeStarted.resolve();
          await commit.promise;
          const result = await write();
          order.push("committed");
          return result;
        };
        if (settlementKind === "cancel" || settlementKind === "failed") {
          const release = queue.release.bind(queue);
          vi.spyOn(queue, "release").mockImplementation((...args) =>
            pauseWrite(() => release(...args)),
          );
        } else {
          const complete = queue.complete.bind(queue);
          vi.spyOn(queue, "complete").mockImplementation((...args) =>
            pauseWrite(() => complete(...args)),
          );
        }
        let settlement = Promise.resolve();
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            started.resolve();
            if (settlementKind === "completed") {
              return { kind: "completed" };
            }
            if (settlementKind === "failed") {
              return { kind: "failed-retryable", error: new Error("retry delivery") };
            }
            await waitForAbort(lifecycle.abortSignal);
            settlement = Promise.resolve(
              settlementKind === "cancel" ? lifecycle.onCancelled?.() : lifecycle.onAdopted(),
            );
            return { kind: settlementKind === "cancel" ? "deferred" : "completed" };
          },
          { deferredClaims: "wait-on-stop", waitForDeliveryIdleOnStop },
        );
        monitor.start();
        await monitor.admit({ id: "inline-settlement", lane: "a", text: "hello" });
        await started.promise;
        if (settlementKind === "completed" || settlementKind === "failed") {
          await writeStarted.promise;
        }
        const stopping = monitor.stop().then(() => order.push("stopped"));
        const successor = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (_claim, lifecycle) => {
            await lifecycle.onAdopted();
          },
        });
        try {
          await writeStarted.promise;
          await monitor.waitForPumpIdle();
          expect(await successor.drainOnce()).toEqual({ started: 0 });
          commit.resolve();
          await Promise.all([settlement, stopping]);
          expect(order).toEqual(["committed", "stopped"]);
          expect(await queue.listClaims()).toEqual([]);
          expect((await queue.listPending()).map((row) => row.id)).toEqual(
            settlementKind === "cancel" || settlementKind === "failed" ? ["inline-settlement"] : [],
          );
        } finally {
          commit.resolve();
          await Promise.allSettled([settlement, stopping]);
          await successor.waitForIdle();
          successor.dispose();
        }
      });
    },
  );

  it("can settle tracked deferred bookkeeping on abort", async () => {
    await withQueue(async (queue) => {
      const monitor = createMonitor(
        queue,
        async (_raw, lifecycle) => {
          lifecycle.onDeferred();
        },
        { deferredClaims: "settle-on-abort" },
      );
      monitor.start();
      await monitor.admit({ id: "event-abort-deferred", lane: "a", text: "hello" });

      await expect(monitor.stop()).resolves.toBeUndefined();
      await expect(monitor.waitForDeferredClaims()).resolves.toBeUndefined();
    });
  });

  it.each(
    (["throw", "return"] as const).flatMap((failureMode) =>
      [false, true].map((ownerAborted) => ({ failureMode, ownerAborted })),
    ),
  )(
    "settles tracked finalization after $failureMode with ownerAborted=$ownerAborted",
    async ({ failureMode, ownerAborted }) => {
      await withQueue(async (queue) => {
        const error = new Error("inline finalization failed");
        const abort = new AbortController();
        let finalizingLifecycle: ChannelIngressMonitorLifecycle | undefined;
        const monitor = createMonitor(
          queue,
          async (_raw, lifecycle) => {
            finalizingLifecycle = lifecycle;
            lifecycle.onAdoptionFinalizing();
            if (ownerAborted) {
              abort.abort(error);
            }
            if (failureMode === "throw") {
              throw error;
            }
            return { kind: "failed-retryable", error };
          },
          { deferredClaims: "wait-on-stop", abortSignal: abort.signal },
        );
        monitor.start();
        await monitor.admit({ id: "event-finalization-failure", lane: "a", text: "hello" });
        await monitor.waitForIdle();
        await monitor.pause();
        let settlementFinished = false;
        const settlement = monitor.waitForDeferredClaims().then(() => {
          settlementFinished = true;
        });
        try {
          expect(await queue.listClaims()).toEqual([]);
          expect(await queue.listPending({ limit: "all" })).toMatchObject([
            { id: "event-finalization-failure", attempts: 1, lastError: error.message },
          ]);
          await vi.waitFor(() => expect(settlementFinished).toBe(true));
        } finally {
          await finalizingLifecycle?.onAbandoned();
          await settlement;
          await monitor.stop();
        }
      });
    },
  );
  it("keeps append-only admission available after stop when explicitly requested", async () => {
    await withQueue(async (queue) => {
      const deliver = vi.fn();
      const retired = createMonitor(queue, deliver, { admissionMode: "durable-after-stop" });
      retired.start();
      await retired.stop();

      await expect(
        retired.admit({ id: "event-late", lane: "a", text: "after unregister" }),
      ).resolves.toMatchObject({ kind: "durable" });
      expect(deliver).not.toHaveBeenCalled();

      const recovered = createMonitor(queue, deliver);
      recovered.start();
      await recovered.waitForIdle();
      expect(deliver).toHaveBeenCalledOnce();
      await recovered.stop();
    });
  });

  it("can defer delivery-idle waiting to a channel-owned shutdown grace", async () => {
    await withQueue(async (queue) => {
      let releaseDelivery!: () => void;
      let markDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => {
        markDeliveryStarted = resolve;
      });
      const monitor = createMonitor(
        queue,
        async () => {
          markDeliveryStarted();
          await new Promise<void>((resolve) => {
            releaseDelivery = resolve;
          });
        },
        { waitForDeliveryIdleBeforeRepump: false, waitForDeliveryIdleOnStop: false },
      );
      monitor.start();
      await monitor.admit({ id: "event-active", lane: "a", text: "hello" });
      await deliveryStarted;

      await monitor.stop();
      releaseDelivery();
      await monitor.waitForIdle();
    });
  });
});
