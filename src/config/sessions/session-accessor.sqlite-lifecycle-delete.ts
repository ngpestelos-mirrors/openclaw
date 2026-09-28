import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
} from "../../sessions/agent-harness-session-key.js";
import { deletePersonalGitHubSessionReceipts } from "../../state/github-personal-publication-lifecycle.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SessionLifecycleArchivedTranscript,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { readLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-store.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import { publishCommittedSessionEntryRemoval } from "./session-accessor.sqlite-identity.js";
import {
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
  planSessionStateAfterEntryRemoval,
  readReferencedSessionIdsAfterTargetMutation,
} from "./session-accessor.sqlite-lifecycle-state.js";
import {
  createHistoricalGenerationReclamationPlan,
  createSessionEntryReclamationPlan,
  expectedEntryMismatchResult,
  prepareHistoricalGenerationDeletions,
  readValidatedSessionDeletionTarget,
  runExclusiveSqliteSessionReclamation,
  runSqliteSessionReclamation,
  shouldDeleteSqliteSessionEntryLifecycle,
} from "./session-accessor.sqlite-reclamation.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteAgentId,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  withSqliteSessionDatabase,
  type resolveSqliteStoreScope,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction-candidates.js";

const DELETE_EXPECTED_ENTRY_MISMATCH = Symbol("delete-expected-entry-mismatch");

