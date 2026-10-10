import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import { isAgentLifecycleYieldedWaiting } from "../../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { projectMainSessionRecoveryLifecycle } from "../../agents/main-session-recovery/main-session-recovery-lifecycle.js";
import { parseCronRunScopeSuffix } from "../../sessions/session-key-utils.js";
import { isMainRestartRecoveryCandidate, recordLifecycleFence } from "./restart-recovery-state.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type LifecyclePhase = "start" | "end" | "error";

export type SessionLifecycleEvent = {
  ts: number;
  sessionId?: string;
  controlUiVisible?: boolean;
  isHeartbeat?: boolean;
  contextClaimId?: string;
  runId?: string;
  clientRunId?: string;
  lifecycleGeneration?: string;
  mainSessionRestartRecovery?: true;
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
    error?: unknown;
    errorKind?: unknown;
    executionStarted?: unknown;
    livenessState?: unknown;
    timeoutPhase?: unknown;
    providerStarted?: unknown;
    yielded?: unknown;
    status?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "lastRunError"
  | "lastRunId"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "lastActivityAt"
  | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | keyof LifecycleSessionShape
  | "status"
  | "restartRecoveryRuns"
  | "restartRecoveryForceSafeTools"
  | "mainRestartRecovery"
  | "lifecycleRunId"
>;

type SessionLifecycleSnapshot = Partial<Pick<SessionEntry, keyof LifecycleSessionShape | "status">>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveLifecyclePhase(
  event: Pick<SessionLifecycleEvent, "data">,
): LifecyclePhase | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

const SESSION_STATUS_BY_TERMINAL_CLASSIFICATION = {
  success: "done",
  timeout: "timeout",
  cancellation: "killed",
  failure: "failed",
} as const satisfies Record<
  ReturnType<typeof classifyAgentRunTerminalOutcome>,
  NonNullable<SessionEntry["status"]>
>;

export function resolveTerminalOutcome(event: SessionLifecycleEvent): AgentRunTerminalOutcome {
  return buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase: event.data?.phase === "error" ? "error" : "end",
    data: event.data,
    endedAt: event.data?.endedAt ?? event.ts,
  });
}

export function resolveSettledLifecycleTerminalOutcome(
  event: SessionLifecycleEvent,
): AgentRunTerminalOutcome | undefined {
  const phase = resolveLifecyclePhase(event);
  if (phase !== "end" && phase !== "error") {
    return undefined;
  }
  const outcome = resolveTerminalOutcome(event);
  return isAgentLifecycleYieldedWaiting({
    ...event.data,
    phase,
    stopReason: outcome.stopReason,
  })
    ? undefined
    : outcome;
}

