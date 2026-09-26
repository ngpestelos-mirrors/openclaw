import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseOperations } from "../../state/openclaw-agent-execution-contract.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { PendingInputIdentity } from "./session-accessor.pending-inputs.read.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import {
  hasSessionPendingInputOwner,
  readSessionInputCompletion,
  readSessionPendingInputByKey,
  writeSessionInputCompletion,
  type SessionPendingInputRow,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";

export type PendingInputStageRead = {
  idempotencyKey: string;
  trackCompletion?: boolean;
  runId?: string;
  requestHash?: string;
};
export type PendingInputStageSnapshot = {
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: ReturnType<typeof readTranscriptMessageByScopedIdempotencyKey>;
  source: CapturedSessionEntryReadSource;
};
export const pendingInputStageNeedsWorker = Symbol("pending-input-stage-needs-worker");
export type PendingInputAlreadyAdmitted = {
  kind: "already-admitted";
  identity: PendingInputIdentity;
  source: CapturedSessionEntryReadSource;
};
type PendingInputReadDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;
export type PendingInputStageCommit = PendingInputStageRead & {
  snapshot: PendingInputStageSnapshot;
  inputId: string;
  runId: string;
  requestHash: string;
  messageJson: string;
  lifecycleGeneration: string;
};
export type PendingInputCompletion = {
  idempotencyKey: string;
  runId: string;
  requestHash: string;
  lifecycleGeneration: string;
  outcome: AgentRunTerminalOutcome;
};
export type PendingInputFinish = {
  inputId: string;
  lifecycleGeneration: string;
  disposition: Exclude<SessionPendingInputState, "queued">;
};

type PendingInputWorkerCommand = Extract<
  SqliteWorkerCommand<AgentDatabaseOperations>,
  { type: `session.pendingInput.${string}` }
>;
type PendingInputWorkerResult =
  AgentDatabaseOperations[PendingInputWorkerCommand["type"]]["output"];

export function runSessionPendingInputWorkerCommand(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  command: PendingInputWorkerCommand,
  admit: (stage: "transaction" | "commit") => void,
): PendingInputWorkerResult {
  if (command.type === "session.pendingInput.read" && !command.input.trackCompletion) {
    return runSqliteDeferredTransactionSync(database.db, () =>
      readSessionPendingInputStage(database, command.input.resolved, command.input),
    );
  }
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Pending input lost its canonical database owner");
      }
      admit("transaction");
      const result = (() => {
        switch (command.type) {
          case "session.pendingInput.read":
            return readSessionPendingInputStage(current, command.input.resolved, command.input);
          case "session.pendingInput.stage":
            return commitSessionPendingInputStage(current, command.input.resolved, command.input);
          case "session.pendingInput.complete":
            return completeSessionPendingInputInDatabase(
              current,
              command.input.resolved,
              command.input,
            );
          case "session.pendingInput.finish":
            return finishSessionPendingInputInDatabase(current, command.input);
          case "session.pendingInput.repair":
            return repairSessionPendingInputRowsInDatabase(current, command.input.rows);
        }
      })();
      admit("commit");
      return result;
    },
    options,
    { operationLabel: command.type },
  );
}

export function readSessionPendingInputStage(
  database: PendingInputReadDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageRead,
  maxBytes: number,
):
  | PendingInputStageSnapshot
  | typeof pendingInputStageNeedsWorker
  | PendingInputAlreadyAdmitted
  | undefined;
export function readSessionPendingInputStage(
  database: PendingInputReadDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageRead,
): PendingInputStageSnapshot | undefined;
/** The caller holds one snapshot; completion schema preparation requires a writer. */
export function readSessionPendingInputStage(
  database: PendingInputReadDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageRead,
  maxBytes?: number,
):
  | PendingInputStageSnapshot
  | typeof pendingInputStageNeedsWorker
  | PendingInputAlreadyAdmitted
  | undefined {
  const db = getSessionKysely(database.db);
  let bytes = 0;
  if (maxBytes !== undefined) {
    if (request.trackCompletion) {
      return pendingInputStageNeedsWorker;
    }
    // List projection still parses full entry_json inside SQLite before stripping saved prompts.
    const entry = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_nodes")
        .select((eb) => eb.fn<number>("octet_length", ["entry_json"]).as("bytes"))
        .where("session_key", "=", resolved.sessionKey),
    );
    bytes = entry?.bytes ?? 0;
    if (bytes > maxBytes) {
      return pendingInputStageNeedsWorker;
    }
  }
  if (
    readSessionEntryRow(database, resolved.sessionKey, "list")?.entry.sessionId !==
    resolved.sessionId
  ) {
    return undefined;
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
  const source: CapturedSessionEntryReadSource = {
    agentId: database.agentId,
    path: database.path,
    databaseIdentity: physical.identity,
    databaseBirthtime: physical.birthtime,
  };
  if (maxBytes !== undefined) {
    const pending = hasSessionPendingInputsSchema(database.db)
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_pending_inputs")
            .select([
              "input_id",
              "session_key",
              "session_id",
              "lifecycle_generation",
              "run_id",
              "request_hash",
            ])
            .select((eb) => [
              hasPendingInputConsumptionColumn(database.db)
                ? "consumed_event_id"
                : eb.val(null).as("consumed_event_id"),
            ])
            .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
            .where("session_key", "=", resolved.sessionKey)
            .where("session_id", "=", resolved.sessionId)
            .where("idempotency_key", "=", request.idempotencyKey),
        )
      : undefined;
    if (
      pending &&
      pending.run_id === request.runId &&
      pending.request_hash === request.requestHash &&
      pending.consumed_event_id == null &&
      hasSessionPendingInputOwner(database.path, pending)
    ) {
      return {
        kind: "already-admitted",
        identity: {
          input_id: pending.input_id,
          session_key: pending.session_key,
          session_id: pending.session_id,
          lifecycle_generation: pending.lifecycle_generation,
        },
        source,
      };
    }
    bytes += pending?.bytes ?? 0;
    if (bytes > maxBytes) {
      return pendingInputStageNeedsWorker;
    }
    const transcript = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "identity.session_id")
            .onRef("event.seq", "=", "identity.seq"),
        )
        .select(transcriptEventReadBytesSql("event").as("bytes"))
        .where("identity.session_id", "=", resolved.sessionId)
        .where("identity.message_idempotency_key", "=", request.idempotencyKey)
        .orderBy("identity.seq", "desc")
        .limit(1),
    );
    if (bytes + (transcript?.bytes ?? 0) > maxBytes) {
      return pendingInputStageNeedsWorker;
    }
  }
  if (request.trackCompletion) {
    ensureSessionInputCompletionsSchema(database.db);
  }
  return {
    existing: readSessionPendingInputByKey(database, resolved, request.idempotencyKey),
    previous: request.trackCompletion
      ? readSessionInputCompletion(database, {
          ...resolved,
          idempotencyKey: request.idempotencyKey,
        })
      : undefined,
    committed: readTranscriptMessageByScopedIdempotencyKey(
      database,
      resolved,
      request.idempotencyKey,
      "scan",
    ),
    source,
  };
}

