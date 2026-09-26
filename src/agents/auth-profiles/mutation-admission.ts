import { resolveStateDir } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";

const queues = resolveGlobalSingleton(
  Symbol.for("openclaw.authProfileMutationQueues"),
  () => new Map<string, StoreWriterQueue>(),
);

/** Async credential and health mutations share FIFO through preparation, commit, and publication. */
export function runAuthProfileMutationAdmission<T>(
  env: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  return runQueuedStoreWrite({
    queues,
    storePath: resolvePathViaExistingAncestorSync(resolveStateDir(env)),
    label: "auth profile mutation admission",
    reentrant: true,
    fn: operation,
  });
}

/** Absent files have logical custody until their first admitted physical owner exists. */
export function captureAuthProfileMutationSource(options: {
  env: NodeJS.ProcessEnv;
  agent?: { path: string; agentId: string };
}) {
  const context = captureOpenClawStateWorkerContext({ env: options.env });
  const target = options.agent;
  let identity = target ? readDatabasePathIdentitySync(target.path) : undefined;
  let active = true;
  let unregister: (() => void) | undefined;
  const dispose = () => {
    active = false;
    unregister?.();
  };
  if (target) {
    const register = () =>
      registerOpenClawAgentDatabaseAsyncResource({
        ...target,
        revoke: () => {
          active = false;
        },
        close: async () => dispose(),
      });
    unregister = context.maintenanceScope ? context.maintenanceScope.run(register) : register();
  }
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Auth profile mutation source was revoked");
    }
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
    if (target && identity) {
      const current = readDatabasePathIdentitySync(target.path);
      if (
        current.canonicalPath !== identity.canonicalPath ||
        (identity.key.startsWith("file:") &&
          (current.key !== identity.key || current.birthtime !== identity.birthtime))
      ) {
        throw new Error("Auth profile database file identity changed before mutation admission");
      }
    }
  };
  return {
    get identity() {
      return identity;
    },
    admit: () => {
      assertCurrent();
      if (target && identity?.key.startsWith("path:")) {
        identity = readDatabasePathIdentitySync(target.path);
      }
    },
    assertCurrent,
    dispose,
  };
}