function resolveLifecycleTimestamp(...values: unknown[]): number | undefined {
  return values.find(isFiniteTimestamp);
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

export function deriveSessionLifecycleSnapshot(params: {
  session?: Partial<Pick<SessionEntry, keyof LifecycleSessionShape>> | null;
  event: SessionLifecycleEvent;
  lastRunError?: string;
}): SessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  const startedAt = resolveLifecycleTimestamp(
    params.event.data?.startedAt,
    existing?.startedAt,
    params.event.ts,
  );
  if (phase === "start") {
    // A start event clears terminal fields from the previous run so UI rows do
    // not show stale runtime/end state while the new run is active.
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: undefined,
      lastRunError: undefined,
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const endedAt = resolveLifecycleTimestamp(params.event.data?.endedAt, params.event.ts);
  const updatedAt = endedAt ?? existing?.updatedAt;
  const terminal = resolveSettledLifecycleTerminalOutcome(params.event);
  // Cancellation must preserve recovery even when the bulk shutdown marker failed.
  // Use the normalized outcome so a prior hard timeout still owns the terminal state.
  const interruptedForRestart =
    terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  const status = interruptedForRestart
    ? "interrupted"
    : terminal
      ? SESSION_STATUS_BY_TERMINAL_CLASSIFICATION[classifyAgentRunTerminalOutcome(terminal)]
      : undefined;
  return {
    updatedAt,
    status,
    lastRunError: interruptedForRestart
      ? "Run interrupted by a Gateway restart."
      : terminal && status
        ? params.lastRunError
        : undefined,
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({ startedAt, endedAt, existingRuntimeMs: existing?.runtimeMs }),
    ...(terminal &&
    !interruptedForRestart &&
    params.event.controlUiVisible === true &&
    params.event.isHeartbeat !== true &&
    endedAt !== undefined
      ? { lastActivityAt: Math.max(existing?.lastActivityAt ?? 0, endedAt) }
      : {}),
    abortedLastRun: interruptedForRestart || status === "killed",
  };
}

function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<Omit<PersistedLifecycleSessionShape, "status">> | null;
  event: SessionLifecycleEvent;
  currentLifecycleGeneration: string;
  lastRunError?: string;
}): Partial<PersistedLifecycleSessionShape> {
  const phase = resolveLifecyclePhase(params.event);
  // Queued request settlement cannot end the turn that owns this session.
  if ((phase === "end" || phase === "error") && params.event.data?.executionStarted === false) {
    return {};
  }
  const snapshot = deriveSessionLifecycleSnapshot({
    session: params.entry,
    event: params.event,
    lastRunError: params.lastRunError,
  });
  const runId = normalizeLifecycleRunId(params.event.runId);
  const snapshotPatch: Partial<PersistedLifecycleSessionShape> = {
    ...snapshot,
    ...(snapshot.status === "interrupted" ? { restartRecoveryForceSafeTools: true } : {}),
  };
  const projection = projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration: params.currentLifecycleGeneration,
    entry: params.entry,
    event: params.event,
    snapshotPatch,
  });
  if (projection.action === "suppress") {
    return {};
  }
  const clientRunId = normalizeLifecycleRunId(params.event.clientRunId) ?? runId;
  // Execution ownership survives yielded outcomes until the continuation settles.
  return {
    ...projection.patch,
    ...(phase === "start"
      ? { lifecycleRunId: runId, lastRunId: undefined }
      : projection.patch.status && resolveSettledLifecycleTerminalOutcome(params.event)
        ? { lifecycleRunId: undefined, lastRunId: clientRunId }
        : {}),
  };
}

export function deriveSessionLifecycleProjectionPatch(params: {
  entry?: Partial<Omit<PersistedLifecycleSessionShape, "status">> | null;
  event: SessionLifecycleEvent;
  currentLifecycleGeneration: string;
  lastRunError?: string;
}): SessionLifecycleSnapshot {
  const {
    restartRecoveryRuns: _restartRecoveryRuns,
    restartRecoveryForceSafeTools: _restartRecoveryForceSafeTools,
    lifecycleRunId: _lifecycleRunId,
    ...patch
  } = derivePersistedSessionLifecyclePatch(params);
  return patch;
}

/**
 * Reject pre-reset runs and explicitly older runs sharing one session so late
 * lifecycle events cannot overwrite a newer run's authoritative state.
 */
export function isStaleLifecycleEventForSession(params: {
  owningSessionId?: string;
  currentSessionId?: string;
  eventRunId?: unknown;
  currentRunId?: unknown;
  eventStartedAt?: unknown;
  currentStartedAt?: number;
}): boolean {
  if (
    params.owningSessionId &&
    params.currentSessionId &&
    params.owningSessionId !== params.currentSessionId
  ) {
    return true;
  }
  const eventRunId = normalizeLifecycleRunId(params.eventRunId);
  const currentRunId = normalizeLifecycleRunId(params.currentRunId);
  // Matching ownership is stronger than producer timestamps. Missing or
  // different identities retain the legacy timestamp fence.
  if (eventRunId && currentRunId && eventRunId === currentRunId) {
    return false;
  }
  return (
    isFiniteTimestamp(params.eventStartedAt) &&
    isFiniteTimestamp(params.currentStartedAt) &&
    params.eventStartedAt < params.currentStartedAt
  );
}