export function commitSessionPendingInputStage(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageCommit,
): boolean {
  assertCapturedSessionEntryReadSource(request.snapshot.source, database);
  if (
    readSessionEntryRow(database, resolved.sessionKey, "list")?.entry.sessionId !==
    resolved.sessionId
  ) {
    return false;
  }
  const { existing, previous } = request.snapshot;
  if (request.trackCompletion) {
    const current = readSessionInputCompletion(database, {
      ...resolved,
      idempotencyKey: request.idempotencyKey,
    });
    if (
      current?.outcome_json !== previous?.outcome_json ||
      current?.request_hash !== previous?.request_hash ||
      current?.run_id !== previous?.run_id ||
      current?.completed_at !== previous?.completed_at
    ) {
      return false;
    }
  }
  // Recheck dedupe after the host approval callback.
  if (
    readTranscriptMessageByScopedIdempotencyKey(database, resolved, request.idempotencyKey, "scan")
  ) {
    return false;
  }
  ensureSessionPendingInputsSchema(database.db);
  if (existing) {
    const result = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_pending_inputs")
        .set({ state: "queued", lifecycle_generation: request.lifecycleGeneration })
        .where("input_id", "=", request.inputId)
        .where("session_key", "=", resolved.sessionKey)
        .where("session_id", "=", resolved.sessionId)
        .where("run_id", "=", request.runId)
        .where("lifecycle_generation", "=", existing.lifecycle_generation)
        .where("request_hash", "=", request.requestHash)
        .where("message_json", "=", existing.message_json)
        .where("state", "=", existing.state)
        .where("consumed_event_id", "is", null),
    );
    return result.numAffectedRows === 1n;
  }
  if (readSessionPendingInputByKey(database, resolved, request.idempotencyKey)) {
    return false;
  }
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db).insertInto("session_pending_inputs").values({
      input_id: request.inputId,
      session_key: resolved.sessionKey,
      session_id: resolved.sessionId,
      idempotency_key: request.idempotencyKey,
      run_id: request.runId,
      request_hash: request.requestHash,
      message_json: request.messageJson,
      lifecycle_generation: request.lifecycleGeneration,
      state: "queued",
      accepted_at: Date.now(),
    }),
  );
  return true;
}

export function completeSessionPendingInputInDatabase(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputCompletion,
): AgentRunTerminalOutcome {
  if (
    readSessionEntryRow(database, resolved.sessionKey, "list")?.entry.sessionId !==
    resolved.sessionId
  ) {
    throw new Error("Input completion no longer owns the admitted session");
  }
  return writeSessionInputCompletion(database, { ...resolved, ...request }, request.outcome);
}

export function finishSessionPendingInputInDatabase(
  database: OpenClawAgentDatabase,
  request: PendingInputFinish,
): void {
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .updateTable("session_pending_inputs")
      .set({ state: request.disposition })
      .where("input_id", "=", request.inputId)
      .where("lifecycle_generation", "=", request.lifecycleGeneration)
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null),
  );
}

export function repairSessionPendingInputRowsInDatabase(
  database: OpenClawAgentDatabase,
  rows: readonly PendingInputIdentity[],
): string[] {
  return rows.flatMap((row) => {
    let query = getSessionKysely(database.db)
      .updateTable("session_pending_inputs")
      .set({ state: "interrupted" })
      .where("input_id", "=", row.input_id)
      .where("session_key", "=", row.session_key)
      .where("session_id", "=", row.session_id)
      .where("lifecycle_generation", "=", row.lifecycle_generation)
      .where("state", "=", "queued")
      .where("consumed_event_id", "is", null);
    if (row.requireRetiredSession) {
      query = query.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_nodes")
              .select("session_key")
              .where("session_key", "=", row.session_key)
              .where("current_session_id", "=", row.session_id),
          ),
        ),
      );
    }
    return executeSqliteQuerySync(database.db, query.returning("input_id")).rows.map(
      (updated) => updated.input_id,
    );
  });
}
