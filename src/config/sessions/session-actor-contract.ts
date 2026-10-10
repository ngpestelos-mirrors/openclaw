import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "../../state/openclaw-agent-execution-contract.js";
import type { RestartRecoveryTerminalDeliveryClaim } from "./restart-recovery-receipt-state.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type {
  SessionPendingInputRow,
  SessionPendingInputWorkerReceipt,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionEntryBookkeepingReducer } from "./session-entry-patch-operation.js";
import type {
  InitialSessionEntryCommit,
  SessionMetadataOperations,
} from "./session-manager-write-contract.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import type { PendingFinalDeliverySettlementInput } from "./session-pending-final-settlement.js";
import type {
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputSnapshot,
} from "./session-pending-input-operations.types.js";
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
  authorize(
    stage: "transaction" | "commit",
    facts: SessionActorHotState,
    /** Existing kernel source/custody evidence remains subject to its owner's checks. */
    publication?: unknown,
  ): void;
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
    /** Empty anchors prove absence only when this exact projection is resident. */
    anchorsState: "resident" | "unavailable";
    anchors: TranscriptEntryAnchor[];
    idempotency: Array<{ key: string; eventId: string; rawSeq: number }>;
    /** Exact ordered active context membership, including an explicitly empty context. */
    modelContext:
      | { kind: "resident"; entries: Array<{ rawSeq: number; eventId: string | null }> }
      | { kind: "unavailable"; reason: "cold" | "projection"; generation: string | null };
  };
};

/** Serializable, pure bookkeeping. These reducers cannot change session identity or authority. */
export type SessionActorReducer = SessionEntryBookkeepingReducer;

export type SessionActorCommandContext = {
  commandId: string;
  phaseId: string;
  expected: SessionActorVersion;
  reducers?: readonly SessionActorReducer[];
};

/** Reuse SessionManager's prepared bytes, envelope, view limits, and admission predicates. */
export type SessionActorAppend = (
  | {
      kind: "metadata";
      input: SessionMetadataOperations["session.metadata.append"]["input"];
    }
  | {
      kind: "message";
      input: SessionMetadataOperations["session.transcript.appendMessage"]["input"];
    }
) & {
  /** First-writer ownership is verified live; a run ID alone never grants it. */
  initialization?: SessionMetadataOperations["session.metadata.initialize"]["input"];
  /** Optional prepared session header, committed atomically before this append. */
  header?: SessionMetadataOperations["session.metadata.append"]["input"];
};

/** The original snapshot preserves canonical adopted IDs, parents, bytes, and versions. */
export type SessionActorAppendCommitted = (
  | {
      kind: "metadata";
      value: SessionMetadataOperations["session.metadata.append"]["output"];
    }
  | {
      kind: "message";
      value: SessionMetadataOperations["session.transcript.appendMessage"]["output"];
    }
) & {
  initialEntry?: InitialSessionEntryCommit;
  header?: SessionMetadataOperations["session.metadata.append"]["output"];
};

export type SessionActorInputRecovery = {
  /** Compare source fields and membership against this transaction's current state. */
  sources: SessionSourcePredicate[];
  expectedRunId: string;
  harnessCompletion?: HarnessCompletionRecovery;
};

export type SessionActorPendingFinalDelivery = NonNullable<SessionEntry["pendingFinalDelivery"]> & {
  intentId: string;
  deliveries: NonNullable<NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"]>;
};

/** Already validated by the host; live authority is checked again at commit. */
export type SessionActorDeliveryEvidence = {
  claim: HarnessCompletionRecovery;
  result?: { channel: string; target?: { id: string }; platformMessageId?: string };
};

export type SessionActorPhaseInputs = {
  acceptInput: {
    pending: Extract<PendingInputMutation, { kind: "stage" }>;
    expectedState: SessionTranscriptTurnExpectedState;
    lifecycle: SessionTranscriptTurnLifecyclePatch;
    /** Admission and adoption may share a durable point only before any intervening effect. */
    turn?: SessionTurnPlan;
    /** A retry adopts the canonical pending/transcript identity instead of appending twice. */
    append?: SessionActorAppend;
    recovery?: SessionActorInputRecovery;
  };
  adoptRun: {
    sessionId: string;
    expectedState: SessionTranscriptTurnExpectedState;
    lifecycle: SessionTranscriptTurnLifecyclePatch;
    /** Explicit writer adoption; omission preserves the existing lifecycle-only command. */
    runId?: string;
  };
  appendToolResult:
    | { turn: SessionTurnPlan; append?: never }
    | { append: SessionActorAppend; turn?: never };
  appendTranscriptEvent:
    | {
        sessionId: string;
        lifecycleRevision: string | null;
        writerRunId?: string;
        ownerSources?: SessionSourcePredicate[];
        eventJson: string;
        append?: never;
      }
    | { append: SessionActorAppend; eventJson?: never };
  completeTurn: (
    | { turn: SessionTurnPlan; bookkeeping?: never }
    | {
        turn?: never;
        /** The assistant transcript is already durable; this command must not append it again. */
        bookkeeping: {
          sessionId: string;
          lifecycleRevision: string | null;
          writerRunId: string | undefined;
          expectedState: SessionTranscriptTurnExpectedState;
          lifecycle?: SessionTranscriptTurnLifecyclePatch;
        };
      }
  ) & {
    completion?: Extract<PendingInputMutation, { kind: "complete" }>;
    /** Exact delivery intent and payload IDs join terminal accounting in this commit. */
    pendingFinalDelivery?: SessionActorPendingFinalDelivery;
  };
  deliveryPending:
    | {
        sessionId: string;
        expectedState: SessionTranscriptTurnExpectedState;
        lifecycle: SessionTranscriptTurnLifecyclePatch & {
          restartRecoveryDeliveryReceiptState: "terminal-pending";
        };
        claim?: never;
      }
    | { claim: RestartRecoveryTerminalDeliveryClaim; updatedAt: number };
  deliverySettled:
    | {
        settlement: PendingFinalDeliverySettlementInput;
        evidence?: SessionActorDeliveryEvidence;
        restart?: never;
      }
    | {
        settlement?: never;
        restart: {
          claim: RestartRecoveryTerminalDeliveryClaim;
          outcome: "confirmed" | "not-sent";
          updatedAt: number;
        };
      };
  patch: { reducers: readonly SessionActorReducer[] };
};

