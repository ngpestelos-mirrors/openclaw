import { randomUUID } from "node:crypto";
import { matchesDurableQuestionDefinition } from "../config/sessions/session-questions-definition.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";

/** Deduplicates one captured custody obligation while its execution/publication tail is owned. */
export function createQuestionContinuationWork(params: {
  track: (run: () => Promise<void>) => Promise<void>;
  isClosing: () => boolean;
  scheduler: GatewayScheduler;
}) {
  const scheduler = params.scheduler.scope();
  const pending = new Set<DurableQuestion>();
  return {
    offer: (
      question: DurableQuestion,
      run: () => Promise<void | "admission_owed">,
    ): Promise<void> | undefined => {
      if (params.isClosing() || scheduler.signal.aborted) {
        return undefined;
      }
      const captured = structuredClone(question);
      const definition = {
        ...captured,
        record: { ...captured.record, status: "pending" as const },
      };
      for (const existing of pending) {
        if (
          existing.record.createdAtMs === captured.record.createdAtMs &&
          existing.record.expiresAtMs === captured.record.expiresAtMs &&
          existing.resolutionId === captured.resolutionId &&
          matchesDurableQuestionDefinition(existing, definition)
        ) {
          return undefined;
        }
      }
      // Register before the tracked callback runs; reentrant offers share this exact owner.
      pending.add(captured);
      const retryId = `durable-question-admission:${randomUUID()}`;
      let retryDelayMs = 1_000;
      const attempt = async () => {
        let retry = false;
        try {
          if (!params.isClosing() && !scheduler.signal.aborted) {
            retry = (await run()) === "admission_owed";
          }
        } finally {
          if (retry && !params.isClosing() && !scheduler.signal.aborted) {
            scheduler.schedule({ id: retryId, delayMs: retryDelayMs, run: attempt });
            retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
          } else {
            pending.delete(captured);
          }
        }
      };
      try {
        return params.track(attempt);
      } catch (error) {
        pending.delete(captured);
        throw error;
      }
    },
    beginClose: () => {
      scheduler.beginClose();
      pending.clear();
    },
    stop: () => scheduler.stop(),
  };
}
