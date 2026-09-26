import { AsyncLocalStorage } from "node:async_hooks";
import {
  activitySummaryScope,
  type ActivitySummaryTarget,
} from "./session-activity-summary-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export type ActivitySummaryRequest = ActivitySummaryTarget & {
  immediate: boolean;
  sessionId?: string;
  lifecycleRevision?: string;
  rowGeneration?: string | symbol;
};

export type ActivitySummaryRows = Pick<
  SessionRowProjection,
  "sharingTarget" | "prepareMembership" | "needsMembershipPreparation"
>;

/** Retain request intents, never session facts, while the row owner prepares its topology. */
export function createActivitySummaryReadiness(params: {
  getRows: () => ActivitySummaryRows | undefined;
  capacity: number;
  onReady: (request: ActivitySummaryRequest) => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Map<string, ActivitySummaryRequest>();
  let closed = false;
  let work: Promise<void> | undefined;
  const drain = AsyncLocalStorage.bind(async () => {
    while (pending.size) {
      if (closed) {
        return;
      }
      const rows = params.getRows();
      if (!rows) {
        return;
      }
      await rows.prepareMembership();
      if (closed) {
        return;
      }
      if (params.getRows() !== rows || rows.needsMembershipPreparation()) {
        continue;
      }
      const requests = [...pending.values()];
      pending.clear();
      for (const request of requests) {
        params.onReady(request);
      }
    }
  });
  const resume = () => {
    if (closed || work || !pending.size || !params.getRows()) {
      return;
    }
    let completed = false;
    work = drain()
      .then(() => {
        completed = true;
      }, params.onError)
      .finally(() => {
        work = undefined;
        // A failed preparation retains its intents for the next signal, without a retry loop.
        if (completed) {
          resume();
        }
      });
  };
  return {
    enqueue(request: ActivitySummaryRequest) {
      const key = activitySummaryScope(request);
      const previous = pending.get(key);
      if (closed || (!previous && pending.size >= params.capacity)) {
        return false;
      }
      if (!previous?.immediate || request.immediate) {
        pending.set(key, { ...request });
      }
      resume();
      return true;
    },
    has: (target: ActivitySummaryTarget) => pending.has(activitySummaryScope(target)),
    forget: (target: ActivitySummaryTarget) => pending.delete(activitySummaryScope(target)),
    resume,
    async dispose() {
      closed = true;
      pending.clear();
      await work;
    },
  };
}
