import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { withSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { authProfilesLog, reportCommittedAuthProfileUsage } from "./constants.js";
import type {
  AuthProfileUsageInput,
  AuthProfileSuccessInput,
  AuthProfileUsageOperations,
  AuthProfileUsageReceipt,
  AuthProfileUsageResult,
} from "./inline-usage-kernel.js";
import { publishAuthProfileUsage } from "./inline-usage-publication.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { clearRuntimeAuthProfileStoreSnapshotAtDatabasePath } from "./runtime-snapshots.js";
import { loadPersistedAuthProfileStoreFromRows } from "./sqlite-read.js";
import {
  type PreparedAuthProfileStoreOwner,
  prepareAuthProfileWriteTransaction,
} from "./sqlite.js";
import {
  getScopedAuthProfileEnv,
  getScopedSharedAuthStore,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import type { PreparedAuthProfileUsageOwner } from "./usage-owner.js";

function authProfileUsageError(payload: OpenClawStateWorkerErrorPayload): Error {
  const error = new Error("Auth usage transaction failed");
  retainOpenClawStateWorkerErrorPayload(error, payload);
  return hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
}

/** The retry controller's inline failure belongs to its explicit agent database. */
export async function persistInlineAuthFailure(
  agentDir: string,
  input: Omit<
    Extract<AuthProfileUsageInput, { kind: "inline-failure" }>,
    "kind" | "expectedCredentials" | "inheritedUsageStats"
  >,
): Promise<AuthProfileUsageReceipt | null> {
  const effectiveAgentDir = resolveRuntimeAuthProfileAgentDir(agentDir);
  const prepared = prepareAuthProfileWriteTransaction(effectiveAgentDir, {
    env: getScopedAuthProfileEnv(),
  });
  return persistAgentAuthProfileUsage(effectiveAgentDir, prepared, {
    ...input,
    kind: "inline-failure",
    expectedCredentials: undefined,
    inheritedUsageStats: structuredClone(getScopedSharedAuthStore()?.usageStats),
  });
}

export async function persistAuthProfileSuccess(
  prepared: PreparedAuthProfileUsageOwner,
  input: AuthProfileSuccessInput,
): Promise<AuthProfileUsageReceipt | null> {
  const { owner, target, assertCurrent } = prepared;
  assertCurrent();
  if (target.kind === "agent") {
    return persistAgentAuthProfileUsage(
      prepared.agentDir,
      {
        databaseTarget: { ...target, kind: "agent" },
        sharedOwner: owner,
      },
      input,
      assertCurrent,
      target.creation,
    );
  }
  let receipt: AuthProfileUsageReceipt | undefined;
  try {
    const result = await runOpenClawStateWorkerOperation(
      target.context,
      async (scope) => {
        const result = await scope.execute({
          type:
            target.kind === "personal"
              ? "authProfiles.personalSuccess"
              : "authProfiles.sharedSuccess",
          input,
        });
        if (result.ok) {
          receipt = result.receipt;
          if (receipt.applied && target.kind !== "personal") {
            await publishCommittedUsage(
              owner,
              receipt,
              () =>
                scope.execute({ type: "authProfiles.read", input: { artifactPreserving: false } }),
              assertCurrent,
            );
          }
        }
        return result;
      },
      {
        existingOnly: true,
        assertCurrent,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [owner.databasePath]),
      },
    );
    if (result && !result.ok) {
      throw authProfileUsageError(result.error);
    }
    return result?.receipt ?? null;
  } catch (error) {
    if (receipt) {
      reportCommittedAuthProfileUsage("auth usage committed before owner cleanup failed", error);
      return receipt;
    }
    if (target.kind !== "personal") {
      clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath, prepared.agentDir);
    }
    throw error;
  }
}

async function publishCommittedUsage(
  owner: PreparedAuthProfileStoreOwner,
  receipt: AuthProfileUsageReceipt,
  readTarget: Parameters<typeof publishAuthProfileUsage>[2],
  assertCurrent: () => void,
): Promise<void> {
  try {
    await withSqliteReadOnlyWorkerScope(() =>
      publishAuthProfileUsage(owner, receipt, readTarget, assertCurrent),
    );
  } catch (error) {
    clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath);
    reportCommittedAuthProfileUsage("auth usage committed but publication failed", error);
  }
}

