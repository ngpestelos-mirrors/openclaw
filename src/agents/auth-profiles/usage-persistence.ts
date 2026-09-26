import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveUserPath } from "../../utils.js";
import { reportCommittedAuthProfileUsage } from "./constants.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import { resolveAuthProfileDatabaseOwnerId, resolveAuthProfileDatabasePath } from "./sqlite.js";
import { updateAuthProfileStoreWithLock } from "./store-runtime.js";
import {
  getScopedAuthProfileEnv,
  resolvePersistedAuthProfileOwnerAgentDir,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { runAuthProfileUsageAdmission } from "./usage-admission.js";

export const authProfileUsageDeps = { updateAuthProfileStoreWithLock };

/** Capture the legacy mutation's physical owner before waiting in the usage queue. */
export async function updateOwnedAuthProfileUsage(
  store: AuthProfileStore,
  profileId: string,
  update: Parameters<typeof updateAuthProfileStoreWithLock>[0],
): Promise<AuthProfileStore | null> {
  const env = cloneEnvWithPlatformSemantics(
    update.env ?? (update.stateDir ? process.env : getScopedAuthProfileEnv()) ?? process.env,
  );
  if (!update.env && update.stateDir) {
    env.OPENCLAW_STATE_DIR = update.stateDir;
    env.OPENCLAW_AGENT_DIR = undefined;
  }
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
    agentDir: update.agentDir,
    profileId,
  });
  const scopedAgentDir = resolveRuntimeAuthProfileAgentDir(ownerAgentDir);
  const agentDir = scopedAgentDir ? resolveUserPath(scopedAgentDir, env) : undefined;
  const personal = isUserModelAuthProfileId(profileId);
  const context = captureOpenClawStateWorkerContext({ env });
  const sharedDatabasePath = personal
    ? context.admission.databasePath
    : resolveSharedAuthStorePath(env);
  const location = personal ? "state-db" : resolveSharedAuthStoreOwnership(env).location;
  const databasePath =
    personal || !agentDir ? sharedDatabasePath : resolveAuthProfileDatabasePath(agentDir);
  const agentTarget =
    !personal && (agentDir || location === "legacy-main")
      ? {
          path: databasePath,
          agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
          env,
        }
      : undefined;
  const reader = agentTarget
    ? prepareAgentAuthProfileRowsRead({ ...agentTarget, databasePath })
    : undefined;
  const identity = agentTarget ? readDatabasePathIdentitySync(databasePath) : undefined;
  let creation: OpenClawAgentDatabaseExecution | undefined;
  let readerClose: Promise<void> | undefined;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    if (creation) {
      creation.assertCurrent();
    } else {
      reader?.assertCurrent();
    }
    if (
      !personal &&
      (resolveSharedAuthStorePath(env) !== sharedDatabasePath ||
        resolveSharedAuthStoreOwnership(env).location !== location)
    ) {
      throw new Error("Auth profile shared owner changed before write admission");
    }
  };
  let committed = false;
  try {
    assertCurrent();
    if (agentTarget && identity?.key.startsWith("path:")) {
      creation = captureOpenClawAgentDatabaseExecution(agentTarget, {
        expectedCreationIdentity: identity,
      });
      // The captured creation owner replaces this reader's absence assertion.
      readerClose = reader?.dispose();
      void readerClose?.catch(() => undefined);
    }
    const persist = async () => {
      assertCurrent();
      let changed = false;
      const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
        ...update,
        profileId,
        agentDir: ownerAgentDir === undefined ? undefined : agentDir,
        env,
        updater: (freshStore, owner) => {
          assertCurrent();
          if (
            owner &&
            (owner.databasePath !== databasePath ||
              owner.sharedDatabasePath !== sharedDatabasePath ||
              owner.location !== location)
          ) {
            throw new Error("Auth profile usage changed its prepared credential owner");
          }
          changed = update.updater(freshStore, owner);
          assertCurrent();
          return changed;
        },
      });
      committed = Boolean(updated && changed);
      const usage = changed ? updated?.usageStats?.[profileId] : undefined;
      if (usage) {
        store.usageStats = { ...store.usageStats, [profileId]: usage };
      }
      return updated;
    };
    return await runAuthProfileUsageAdmission(profileId, () => {
      const creating = creation;
      if (!creating || !agentTarget) {
        return persist();
      }
      return runOpenClawAgentWriteAdmission(agentTarget, async () => {
        await creating.prepare({
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
        return persist();
      });
    });
  } finally {
    const settled = await Promise.allSettled([
      readerClose ?? reader?.dispose(),
      creation?.release(),
    ]);
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      const error = new AggregateError(errors, "Auth usage owner cleanup failed", {
        cause: errors[0],
      });
      if (!committed) {
        throw error;
      }
      reportCommittedAuthProfileUsage("auth usage committed before reader cleanup failed", error);
    }
  }
}