export type SessionActorPhase = keyof SessionActorPhaseInputs;

export type SessionActorPhaseResults = {
  acceptInput: {
    inputId: string;
    turn?: SessionTurnCommitted;
    append?: SessionActorAppendCommitted;
    adoption?: Pick<PendingInputSnapshot, "existing" | "previous" | "committed">;
    pendingInputReceipt?: PendingInputMutationReceipt;
  };
  adoptRun: undefined;
  appendToolResult: SessionTurnCommitted | SessionActorAppendCommitted;
  appendTranscriptEvent: { anchor?: TranscriptEntryAnchor } | SessionActorAppendCommitted;
  completeTurn: SessionTurnCommitted | { kind: "bookkeeping" };
  deliveryPending:
    | undefined
    | {
        disposition:
          | "started"
          | "already-delivered"
          | "delivery-ambiguous"
          | "stale"
          | "not-applicable";
      };
  deliverySettled:
    | { state: PendingFinalDeliverySettlementInput["state"] | "stale"; wakeRecovery: boolean }
    | { disposition: "recorded" | "cleared" | "stale" };
  patch: undefined;
};

export type SessionActorReducerOutcome = {
  index: number;
  kind: SessionActorReducer["kind"];
  changed: boolean;
  /** Only pure best-effort usage preparation/reduction can be skipped. Writes remain atomic. */
  failure?: { name: string; message: string };
};

export type SessionActorReceipt = {
  kind: "session-actor-committed";
  commandId: string;
  phaseId: string;
  phase: SessionActorPhase;
  beforeVersion: SessionActorVersion;
  afterVersion: SessionActorVersion;
  transcript: {
    before: SessionTranscriptContextVersion;
    after: SessionTranscriptContextVersion;
    /** Includes idempotency adoption, not only newly inserted messages. */
    appendedMessages: SessionTurnCommitted["result"]["appendedMessages"];
    append?: SessionActorAppendCommitted;
    projectionNeedsReconcile: boolean;
  };
  pendingInputReceipt?: SessionPendingInputWorkerReceipt;
  pendingInputMutationReceipt?: PendingInputMutationReceipt;
  pendingFinalDelivery?: SessionEntry["pendingFinalDelivery"];
  reducers: SessionActorReducerOutcome[];
  /** Complete detached postimage, installed on MAIN before acknowledgement. */
  postimage: SessionActorHotState;
};

export type SessionActorSettlement = "committed" | "rolled-back" | "unknown";

export type SessionActorOutcome<Value> =
  | {
      kind: "committed";
      value: Value;
      receipt: SessionActorReceipt;
      /** Publication/cleanup failure cannot erase a captured durable receipt. */
      failure?: { name: string; message: string };
    }
  | {
      kind: "rolled-back";
      error: { name: string; message: string };
      reason?: "stale-version" | "stale-state";
    }
  | {
      kind: "unknown";
      target: SessionActorTarget;
      commandId: string;
      error: { name: string; message: string };
    };

export type SessionActorCommitObserver<Value> = {
  /** Called once with captured native evidence before fallible publication or cleanup. */
  committed(outcome: Extract<SessionActorOutcome<Value>, { kind: "committed" }>): void;
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
    observer?: SessionActorCommitObserver<SessionActorPhaseResults[Phase]>,
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
    /** Detached installed MAIN state; undefined means fenced/missing. Never opens SQLite or dispatches a worker request. */
    snapshot(authority: SessionActorAuthority): SessionActorHotState | undefined;
    read(authority: SessionActorAuthority): Promise<SessionActorHotState>;
    /** Drain retained attempts and accepted descendants; a teardown timeout is not settlement. */
    release(): Promise<void>;
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

/** Bound to the existing execution owner; acquisition never creates a parallel writer. */
export type SessionActorFactory = {
  acquire(target: SessionActorTarget, lifetime: SessionActorLifetime): Promise<SessionActor>;
};
