import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("throws IngressAdoptionLostError when complete returns false (lease reclaimed)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-reclaim", { text: "x" }, { laneKey: "l1" });

      queue.complete = async () => false;

      let adoptError: unknown;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          try {
            await lifecycle.onAdopted();
          } catch (err) {
            adoptError = err;
            throw err;
          }
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();
      expect(isIngressAdoptionLostError(adoptError)).toBe(true);
      expect(isIngressAdoptionLostError(adoptError) && adoptError.code).toBe("reclaimed");
      // Claim remains held — not settled as a false success.
      expect(drain.activeLaneKeys().has("l1")).toBe(true);
      drain.dispose();
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