async function persistAgentAuthProfileUsage(
  effectiveAgentDir: string | undefined,
  prepared: ReturnType<typeof prepareAuthProfileWriteTransaction>,
  input: AuthProfileUsageInput,
  assertPrepared: () => void = () => {},
  creation?: Extract<PreparedAuthProfileUsageOwner["target"], { kind: "agent" }>["creation"],
): Promise<AuthProfileUsageReceipt | null> {
  const { databaseTarget, sharedOwner } = prepared;
  if (databaseTarget.kind !== "agent") {
    throw new Error("Inline auth failure requires its selected agent database");
  }
  const owner = { ...sharedOwner, databasePath: databaseTarget.path };
  const candidates = resolveLegacyAuthProfileSourceCandidates({
    agentDir: effectiveAgentDir,
    env: owner.env,
  });
  const identity = creation?.identity ?? readDatabasePathIdentitySync(databaseTarget.path);
  const execution = captureOpenClawAgentDatabaseExecution(
    databaseTarget,
    identity.key.startsWith("path:") ? { expectedCreationIdentity: identity } : undefined,
  );
  creation?.handoff();
  let durableReceipt: AuthProfileUsageReceipt | undefined;
  let failure: { error: unknown } | undefined;
  let hasCredentials: boolean | undefined;
  const assertCurrent = () => {
    assertPrepared();
    execution.assertCurrent();
    if (identity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(databaseTarget.path, identity.key);
    } else if (
      readDatabasePathIdentitySync(databaseTarget.path).canonicalPath !== identity.canonicalPath
    ) {
      throw new Error("Auth database path changed before inline-failure admission");
    }
    if (
      resolveSharedAuthStorePath(owner.env) !== owner.sharedDatabasePath ||
      resolveSharedAuthStoreOwnership(owner.env).location !== owner.location
    ) {
      throw new Error("Auth profile shared owner changed before write admission");
    }
    assertAuthProfileMigrationStateAtDatabasePath(owner.databasePath);
    if (hasCredentials !== undefined) {
      assertAuthProfileMigrationCandidates({
        databasePath: owner.databasePath,
        candidates,
        hasCredentials: () => hasCredentials === true,
      });
    }
  };
  const runWithAdmission = async (): Promise<AuthProfileUsageReceipt | null> => {
    try {
      return await runOpenClawAgentWriteAdmission(
        databaseTarget,
        async () => {
          if (identity.key.startsWith("path:")) {
            await execution.prepare({
              assertCurrent,
              createAdmission: (binding) => () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  assertCurrent();
                  if (!grant()) {
                    throw new Error("Auth usage initialization authority expired");
                  }
                }, binding.attachment),
              }),
            });
          }
          const client = await openOpenClawAgentSqliteWorkerStore<AuthProfileUsageOperations>(
            databaseTarget,
            { execution },
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileInlineUsage),
              input: {},
            },
          );
          let outcome: { ok: true; value: AuthProfileUsageResult } | { ok: false; error: unknown };
          try {
            const value = await client.run(async (scope) => {
              const readTarget = () =>
                scope.execute({ type: "authProfiles.usageSnapshot", input: undefined });
              const rows = await readTarget();
              const store = loadPersistedAuthProfileStoreFromRows(rows, owner.databasePath);
              hasCredentials = Object.keys(store?.profiles ?? {}).length > 0;
              assertCurrent();
              const result = await scope.execute({
                type: "authProfiles.usage",
                input:
                  input.kind === "inline-failure"
                    ? {
                        ...input,
                        expectedCredentials:
                          rows.store.status === "readable" ? rows.store.raw : null,
                      }
                    : input,
              });
              if (!result.ok) {
                return result;
              }
              const { receipt } = result;
              durableReceipt = receipt;
              if (receipt.applied) {
                await publishCommittedUsage(owner, receipt, readTarget, assertCurrent);
              }
              return result;
            }, assertCurrent);
            outcome = { ok: true, value };
          } catch (error) {
            outcome = { ok: false, error };
          }
          try {
            await client.close();
          } catch (cleanupError) {
            if (!outcome.ok) {
              throw new AggregateError(
                [outcome.error, cleanupError],
                "Auth usage and owner cleanup failed",
                { cause: cleanupError },
              );
            }
            if (!outcome.value.ok) {
              throw new AggregateError(
                [authProfileUsageError(outcome.value.error), cleanupError],
                "Auth usage refusal and owner cleanup failed",
                { cause: cleanupError },
              );
            }
            reportCommittedAuthProfileUsage(
              "auth usage committed before owner cleanup failed",
              cleanupError,
            );
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          if (!outcome.value.ok) {
            throw authProfileUsageError(outcome.value.error);
          }
          return outcome.value.receipt;
        },
        true,
      );
    } catch (error) {
      if (durableReceipt) {
        try {
          clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath, effectiveAgentDir);
        } catch (invalidationError) {
          reportCommittedAuthProfileUsage(
            "auth usage snapshot invalidation failed",
            invalidationError,
          );
        }
        reportCommittedAuthProfileUsage(
          "auth usage committed before publication or cleanup failed",
          error,
        );
        return durableReceipt;
      }
      clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath, effectiveAgentDir);
      failure = { error };
      const message = error instanceof Error ? error.message : String(error);
      authProfilesLog.warn(`auth profile store update failed: ${message}`, {
        agentDir: effectiveAgentDir,
        error: message,
      });
      if (!isSqliteLockError(error)) {
        throw error;
      }
      return null;
    }
  };
  const outcome = await runWithAdmission().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let releaseFailure: { error: unknown } | undefined;
  try {
    await execution.release();
  } catch (error) {
    releaseFailure = { error };
  }
  if (releaseFailure) {
    if (durableReceipt) {
      reportCommittedAuthProfileUsage(
        "auth usage committed before captured owner release failed",
        releaseFailure.error,
      );
    } else if (failure) {
      throw new AggregateError(
        [failure.error, releaseFailure.error],
        "Auth usage and captured owner release failed",
        { cause: failure.error },
      );
    } else {
      throw releaseFailure.error;
    }
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
