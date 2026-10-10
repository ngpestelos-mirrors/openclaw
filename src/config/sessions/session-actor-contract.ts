import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "../../state/openclaw-agent-execution-contract.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionEntryUsageUpdate } from "./session-entry-usage.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import type { PendingFinalDeliverySettlementInput } from "./session-pending-final-settlement.js";
import type { PendingInputMutation } from "./session-pending-input-operations.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWatermark,
} from "./session-transcript-context-version.types.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { SessionTurnCommitted, SessionTurnPlan } from "./session-turn.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Physical identity is a locator, never run, placement, or permission authority. */
export type SessionActorTarget = Readonly<{
  database: AgentDatabaseExecutionFileIdentity | AgentDatabaseIncognitoIdentity;
  sessionKey: string;
}>;

/** Sequences are comparable only within one owner epoch. Rehydration creates a new epoch. */
export type SessionActorVersion = Readonly<{ epoch: string; sequence: number }>;

export type SessionActorLifetime = {
  assertCurrent(): void;
  /** Accepted work may still settle after new disclosure has been revoked. */
  assertReadable(): void;
};

/** Host-owned live authority, rechecked at both synchronous admission boundaries. */
export type SessionActorAuthority = {
  assertCurrent(): void;
  authorize(stage: "transaction" | "commit", facts: SessionActorHotState): void;
};

/** Complete hot facts. Cold/off-path payloads stay with the bounded history reader. */
export type SessionActorHotState = {
  target: SessionActorTarget;
  version: SessionActorVersion;
  /** In-process writer receipt revision, not a SQLite foreign-commit observation. */
  writeToken: string;
  /** Includes the canonical turn, lifecycle, recovery, and pendingFinalDelivery fields. */
  entry: SessionEntry | undefined;
  participants: SessionParticipantRecord[];
  members: SessionMember[];
  pendingInputs: Array<Omit<SessionPendingInputRow, "message_json">>;
  transcript: {
    watermark: SessionTranscriptWatermark;
    version: SessionTranscriptContextVersion;
    anchors: TranscriptEntryAnchor[];
    idempotency: Array<{ key: string; eventId: string; rawSeq: number }>;
    /** Exact ordered active context membership, including an explicitly empty context. */
    modelContext:
      | { kind: "resident"; entries: Array<{ rawSeq: number; eventId: string | null }> }
      | { kind: "unavailable"; reason: "cold" | "projection"; generation: string | null };
  };
};

/** Serializable, pure bookkeeping. These reducers cannot change session identity or authority. */
export type SessionActorReducer =
  | { kind: "activity"; updatedAt: number }
  | { kind: "usage"; update: SessionEntryUsageUpdate; updatedAt: number }
  | { kind: "group-intro"; needsSystemIntro: boolean }
  | { kind: "fallback-notice"; notice: SessionEntry["fallbackNotice"] }
  | {
      kind: "live-model";
      expected: Pick<SessionEntry, "modelProvider" | "model" | "agentHarnessId">;
      next: Pick<SessionEntry, "modelProvider" | "model" | "agentHarnessId">;
    };

export type SessionActorCommandContext = {
  commandId: string;
  phaseId: string;
  expected: SessionActorVersion;
  reducers?: readonly SessionActorReducer[];
};

export type SessionActorPhaseInputs = {
  acceptInput: {
    pending: Extract<PendingInputMutation, { kind: "stage" }>;
    expectedState: SessionTranscriptTurnExpectedState;
    lifecycle: SessionTranscriptTurnLifecyclePatch;
    /** Admission and adoption may share a durable point only before any intervening effect. */
    turn?: SessionTurnPlan;
  };
  adoptRun: {
    sessionId: string;
    expectedState: SessionTranscriptTurnExpectedState;
    lifecycle: SessionTranscriptTurnLifecyclePatch;
  };
  appendToolResult: { turn: SessionTurnPlan };
  appendTranscriptEvent: {
    sessionId: string;
    lifecycleRevision: string | null;
    writerRunId?: string;
    ownerSources?: SessionSourcePredicate[];
    eventJson: string;
  };
  completeTurn: {
    turn: SessionTurnPlan;
    completion?: Extract<PendingInputMutation, { kind: "complete" }>;
  };
  deliveryPending: {
    sessionId: string;
    expectedState: SessionTranscriptTurnExpectedState;
    lifecycle: SessionTranscriptTurnLifecyclePatch & {
      restartRecoveryDeliveryReceiptState: "terminal-pending";
    };
  };
  deliverySettled: { settlement: PendingFinalDeliverySettlementInput };
  patch: { reducers: readonly SessionActorReducer[] };
};

export type SessionActorPhase = keyof SessionActorPhaseInputs;

export type SessionActorPhaseResults = {
  acceptInput: { inputId: string; turn?: SessionTurnCommitted };
  adoptRun: undefined;
  appendToolResult: SessionTurnCommitted;
  appendTranscriptEvent: { anchor?: TranscriptEntryAnchor };
  completeTurn: SessionTurnCommitted;
  deliveryPending: undefined;
  deliverySettled: { state: PendingFinalDeliverySettlementInput["state"] | "stale" };
  patch: undefined;
};

export type SessionActorReceipt = {
  kind: "session-actor-committed";
  commandId: string;
  phaseId: string;
  phase: SessionActorPhase;
  beforeVersion: SessionActorVersion;
  /** Complete detached postimage, installed on MAIN before acknowledgement. */
  postimage: SessionActorHotState;
};

export type SessionActorSettlement = "committed" | "rolled-back" | "unknown";

export type SessionActorOutcome<Value> =
  | { kind: "committed"; value: Value; receipt: SessionActorReceipt }
  | { kind: "rolled-back"; error: { name: string; message: string } }
  | {
      kind: "unknown";
      target: SessionActorTarget;
      commandId: string;
      error: { name: string; message: string };
    };

export type SessionActorOperations = {
  [Phase in SessionActorPhase as `session.actor.${Phase}`]: {
    input: SessionActorCommandContext &
      SessionActorPhaseInputs[Phase] & {
        target: SessionActorTarget;
      };
    output: SessionActorOutcome<SessionActorPhaseResults[Phase]>;
  };
} & {
  "session.actor.read": {
    input: { target: SessionActorTarget };
    output: SessionActorHotState;
  };
};

type SessionActorCommands = {
  [Phase in SessionActorPhase]: (
    input: SessionActorCommandContext & SessionActorPhaseInputs[Phase],
    authority: SessionActorAuthority,
  ) => Promise<SessionActorOutcome<SessionActorPhaseResults[Phase]>>;
};

/**
 * One command is one synchronous writer transaction. No mailbox hold crosses an await.
 * Unknown outcomes fence disclosure until read() reconciles; commands are never replayed.
 * A receipt is commit evidence, not live authority for the caller's next external effect.
 */
export type SessionActor = SessionActorLifetime &
  SessionActorCommands & {
    readonly target: SessionActorTarget;
    read(authority: SessionActorAuthority): Promise<SessionActorHotState>;
    /**
     * Retain lifetime, not FIFO. Reducers ride the next command in this phase;
     * any remainder commits before the phase settles, including exceptional exits.
     */
    withPhase<T>(
      phaseId: string,
      authority: SessionActorAuthority,
      operation: (phase: {
        actor: SessionActor;
        patch(reducers: readonly SessionActorReducer[]): void;
      }) => Promise<T>,
    ): Promise<T>;
  };
