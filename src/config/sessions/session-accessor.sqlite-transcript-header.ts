import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";

export function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
    onPlaceholderInserted?: (placeholder: { sessionKey: string; sessionId: string }) => void;
  },
): void {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor && actor.hot.transcript.version.rawSeq !== null) return;
  const db = getSessionKysely(database.db);
  const existing = actor
    ? undefined
    : executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", scope.sessionId)
          .limit(1),
      );
  if (existing) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({ cwd, sessionId: scope.sessionId }),
    projection,
  );
}
