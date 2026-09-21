import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  type SessionMember,
} from "./session-sharing-store.kernel.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">) => T,
): T {
  const result = withOpenClawAgentDatabaseReadOnly(operation, resolveDatabaseOptions(scope));
  return result.found ? result.value : fallback;
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  return readSessionMembers(scope, [], (database) =>
    listSessionMembersInDatabase(database, resolveSqliteScope(scope).sessionKey),
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  return readSessionMembers(scope, false, (database) =>
    hasSessionMemberInDatabase(
      database,
      resolveSqliteScope(scope).sessionKey,
      normalizedIdentityId,
    ),
  );
}

export {
  addSessionMemberInWorker as addSessionMember,
  removeSessionMemberInWorker as removeSessionMember,
} from "./session-sharing-store.async.js";
