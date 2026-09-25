import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain, isIngressAdoptionLostError } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("requires owner cancellation before finalizing retained claim custody", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("retained", { text: "pending" }, { laneKey: "lane" });
      const abort = new AbortController();
      let cancellation: Promise<void> | undefined;
      const drain = createChannelIngressDrain<Payload>(
        {
          queue,
          abortSignal: abort.signal,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            lifecycle.abortSignal.addEventListener(
              "abort",
              () => {
                cancellation = Promise.resolve(lifecycle.onCancelled?.());
              },
              { once: true },
            );
            return { kind: "deferred" };
          },
        },
        true,
      );
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        const claim = await queue.listClaims();
        expect(claim).toHaveLength(1);
        await expect(drain.dispose({ waitForSettlements: true })).rejects.toThrow(
          "already-aborted retained owner",
        );
        expect(cancellation).toBeUndefined();
        expect(await queue.listClaims()).toEqual(claim);

        abort.abort();
        await drain.dispose({ waitForSettlements: true });
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending()).toMatchObject([{ id: "retained", attempts: 0 }]);
      } finally {
        abort.abort();
        await cancellation;
        drain.dispose();
      }
    });
  });

  it.each(["before", "during"] as const)(
    "keeps failed completion custody when the write rejects %s joined disposal",
    async (timing) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("completion-failure", { text: "delivered" }, { laneKey: "lane" });
        if (timing === "during") {
          await queue.enqueue("sibling", { text: "delivered" }, { laneKey: "other" });
        }
        const writeStarted = createDeferredCore();
        const finishWrite = createDeferredCore();
        const siblingStarted = createDeferredCore();
        const finishSibling = createDeferredCore();
        const adoptionFailed = createDeferredCore();
        const failure = new Error("completion write failed");
        const complete = queue.complete.bind(queue);
        queue.complete = async (value, options) => {
          if (typeof value !== "string" && value.id === "sibling") {
            siblingStarted.resolve();
            await finishSibling.promise;
            return complete(value, options);
          }
          writeStarted.resolve();
          await finishWrite.promise;
          throw failure;
        };
        const abort = new AbortController();
        const delivered = vi.fn<(id: string) => void>();
        const drain = createChannelIngressDrain(
          {
            queue,
            abortSignal: abort.signal,
            dispatchClaimedEvent: async (event, lifecycle) => {
              delivered(event.id);
              try {
                await lifecycle.onAdopted();
              } catch (error) {
                adoptionFailed.resolve();
                throw error;
              }
            },
          },
          true,
        );
        const peer = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: (event) => delivered(event.id),
        });
        try {
          await drain.drainOnce();
          await writeStarted.promise;
          if (timing === "during") {
            await siblingStarted.promise;
          }
          abort.abort();
          if (timing === "before") {
            finishWrite.resolve();
            await drain.waitForIdle();
          }
          let disposalFinished = false;
          const disposal = drain.dispose({ waitForSettlements: true }).finally(() => {
            disposalFinished = true;
          });
          const rejection = expect(disposal).rejects.toBe(failure);
          finishWrite.resolve();
          await adoptionFailed.promise;
          if (timing === "during") {
            expect(disposalFinished).toBe(false);
            finishSibling.resolve();
          }
          await rejection;
          expect(await peer.recoverStaleClaims()).toBe(0);
          expect(await peer.drainOnce()).toEqual({ started: 0 });
          expect(delivered.mock.calls.map(([id]) => id).toSorted()).toEqual(
            timing === "during" ? ["completion-failure", "sibling"] : ["completion-failure"],
          );
          expect(await queue.listClaims()).toMatchObject([{ id: "completion-failure" }]);
        } finally {
          abort.abort();
          finishWrite.resolve();
          finishSibling.resolve();
          await drain.waitForIdle();
          drain.dispose();
          peer.dispose();
        }
      });
    },
  );

  it("does not steal live peer-drain claims; recovers after owner abort", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-peer", { text: "x" }, { laneKey: "l1" });

      let releaseFirst!: () => void;
      const firstHold = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstDispatches: string[] = [];
      const secondDispatches: string[] = [];
      const firstAbort = new AbortController();

      const first = createChannelIngressDrain<Payload>({
        queue,
        abortSignal: firstAbort.signal,
        dispatchClaimedEvent: async (event, lifecycle) => {
          firstDispatches.push(event.id);
          await firstHold;
          await lifecycle.onAdopted();
        },
      });
      const second = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (event, lifecycle) => {
          secondDispatches.push(event.id);
          await lifecycle.onAdopted();
        },
      });

      await first.drainOnce();
      expect(firstDispatches).toEqual(["evt-peer"]);

      // Live peer must not steal the in-flight claim.
      const stealAttempt = await second.recoverStaleClaims();
      expect(stealAttempt).toBe(0);
      await second.drainOnce();
      expect(secondDispatches).toEqual([]);

      firstAbort.abort();
      await expect(first.dispose({ waitForSettlements: true })).rejects.toThrow(
        "already-aborted retained owner",
      );
      // Aborted owners retire before an uncooperative handler returns, allowing
      // the replacement drain to recover under the claim-token fence.
      const recovered = await second.recoverStaleClaims();
      expect(recovered).toBeGreaterThanOrEqual(1);
      await second.drainOnce();
      await second.waitForIdle();
      expect(secondDispatches).toEqual(["evt-peer"]);
      releaseFirst();
      await first.waitForIdle();
      first.dispose();
      second.dispose();
    });
  });

  it("rejects adoption after reclaim without blocking disposal or disturbing the successor", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-reclaim", { text: "x" }, { laneKey: "l1" });

      const adopt = createDeferredCore();
      const abort = new AbortController();
      let adoptError: unknown;
      const drain = createChannelIngressDrain<Payload>(
        {
          queue,
          abortSignal: abort.signal,
          dispatchClaimedEvent: async (_event, lifecycle) => {
            await adopt.promise;
            try {
              await lifecycle.onAdopted();
            } catch (err) {
              adoptError = err;
              throw err;
            }
          },
        },
        true,
      );
      try {
        await drain.drainOnce();
        const [original] = await queue.listClaims();
        if (!original) {
          throw new Error("Expected the original ingress claim");
        }
        expect(await queue.release(original)).toBe(true);
        const successor = await queue.claim("evt-reclaim", { ownerId: "replacement" });
        expect(successor).not.toBeNull();
        adopt.resolve();
        await drain.waitForIdle();
        expect(isIngressAdoptionLostError(adoptError)).toBe(true);
        expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("reclaimed");
        expect(drain.activeLaneKeys().has("l1")).toBe(true);

        abort.abort();
        await drain.dispose({ waitForSettlements: true });
        expect(await queue.listClaims()).toEqual([successor]);
      } finally {
        adopt.resolve();
        abort.abort();
        await drain.waitForIdle();
        drain.dispose();
      }
    });
  });

  it("refreshClaim false aborts the handler mid-dispatch (lease reclaimed)", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1_000;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("evt-refresh-false", { text: "x" }, { laneKey: "l1" });

      const refreshClaim = vi.fn(async () => false);
      queue.refreshClaim = refreshClaim;

      let sawAbort = false;
      let lateAdoptError: unknown;
      let releaseDispatch!: () => void;
      const holdDispatch = new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });

      const claimLeaseMs = 3_000;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => clock,
        claimLeaseMs,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          lifecycle.abortSignal.addEventListener(
            "abort",
            () => {
              sawAbort = true;
            },
            { once: true },
          );
          await holdDispatch;
          try {
            await lifecycle.onAdopted();
          } catch (err) {
            lateAdoptError = err;
            throw err;
          }
        },
      });

      await drain.drainOnce();
      clock += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshClaim).toHaveBeenCalled();
      await vi.waitFor(() => expect(sawAbort).toBe(true));

      releaseDispatch();
      await drain.waitForIdle();
      expect(isIngressAdoptionLostError(lateAdoptError)).toBe(true);
      expect(isIngressAdoptionLostError(lateAdoptError) && lateAdoptError.code).toBe("guillotined");
      drain.dispose();
    });
  });
});