function acceptsCronRunContinuationLifecycleEvent(params: {
  entry: SessionEntry;
  event: SessionLifecycleEvent;
}): boolean {
  const marker = params.entry.cronRunContinuation;
  if (marker?.phase === "running") {
    return true;
  }
  const runId = params.event.runId?.trim();
  return Boolean(marker?.phase === "continuing" && runId && marker.ownerRunId === runId);
}

export type SessionLifecycleEventPatchInput = {
  sessionKey: string;
  event: SessionLifecycleEvent;
  currentLifecycleGeneration: string;
  expectedWriter?: {
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
  lastRunError?: string;
};

/** Evaluates lifecycle ownership against the writer's current row. */
export function projectSessionLifecycleEvent(
  entry: SessionEntry,
  lifecycle: SessionLifecycleEventPatchInput,
): Partial<SessionEntry> | null {
  const phase = resolveLifecyclePhase(lifecycle.event);
  if (!phase) {
    return null;
  }
  const owningSessionId = lifecycle.event.sessionId || undefined;
  const exactCronRun = parseCronRunScopeSuffix(lifecycle.sessionKey).runId !== undefined;
  const expected = lifecycle.expectedWriter;
  if (
    expected &&
    (entry.sessionId !== expected.sessionId ||
      entry.lifecycleRevision !== expected.lifecycleRevision ||
      (entry.activeWriterRunId !== expected.runId && entry.lifecycleRunId !== expected.runId) ||
      (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== expected.runId) ||
      (entry.lifecycleRunId !== undefined && entry.lifecycleRunId !== expected.runId))
  ) {
    return null;
  }
  if (
    exactCronRun &&
    !acceptsCronRunContinuationLifecycleEvent({ entry, event: lifecycle.event })
  ) {
    // Exact cron rows transfer lifecycle ownership from the initial run to
    // one claimed continuation. Ready or replaced claims reject late events.
    return null;
  }
  if (
    isStaleLifecycleEventForSession({
      owningSessionId,
      currentSessionId: entry.sessionId,
      eventRunId: lifecycle.event.runId,
      currentRunId: entry.lifecycleRunId,
      eventStartedAt: lifecycle.event.data?.startedAt,
      currentStartedAt: entry.startedAt,
    })
  ) {
    return null;
  }
  const eventRunId = normalizeLifecycleRunId(lifecycle.event.runId);
  const eventClientRunId = normalizeLifecycleRunId(lifecycle.event.clientRunId);
  const terminalRunId = normalizeLifecycleRunId(entry.lastRunId);
  if (
    phase === "start" &&
    terminalRunId !== undefined &&
    (eventRunId === terminalRunId || eventClientRunId === terminalRunId)
  ) {
    // A delayed start from a terminalized run must not reopen the row after
    // its end write commits; lifecycle events are delivered in order, but
    // their async persistence can settle out of order.
    return null;
  }
  const patch: Partial<SessionEntry> = derivePersistedSessionLifecyclePatch({
    entry,
    event: lifecycle.event,
    currentLifecycleGeneration: lifecycle.currentLifecycleGeneration,
    lastRunError: lifecycle.lastRunError,
  });
  if (
    eventRunId &&
    isMainRestartRecoveryCandidate(entry, lifecycle.sessionKey) &&
    (patch.status === "interrupted" || (phase === "start" && patch.lifecycleRunId === eventRunId))
  ) {
    // Source-less starts and restart aborts arm custody in their existing write.
    patch.restartRecoveryRuns = entry.restartRecoveryRuns;
    recordLifecycleFence(patch, {
      runId: eventRunId,
      lifecycleGeneration:
        lifecycle.event.lifecycleGeneration ?? lifecycle.currentLifecycleGeneration,
    });
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
