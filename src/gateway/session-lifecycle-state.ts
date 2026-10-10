import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString as normalizeLifecycleRunId } from "@openclaw/normalization-core/string-coerce";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { getRuntimeConfig } from "../config/io.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { buildUpdatedSessionGoalStatus } from "../config/sessions/goals-transitions.js";
import { patchSessionEntryTarget } from "../config/sessions/session-accessor.js";
import { applySessionEntryTargetOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  deriveSessionLifecycleProjectionPatch,
  deriveSessionLifecycleSnapshot,
  projectSessionLifecycleEvent,
  resolveLifecyclePhase,
  resolveSettledLifecycleTerminalOutcome,
  resolveTerminalOutcome,
  type LifecyclePhase,
  type SessionLifecycleEvent,
  type SessionLifecycleEventPatchInput,
} from "../config/sessions/session-lifecycle-event.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readAgentRunProviderReview,
  type ProviderReviewTerminalFact,
} from "../sessions/provider-review-terminal.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../sessions/session-run-error.js";
import { runOutsideAsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

const restartRecoveryLog = createSubsystemLogger("main-session-restart-recovery");

export { isStaleLifecycleEventForSession } from "../config/sessions/session-lifecycle-event.js";

function resolveLifecycleLastRunError(event: SessionLifecycleEvent): string | undefined {
  const terminal = resolveSettledLifecycleTerminalOutcome(event);
  if (!terminal) {
    return undefined;
  }
  const classification = classifyAgentRunTerminalOutcome(terminal);
  return classification === "failure" || classification === "timeout"
    ? resolveSessionRunError(
        { ...terminal, errorKind: event.data?.errorKind },
        classification === "failure" ? "failed" : "timeout",
      )
    : undefined;
}

export function deriveGatewaySessionLifecycleSnapshot(
  params: Omit<Parameters<typeof deriveSessionLifecycleSnapshot>[0], "lastRunError">,
) {
  return deriveSessionLifecycleSnapshot({
    ...params,
    lastRunError: resolveLifecycleLastRunError(params.event),
  });
}

export function deriveGatewaySessionLifecycleProjectionPatch(
  params: Omit<
    Parameters<typeof deriveSessionLifecycleProjectionPatch>[0],
    "currentLifecycleGeneration" | "lastRunError"
  >,
) {
  return deriveSessionLifecycleProjectionPatch({
    ...params,
    currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    lastRunError: resolveLifecycleLastRunError(params.event),
  });
}

function matchesProviderReviewWriter(
  entry: SessionEntry,
  fact: ProviderReviewTerminalFact,
): boolean {
  return (
    entry.sessionId === fact.target.sessionId &&
    entry.lifecycleRevision === fact.target.lifecycleRevision &&
    (entry.activeWriterRunId === fact.expectedWriterRunId ||
      entry.lifecycleRunId === fact.expectedWriterRunId) &&
    (entry.activeWriterRunId === undefined ||
      entry.activeWriterRunId === fact.expectedWriterRunId) &&
    (entry.lifecycleRunId === undefined || entry.lifecycleRunId === fact.expectedWriterRunId) &&
    (!entry.providerReview || isDeepStrictEqual(entry.providerReview, fact.review))
  );
}

type GatewaySessionLifecycleEventParams = {
  sessionKey: string;
  agentId?: string;
  event: SessionLifecycleEvent;
  assertCommitAllowed?: () => void;
  expectedWriter?: {
    runId: string;
    sessionId: string;
    lifecycleRevision?: string;
  };
};

export async function persistGatewaySessionLifecycleEvent(
  params: GatewaySessionLifecycleEventParams,
): Promise<void> {
  await runOutsideAsyncWorkScope(() => prepareGatewaySessionLifecycleEvent(params)());
}

/** Capture lookup custody before the lifecycle owner waits for an earlier event. */
export function prepareGatewaySessionLifecycleEvent(params: GatewaySessionLifecycleEventParams) {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return async () => {};
  }
  const prepared = loadGatewaySessionEntryReadOnlyInWorker({
    cfg: getRuntimeConfig(),
    key: params.sessionKey,
    excludeInternalEffects: true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  // Queue waits must not leave an early read rejection unobserved.
  void prepared.catch(() => undefined);
  return async () => persistPreparedGatewaySessionLifecycleEvent(params, phase, await prepared);
}

async function persistPreparedGatewaySessionLifecycleEvent(
  params: GatewaySessionLifecycleEventParams,
  phase: LifecyclePhase,
  sessionEntry: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
): Promise<void> {
  if (!sessionEntry.entry) {
    return;
  }
  // Incognito keeps its existing native lifecycle writer. The runtime's private fact
  // joins that same entry update; public event data cannot introduce a review pause.
  const terminalReview =
    (phase === "error" || (phase === "end" && params.event.data?.stopReason === "error")) &&
    isIncognitoSessionKey(sessionEntry.canonicalKey) &&
    params.event.runId
      ? readAgentRunProviderReview(params.event.runId)
      : undefined;
  const providerReview =
    terminalReview &&
    terminalReview.target.sessionKey === sessionEntry.canonicalKey &&
    terminalReview.target.storePath === sessionEntry.storePath &&
    terminalReview.target.sessionId === params.event.sessionId &&
    terminalReview.review.runId === params.event.runId &&
    terminalReview.lifecycleGeneration === params.event.lifecycleGeneration &&
    params.event.ts >= terminalReview.capturedAtMs &&
    (terminalReview.lifecycleStartedAt === undefined ||
      terminalReview.lifecycleStartedAt === params.event.data?.startedAt) &&
    matchesProviderReviewWriter(sessionEntry.entry, terminalReview)
      ? terminalReview
      : undefined;
  const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
  const lifecycle: SessionLifecycleEventPatchInput = {
    sessionKey: sessionEntry.canonicalKey,
    // Agent events hide internal ownership from public serialization. Copy those
    // facts explicitly into this private worker command before structuredClone.
    event: {
      ts: params.event.ts,
      sessionId: params.event.sessionId,
      controlUiVisible: params.event.controlUiVisible,
      isHeartbeat: params.event.isHeartbeat,
      contextClaimId: params.event.contextClaimId,
      runId: params.event.runId,
      clientRunId: params.event.clientRunId,
      lifecycleGeneration: params.event.lifecycleGeneration,
      mainSessionRestartRecovery: params.event.mainSessionRestartRecovery,
      data: params.event.data
        ? {
            phase: params.event.data.phase,
            startedAt: params.event.data.startedAt,
            endedAt: params.event.data.endedAt,
            aborted: params.event.data.aborted,
            stopReason: params.event.data.stopReason,
            error: params.event.data.error,
            errorKind: params.event.data.errorKind,
            executionStarted: params.event.data.executionStarted,
            livenessState: params.event.data.livenessState,
            timeoutPhase: params.event.data.timeoutPhase,
            providerStarted: params.event.data.providerStarted,
            yielded: params.event.data.yielded,
            status: params.event.data.status,
          }
        : undefined,
    },
    currentLifecycleGeneration,
    expectedWriter: params.expectedWriter,
    lastRunError: resolveLifecycleLastRunError(params.event),
  };
  const pureLifecycle =
    !providerReview &&
    params.event.data?.error == null &&
    (phase === "start" ||
      (phase === "end" &&
        classifyAgentRunTerminalOutcome(resolveTerminalOutcome(params.event)) === "success" &&
        params.event.mainSessionRestartRecovery !== true));
  let terminalRecovery: { runId: string; outcome: AgentRunTerminalOutcome } | undefined;
  let failedRun: { runId: string; error: unknown; errorKind?: "state_contention" } | undefined;
  const target: Parameters<typeof patchSessionEntryTarget>[0] = {
    agentId: sessionEntry.agentId,
    storePath: sessionEntry.storePath,
    readSource: sessionEntry.capturedReadSource,
    target: {
      canonicalKey: sessionEntry.canonicalKey,
      storeKeys: sessionEntry.storeKeys,
    },
  };
  const update: Parameters<typeof patchSessionEntryTarget>[1] = (entry) => {
    terminalRecovery = undefined;
    failedRun = undefined;
    if (providerReview && !matchesProviderReviewWriter(entry, providerReview)) {
      return null;
    }
    const patch = projectSessionLifecycleEvent(entry, {
      ...lifecycle,
      event: params.event,
      currentLifecycleGeneration: getAgentEventLifecycleGeneration(),
    });
    if (!patch) {
      return null;
    }
    const eventRunId = normalizeLifecycleRunId(params.event.runId);
    if (providerReview && Object.keys(patch).length > 0) {
      patch.providerReview = providerReview.review;
    }
    const endedAt = patch.endedAt ?? params.event.ts;
    if (
      (patch.status === "failed" || patch.status === "timeout") &&
      entry.goal?.status === "active" &&
      entry.goal.updatedAt <= endedAt
    ) {
      // The terminal owner has exhausted retries. Commit the pause with the run
      // failure so every client sees the same stopped goal and frozen timer.
      // A delayed failure must not undo a newer resume or replacement goal.
      patch.goal = buildUpdatedSessionGoalStatus(
        entry,
        {
          status: "paused",
          note: `Paused after an error. Resume to continue. ${patch.lastRunError ?? (patch.status === "timeout" ? "Run timed out." : "Run failed.")}`,
        },
        endedAt,
      );
    }
    if (
      (phase === "error" || phase === "end") &&
      eventRunId &&
      (patch.status === "failed" || patch.status === "timeout")
    ) {
      failedRun = {
        runId: eventRunId,
        errorKind:
          params.event.data?.errorKind === "state_contention" ? "state_contention" : undefined,
        error:
          resolveTerminalOutcome(params.event).error ??
          (patch.status === "timeout" ? "Run timed out" : undefined),
      };
    }
    const recoveryTerminalIsCurrent =
      params.event.mainSessionRestartRecovery === true &&
      params.event.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
      eventRunId !== undefined &&
      (phase === "end" || phase === "error");
    const terminalOutcome = recoveryTerminalIsCurrent
      ? resolveSettledLifecycleTerminalOutcome(params.event)
      : undefined;
    if (terminalOutcome && eventRunId && Object.keys(patch).length > 0) {
      terminalRecovery = {
        runId: eventRunId,
        outcome: terminalOutcome,
      };
    }
    return patch;
  };
  const options: NonNullable<Parameters<typeof patchSessionEntryTarget>[2]> = {
    skipMaintenance: true,
    takeCacheOwnership: true,
    requireWriteSuccess: true,
    workerGuard: {
      ...(pureLifecycle
        ? {
            assertCurrent: () =>
              assertAgentRunLifecycleGenerationCurrent(currentLifecycleGeneration),
          }
        : {}),
      source: composeSessionSourceAssertion([
        params.assertCommitAllowed,
        providerReview?.assertCurrent,
      ]),
    },
    ...(providerReview ? { providerReviewMutation: true } : {}),
    onCommitted: () =>
      sessionChanges.emit({
        sessionKey: sessionEntry.canonicalKey,
        agentId: sessionEntry.agentId,
        storePath: sessionEntry.storePath,
        // The writer already published stored facts; this adapter only projects run state.
        scope: "runtime",
        facts: { kind: "unchanged" },
      }),
  };
  const persisted = pureLifecycle
    ? await applySessionEntryTargetOperation(
        target,
        { kind: "lifecycle-event", lifecycle },
        options,
      )
    : await patchSessionEntryTarget(target, update, options);
  if (persisted && terminalRecovery) {
    const message = `main-session restart recovery terminal: session=${sessionEntry.canonicalKey} run=${terminalRecovery.runId} status=${terminalRecovery.outcome.status} reason=${terminalRecovery.outcome.reason}`;
    restartRecoveryLog[terminalRecovery.outcome.status === "ok" ? "info" : "warn"](message);
  }
  if (persisted && failedRun) {
    const { runId, error, errorKind } = failedRun;
    // Only accepted errors pay for branch navigation; assistant detection and
    // report deduplication share the appender's authoritative write snapshot.
    const receipt = {
      target: {
        agentId: sessionEntry.agentId,
        storePath: sessionEntry.storePath,
        sessionKey: sessionEntry.canonicalKey,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
        expectedWriterRunId: persisted.activeWriterRunId,
      },
      runId,
      error,
      errorKind,
      assertCommitAllowed: params.assertCommitAllowed,
    };
    // An accepted terminal owns its receipt, independently of an ambient requester turn.
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: receipt.target,
        assertCommitAllowed: params.assertCommitAllowed,
        withTranscriptWrite: trackAsyncWork,
      },
      () => recordGatewaySessionRunFailure(receipt),
    );
  }
}
