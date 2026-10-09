import {
  getSqliteReadScopeRevision,
  type SqliteReadScopeRevision,
} from "../../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

export function readSessionPendingInputAuthorityFacts(
  database: Pick<OpenClawAgentDatabase, "db" | "path" | "agentId">,
  sessionKey: string,
  agentId = database.agentId,
  postimage?: { sessionKey: string; entry: SessionEntry; revision: SqliteReadScopeRevision },
): SessionPendingInputAuthorityFacts {
  return runSqliteReadSnapshotSync(database.db, () => {
    const identity = readOpenClawAgentDatabaseIdentity(database);
    return {
      agentId,
      storePath: database.path,
      // Authority uses the logical agent key; SQLite keeps the original stored key.
      sessionKey: toAgentStoreSessionKey({ agentId, requestKey: sessionKey }),
      entry:
        postimage?.sessionKey === sessionKey &&
        getSqliteReadScopeRevision(database.db) === postimage.revision
          ? structuredClone(postimage.entry)
          : readSessionEntryRow(database, sessionKey, "list")?.entry,
      readSource:
        typeof identity.identity === "string"
          ? {
              agentId: database.agentId,
              path: database.path,
              databaseIdentity: identity.identity,
              databaseBirthtime: identity.birthtime,
            }
          : undefined,
      members: listSessionMembersInDatabase(database, sessionKey),
    };
  });
}
