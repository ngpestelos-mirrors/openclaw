import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  ensureSessionInputCompletionsSchema,
  ensureSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { PendingInputIdentity } from "./session-accessor.pending-inputs.read.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import {
  readSessionInputCompletion,
  readSessionPendingInputByKey,
  writeSessionInputCompletion,
  type SessionPendingInputRow,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";

export type PendingInputStageRead = { idempotencyKey: string; trackCompletion?: boolean };
export type PendingInputStageSnapshot = {
  existing?: SessionPendingInputRow;
  previous?: ReturnType<typeof readSessionInputCompletion>;
  committed?: ReturnType<typeof readTranscriptMessageByScopedIdempotencyKey>;
  source: CapturedSessionEntryReadSource;
};
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

/** The caller holds the admitted writer transaction, including feature schema preparation. */
export function readSessionPendingInputStage(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageRead,
): PendingInputStageSnapshot | undefined {
  if (readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== resolved.sessionId) {
    return undefined;
  }
  if (request.trackCompletion) {
    ensureSessionInputCompletionsSchema(database.db);
  }
  const physical = readOpenClawAgentDatabaseIdentity(database);
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
    source: {
      agentId: database.agentId,
      path: database.path,
      databaseIdentity: physical.identity,
      databaseBirthtime: physical.birthtime,
    },
  };
}

export function commitSessionPendingInputStage(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  request: PendingInputStageCommit,
): boolean {
  assertCapturedSessionEntryReadSource(request.snapshot.source, database);
  if (readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== resolved.sessionId) {
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
  if (readSessionEntryRow(database, resolved.sessionKey)?.entry.sessionId !== resolved.sessionId) {
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
