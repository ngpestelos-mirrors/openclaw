import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { validateDeliveryCanonicalSessionEntry } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  captureCanonicalSessionReaderContinuation,
  hasCanonicalSessionValidationProjection,
  readWithCanonicalSessionReaderContinuation,
  type CanonicalSessionReaderContinuation,
} from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

export type SessionBackingFact = Pick<SessionEntry, "sessionId" | "updatedAt" | "subagentRecovery">;
export type SessionBackingFactsScope = {
  storePath: string;
  sessionKeys: readonly string[];
  env?: NodeJS.ProcessEnv;
};
export type SessionBackingFacts = Array<{ sessionKey: string; entry: SessionBackingFact }>;

/** Preserve listing admission and malformed-row handling while selecting only requested keys. */
export function readSessionBackingFacts(
  scope: SessionBackingFactsScope,
  continuation?: CanonicalSessionReaderContinuation,
): SessionBackingFacts {
  if (scope.sessionKeys.length === 0) {
    return [];
  }
  const options = toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" }));
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      readWithCanonicalSessionReaderContinuation(database, continuation, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const keys = new Set(scope.sessionKeys);
        const query = selectSessionEntryRows(database, "list").select("updated_at");
        const pending = getNodeSqliteKysely<DB>(database.db)
          .selectFrom("session_canonical_validation_pending")
          .select("session_key");
        // Warm admission permits raw metadata changes. The listing contract still
        // rejects delivery-canonical sibling drift, so include its existing dirty set.
        // Older readers have no dirty set and retain their full validation inventory.
        const rows = executeSqliteQuerySync(
          database.db,
          hasCanonicalSessionValidationProjection(database)
            ? query.where(
                "session_key",
                "in",
                pending.union(
                  getNodeSqliteKysely<DB>(database.db)
                    .selectFrom("session_nodes")
                    .select("session_key")
                    .where("session_key", "in", sqliteStringSet(scope.sessionKeys)),
                ),
              )
            : query,
        ).rows;
        const facts: SessionBackingFacts = [];
        for (const row of rows) {
          if (isInternalSessionEffectsKey(row.session_key)) {
            continue;
          }
          const entry = parseSessionEntryJson(row, "list");
          if (!entry) {
            continue;
          }
          validateDeliveryCanonicalSessionEntry(row.session_key, entry);
          if (!keys.has(row.session_key)) {
            continue;
          }
          facts.push({
            sessionKey: row.session_key,
            entry: {
              sessionId: entry.sessionId,
              updatedAt: entry.updatedAt,
              ...(entry.subagentRecovery ? { subagentRecovery: entry.subagentRecovery } : {}),
            },
          });
        }
        return facts;
      }),
    options,
  );
  return result.found ? result.value : [];
}

/** Retain physical readers and reject backing evidence invalidated while its worker read yields. */
export async function readSessionBackingFactsInWorker(
  scopes: readonly SessionBackingFactsScope[],
): Promise<Array<SessionBackingFacts | undefined>> {
  const captured = cloneEnvWithPlatformSemantics(process.env);
  const env = { ...captured, OPENCLAW_STATE_DIR: resolveStateDir(captured) };
  const requests = scopes.map((scope) => {
    const options = toDatabaseOptions(resolveSqliteScope({ ...scope, env, sessionKey: "" }));
    return {
      options,
      scope: { ...scope, env, storePath: resolveOpenClawAgentSqlitePath(options) },
    };
  });
  const native = retainOpenClawAgentDatabaseReadCandidates(
    requests.map(({ scope }) => ({ path: scope.storePath })),
    env,
  );
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  const changedKeys = new Set<string>();
  let allChanged = false;
  const stop = sessionChanges.subscribe((change) => {
    if ("all" in change) {
      allChanged = true;
    } else {
      changedKeys.add(change.sessionKey);
    }
  });
  try {
    for (const database of native.databases) {
      const continuation = captureCanonicalSessionReaderContinuation(database);
      if (continuation) {
        continuations.push({ path: database.path, owner: continuation });
      }
    }
    const { withSessionHistoryWorkerDatabases } =
      await import("./session-transcript-worker-runtime.js");
    return await withSessionHistoryWorkerDatabases(
      requests.map(({ options }) => options),
      async (owners) => {
        const results: Array<SessionBackingFacts | undefined> = [];
        for (const [index, request] of requests.entries()) {
          const continuation = continuations.find(
            (item) => item.path === request.scope.storePath,
          )?.owner;
          results.push(
            await owners[index]!.readBackingFacts({
              scope: request.scope,
              continuation: continuation?.receipt,
            }),
          );
        }
        for (const { owner: continuation } of continuations) {
          continuation.assertCurrent();
        }
        return results.map((result, index) =>
          allChanged || requests[index]!.scope.sessionKeys.some((key) => changedKeys.has(key))
            ? undefined
            : result,
        );
      },
    );
  } finally {
    stop();
    for (const { owner: continuation } of continuations.toReversed()) {
      continuation.release();
    }
    native.release();
  }
}