export async function deleteSqliteSessionEntryLifecycleLocked(
  resolved: ReturnType<typeof resolveSqliteStoreScope>,
  params: DeleteSessionEntryLifecycleParams,
  allowLockedEntryRemoval: boolean,
  expectedPluginOwnerId: string | undefined,
  committed?: {
    recordCommit: (database: OpenClawAgentDatabase) => void;
    markCommitted: () => void;
  },
): Promise<DeleteSessionEntryLifecycleResult> {
  const databaseOptions = toDatabaseOptions(resolved);
  const prepared = await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      withSqliteSessionDatabase(
        databaseOptions,
        (database) => {
          const targetSnapshot = readLifecycleTargetSnapshot(database, params.target);
          const current = targetSnapshot[0];
          if (!current) {
            return null;
          }
          if (!shouldDeleteSqliteSessionEntryLifecycle(database, current.entry, params)) {
            return DELETE_EXPECTED_ENTRY_MISMATCH;
          }
          if (current.entry.modelSelectionLocked === true && !allowLockedEntryRemoval) {
            throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
          }
          if (
            expectedPluginOwnerId &&
            targetSnapshot.some(
              ({ entry, sessionKey }) =>
                isAgentHarnessSessionKey(sessionKey) ||
                entry.agentHarnessId !== undefined ||
                entry.modelSelectionLocked !== true ||
                normalizeOptionalString(entry.pluginOwnerId) !== expectedPluginOwnerId,
            )
          ) {
            throw new Error(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
          }
          const deleteTranscriptState =
            params.archiveTranscript || params.deleteTranscriptWithoutArchive === true;
          const ownedGenerationIds = deleteTranscriptState
            ? readSessionGenerationIdsForKeys(database, [
                params.target.canonicalKey,
                ...params.target.storeKeys,
                ...targetSnapshot.map((row) => row.sessionKey),
              ])
            : [];
          const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
            database,
            params.target,
            deleteTranscriptState
              ? [
                  ...new Set([
                    ...targetSnapshot.flatMap(({ entry }) => collectSessionStateIdsForEntry(entry)),
                    ...ownedGenerationIds,
                  ]),
                ]
              : [],
          );
          // SQLite transcript state is keyed by session id; sessionFile is only its
          // marker. Materialization dedupes aliases that share the same state owner.
          const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
          const entryPlans = deleteTranscriptState
            ? targetSnapshot.flatMap(({ entry }) =>
                planSessionStateAfterEntryRemoval({
                  archiveDirectory,
                  archiveTranscript: params.archiveTranscript,
                  database,
                  entry,
                  reason: "deleted",
                  referencedSessionIds: referencedAfterDelete,
                }),
              )
            : [];
          const entryPlanIds = new Set(entryPlans.map((plan) => plan.sessionId));
          // Ids only — archive extraction happens lazily one generation at a time
          // outside the SQLite write transaction.
          const historicalGenerationIds = deleteTranscriptState
            ? ownedGenerationIds.filter((sessionId) => !entryPlanIds.has(sessionId))
            : [];
          // Historical generations are reclaimed BEFORE the entry-removing
          // transaction, one generation per transaction: an archive or delete
          // failure aborts the whole deletion while the live entry still exists,
          // so a retry rediscovers the remaining history. Acknowledging deletion
          // first would let surviving generations become unreachable via delete.
          // Preflight the admission fence over every generation BEFORE deleting
          // anything, so an in-flight run rejects the whole deletion instead of
          // aborting it midway through committed removals.
          const preflightFence = collectAdmissionProtectedSessionIds({
            database,
            storePath: params.storePath,
          });
          for (const sessionId of historicalGenerationIds) {
            if (preflightFence.has(sessionId) && !referencedAfterDelete.has(sessionId)) {
              throw new Error(
                `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
              );
            }
          }
          return { archiveDirectory, current, entryPlans, historicalGenerationIds, targetSnapshot };
        },
        () => params.commitGuard?.(),
      ),
    "session.lifecycle.delete-prepare",
  );
  if (!prepared) {
    await publishSessionStateArchives(resolved, []);
    return { archivedTranscripts: [], deleted: false };
  }
  if (prepared === DELETE_EXPECTED_ENTRY_MISMATCH) {
    await publishSessionStateArchives(resolved, []);
    return expectedEntryMismatchResult([]);
  }

  return await withSqliteSessionDeletions(
    resolved,
    prepared.targetSnapshot,
    async (assertCurrent) => {
      const assertDeletionCurrent = () => {
        params.commitGuard?.();
        assertCurrent();
      };
      const validation = { deleteParams: params, preparedTargetSnapshot: prepared.targetSnapshot };
      const historicalArchivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
      for (const generation of prepareHistoricalGenerationDeletions({
        ...validation,
        sessionIds: prepared.historicalGenerationIds,
      })) {
        const { sessionId } = generation;
        const plan = await runExclusiveSqliteSessionWrite(
          resolved,
          async () =>
            withSqliteSessionDatabase(
              databaseOptions,
              (database) => {
                if (!readValidatedSessionDeletionTarget(database, generation)) {
                  return DELETE_EXPECTED_ENTRY_MISMATCH;
                }
                const referencedAfterDelete = readReferencedSessionIdsAfterTargetMutation(
                  database,
                  params.target,
                  [sessionId],
                );
                if (referencedAfterDelete.has(sessionId)) {
                  return null;
                }
                const admissionProtected = collectAdmissionProtectedSessionIds({
                  database,
                  storePath: params.storePath,
                });
                if (admissionProtected.has(sessionId)) {
                  throw new Error(
                    `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
                  );
                }
                return planSessionStateDeleteIfUnreferenced({
                  archiveDirectory: prepared.archiveDirectory,
                  archiveTranscript: params.archiveTranscript,
                  database,
                  reason: "deleted",
                  referencedSessionIds: referencedAfterDelete,
                  sessionId,
                });
              },
              assertDeletionCurrent,
            ),
          "session.lifecycle.archive-plan",
        );
        if (plan === DELETE_EXPECTED_ENTRY_MISMATCH) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (!plan) {
          continue;
        }
        const archivedGeneration = await runExclusiveSqliteSessionReclamation(async () => {
          const materializedGeneration = await materializeSessionStateDeletePlans([plan]);
          const diagnostics: SqliteSessionReclamationDiagnostics = {};
          const reclamationPlan = await runExclusiveSqliteSessionWrite(
            resolved,
            async () =>
              withSqliteSessionDatabase(
                databaseOptions,
                (database) => {
                  if (!readValidatedSessionDeletionTarget(database, generation)) {
                    return DELETE_EXPECTED_ENTRY_MISMATCH;
                  }
                  const protectedSessionIds = collectAdmissionProtectedSessionIds({
                    database,
                    storePath: params.storePath,
                  });
                  if (protectedSessionIds.has(sessionId)) {
                    throw new Error(
                      `cannot delete session history while work is in flight for ${sessionId}; retry after the run completes`,
                    );
                  }
                  return createHistoricalGenerationReclamationPlan({
                    databaseOptions,
                    deleteParams: generation.deleteParams,
                    materializedPlans: materializedGeneration,
                    preparedTargetSnapshot: prepared.targetSnapshot,
                    protectedSessionIds,
                    sessionId,
                  });
                },
                assertDeletionCurrent,
              ),
            "session.lifecycle.reclamation-plan",
            diagnostics,
          );
          if (reclamationPlan === DELETE_EXPECTED_ENTRY_MISMATCH) {
            return DELETE_EXPECTED_ENTRY_MISMATCH;
          }
          const reclaimed = await runSqliteSessionReclamation({
            diagnostics,
            assertCommitAllowed: assertDeletionCurrent,
            forceInProcess: hasPreparedNativeSessionDeletion(),
            onInProcessCommit: committed?.recordCommit,
            plan: reclamationPlan,
          });
          if (reclaimed.kind !== reclamationPlan.kind) {
            throw new Error(
              `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
            );
          }
          return reclaimed.value;
        });
        if (archivedGeneration === DELETE_EXPECTED_ENTRY_MISMATCH) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (archivedGeneration.expectedEntryMismatch) {
          return expectedEntryMismatchResult(historicalArchivedTranscripts);
        }
        if (archivedGeneration.deleted) {
          committed?.markCommitted();
        }
        // Publish each committed generation immediately: a later archive or
        // transaction failure aborts the deletion, and observers must still see
        // the removals that already happened (retry completes the remainder).
        const publishedGeneration = await publishSessionStateArchives(
          resolved,
          archivedGeneration.archivedTranscripts,
        );
        emitArchivedTranscriptUpdates(publishedGeneration);
        historicalArchivedTranscripts.push(...publishedGeneration);
      }

      // Archive materialization is the expensive phase. It must run between short
      // writer-lane sections so unrelated writes to this store can keep progressing.
      let committedDatabaseIdentity: string | symbol | undefined;
      const result = await runExclusiveSqliteSessionReclamation(async () => {
        const materializedPlans = await materializeSessionStateDeletePlans(prepared.entryPlans);
        const diagnostics: SqliteSessionReclamationDiagnostics = {};
        const reclamationPlan = await runExclusiveSqliteSessionWrite(
          resolved,
          async () =>
            withSqliteSessionDatabase(
              databaseOptions,
              (database) => {
                if (!readValidatedSessionDeletionTarget(database, validation)) {
                  return DELETE_EXPECTED_ENTRY_MISMATCH;
                }
                return createSessionEntryReclamationPlan({
                  databaseOptions,
                  deleteParams: params,
                  materializedPlans,
                  preparedTargetSnapshot: prepared.targetSnapshot,
                });
              },
              assertDeletionCurrent,
            ),
          "session.lifecycle.reclamation-plan",
          diagnostics,
        );
        if (reclamationPlan === DELETE_EXPECTED_ENTRY_MISMATCH) {
          return expectedEntryMismatchResult([]);
        }
        const reclaimed = await runSqliteSessionReclamation({
          diagnostics,
          assertCommitAllowed: assertDeletionCurrent,
          forceInProcess: hasPreparedNativeSessionDeletion(),
          onInProcessCommit: (database) => {
            committedDatabaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
            committed?.recordCommit(database);
          },
          onWorkerResult: (_result, databaseIdentity) => {
            committedDatabaseIdentity = databaseIdentity;
          },
          plan: reclamationPlan,
        });
        if (reclaimed.kind !== reclamationPlan.kind) {
          throw new Error(
            `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
          );
        }
        return reclaimed.value;
      });
      if (result.deleted) {
        committed?.markCommitted();
        if (committedDatabaseIdentity === undefined) {
          throw new Error("Committed session deletion omitted its database identity");
        }
        // The deletion is committed; observers must invalidate even if receipt cleanup fails.
        publishCommittedSessionEntryRemoval(
          resolved.agentId,
          committedDatabaseIdentity,
          prepared.current.entry.sessionId,
          prepared.targetSnapshot.map((row) => row.sessionKey),
        );
        deletePersonalGitHubSessionReceipts({
          agentId: resolved.agentId,
          env: resolved.env,
          sessionKeys: [
            params.target.canonicalKey,
            ...params.target.storeKeys,
            ...prepared.targetSnapshot.map((row) => row.sessionKey),
          ],
        });
      }
      result.archivedTranscripts = await publishSessionStateArchives(
        resolved,
        result.archivedTranscripts,
      );
      emitArchivedTranscriptUpdates(result.archivedTranscripts);
      // Historical generations were emitted per commit above; merge them into
      // the result after the final emit so callers still see every archive.
      result.archivedTranscripts.push(...historicalArchivedTranscripts);
      return result;
    },
    { additionalIdentities: prepared.historicalGenerationIds },
  );
}

/** Disk-budget owner: delete one exact archived row without recursively scheduling another pass. */
export async function deleteDiskBudgetSessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
  resolved: ResolvedSqliteScope,
): Promise<DeleteSessionEntryLifecycleResult> {
  // A shared store lends its physical owner, not the victim's logical identity.
  // Validate against captured ownership so a custom selector cannot retarget cleanup.
  const targetScope = captureLifecycleDatabaseScope({
    ...resolved,
    agentId: resolveSqliteAgentId({
      scopedAgentId: params.agentId ?? parseAgentSessionKey(params.target.canonicalKey)?.agentId,
      storeAgentId: resolved.databaseAgentId ?? resolved.agentId,
      storeShared: resolved.databaseAgentId !== undefined,
    }),
  });
  return await withSqliteTranscriptArchiveSession(toDatabaseOptions(targetScope), () =>
    deleteSqliteSessionEntryLifecycleLocked(targetScope, params, false, undefined),
  );
}
