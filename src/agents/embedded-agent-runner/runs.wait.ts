import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { waitForReplyRunEndBySessionId } from "../../auto-reply/reply/reply-run-registry.registry.js";
import { notifyGatewayWorkMetricsChanged } from "../../infra/gateway-work-metrics-events.js";
import { diagnosticLogger as diag } from "../../logging/diagnostic-runtime.js";
import { isEmbeddedAgentRunActive } from "./active-run-projections.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  EMBEDDED_RUN_WAITERS,
  type EmbeddedAgentQueueHandle,
  type EmbeddedRunWaiter,
} from "./run-state.js";

export function waitForCurrentEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null,
  handle?: EmbeddedAgentQueueHandle,
  signal?: AbortSignal,
): Promise<boolean> {
  const isHandleActive = () =>
    handle ? ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle : ACTIVE_EMBEDDED_RUNS.has(sessionId);
  if (!isHandleActive()) {
    return handle ? Promise.resolve(true) : waitForReplyRunEndBySessionId(sessionId, timeoutMs);
  }
  const timeoutLabel = timeoutMs === null ? "none" : String(timeoutMs);
  diag.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutLabel}`);
  return new Promise((resolve) => {
    const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set();
    let settled = false;
    const finish = (ended: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      waiters.delete(waiter);
      if (waiters.size === 0 && EMBEDDED_RUN_WAITERS.get(sessionId) === waiters) {
        EMBEDDED_RUN_WAITERS.delete(sessionId);
      }
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(ended);
    };
    const onAbort = () => finish(false);
    const waiter: EmbeddedRunWaiter = { resolve: finish, handle };
    if (timeoutMs !== null) {
      waiter.timer = setTimeout(
        () => {
          diag.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
          finish(false);
        },
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    waiters.add(waiter);
    EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    } else if (!isHandleActive()) {
      finish(true);
    }
  });
}

export async function waitForEmbeddedAgentRunEnd(
  sessionId: string,
  timeoutMs: number | null = 15_000,
): Promise<boolean> {
  if (!sessionId) {
    return true;
  }
  const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;
  while (isEmbeddedAgentRunActive(sessionId)) {
    const remainingMs = deadline === undefined ? null : deadline - Date.now();
    if (
      (remainingMs !== null && remainingMs <= 0) ||
      !(await waitForCurrentEmbeddedAgentRunEnd(sessionId, remainingMs))
    ) {
      return false;
    }
  }
  return true;
}

export function notifyEmbeddedRunEnded(
  sessionId: string,
  endedHandle: EmbeddedAgentQueueHandle,
  aborted = false,
) {
  notifyGatewayWorkMetricsChanged();
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
  if (!waiters || waiters.size === 0) {
    return;
  }
  const sessionIdle = !ACTIVE_EMBEDDED_RUNS.has(sessionId);
  diag.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
  for (const waiter of waiters) {
    if (aborted && !waiter.settleOnAbort) {
      continue;
    }
    if (waiter.handle ? waiter.handle !== endedHandle : !sessionIdle) {
      continue;
    }
    waiters.delete(waiter);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(true);
  }
  if (waiters.size === 0) {
    EMBEDDED_RUN_WAITERS.delete(sessionId);
  }
}
