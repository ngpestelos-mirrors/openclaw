import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveUserPath } from "../../utils.js";
import { captureAgentAuthProfileUsageRead } from "./inline-usage-reader.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { loadPersistedAuthProfileStoreFromRows, readSharedAuthProfileRows } from "./sqlite-read.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
  type PreparedAuthProfileStoreOwner,
} from "./sqlite.js";
import {
  assertPersonalAuthProfileStoreAccess,
  getScopedAuthProfileEnv,
  getScopedSharedAuthStore,
  isEnvOnlyAuthProfileRuntime,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

type AgentUsageTarget = {
  kind: "agent";
  agentId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  creation?: { identity: DatabasePathIdentity; handoff: () => void };
};

export type PreparedAuthProfileUsageOwner = {
  owner: PreparedAuthProfileStoreOwner;
  target:
    | AgentUsageTarget
    | { kind: "shared-state" | "personal"; context: OpenClawStateWorkerContext };
  agentDir: string | undefined;
  inherited: boolean;
  scopedSharedStore: AuthProfileStore | undefined;
  assertCurrent: () => void;
};

/** Capture lifecycle custody before queueing; discover the current credential owner when admitted. */
export function captureAuthProfileUsageOwner(params: { agentDir?: string; profileId: string }): {
  prepare: () => Promise<PreparedAuthProfileUsageOwner | undefined>;
  dispose: () => Promise<void>;
} {
  const personal = isUserModelAuthProfileId(params.profileId);
  if (personal) {
    assertPersonalAuthProfileStoreAccess();
  }
  if (isEnvOnlyAuthProfileRuntime()) {
    return { prepare: async () => undefined, dispose: async () => undefined };
  }
  const scopedEnv = getScopedAuthProfileEnv();
  const env = cloneEnvWithPlatformSemantics(scopedEnv ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const requestedAgentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
  const agentDir = requestedAgentDir ? resolveUserPath(requestedAgentDir, env) : undefined;
  const scopedSharedStore = structuredClone(getScopedSharedAuthStore());
  const context = captureOpenClawStateWorkerContext({ env });
  const readers = new Map<string, ReturnType<typeof captureAgentAuthProfileUsageRead>>();
  const readerFailures = new Map<string, unknown>();
  const consultedReaders = new Set<ReturnType<typeof captureAgentAuthProfileUsageRead>>();
  const readerClosures = new Map<
    ReturnType<typeof captureAgentAuthProfileUsageRead>,
    Promise<void>
  >();
  const targetFor = (directory: string): AgentUsageTarget => ({
    kind: "agent",
    agentId: resolveAuthProfileDatabaseOwnerId(directory),
    path: resolveAuthProfileDatabasePath(directory),
    env,
  });
  const sharedAgentDir = resolveSharedMainAuthAgentDir(env);
  const sharedAgentTarget = targetFor(sharedAgentDir);
  const localTarget = agentDir ? targetFor(agentDir) : undefined;
  if (!personal) {
    // The root's ownership row may still be cold. Retain both candidate physical
    // owners now so a close during discovery cannot be mistaken for a new admission.
    for (const target of [localTarget, sharedAgentTarget]) {
      if (!target || readers.has(target.path)) {
        continue;
      }
      try {
        const reader = captureAgentAuthProfileUsageRead({
          databasePath: target.path,
          agentId: target.agentId,
          env,
        });
        readers.set(target.path, reader);
        reader.assertCurrent();
      } catch (error) {
        readerFailures.set(target.path, error);
      }
    }
  }
  let disposed = false;
  const assertContext = () => {
    if (disposed) {
      throw new Error("Auth profile usage owner was released");
    }
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  const readAgent = async (target: AgentUsageTarget) => {
    if (readerFailures.has(target.path)) {
      throw readerFailures.get(target.path);
    }
    const reader = readers.get(target.path);
    if (!reader) {
      throw new Error("Auth profile usage is missing its captured agent reader");
    }
    consultedReaders.add(reader);
    const rows = await reader.read();
    assertContext();
    return loadPersistedAuthProfileStoreFromRows(rows, target.path);
  };
  return {
    async prepare() {
      assertContext();
      if (personal) {
        return {
          owner: {
            databasePath: context.admission.databasePath,
            sharedDatabasePath: context.admission.databasePath,
            location: "state-db",
            env,
          },
          target: { kind: "personal", context },
          agentDir: undefined,
          inherited: false,
          scopedSharedStore: undefined,
          assertCurrent: assertContext,
        };
      }
      const ownership = await resolveSharedAuthStoreOwnershipAsync(context);
      assertContext();
      const sharedDatabasePath = resolveSharedAuthStorePath(env);
      const assertCurrent = () => {
        assertContext();
        for (const reader of consultedReaders) {
          reader.assertCurrent();
        }
        if (
          resolveSharedAuthStoreOwnership(env).location !== ownership.location ||
          resolveSharedAuthStorePath(env) !== sharedDatabasePath
        ) {
          throw new Error("Auth profile shared owner changed during usage preparation");
        }
      };
      const localStore = localTarget ? await readAgent(localTarget) : undefined;
      const localProfile = localStore?.profiles[params.profileId];
      const requestedShared = !localTarget || localTarget.path === sharedDatabasePath;
      let sharedStore: AuthProfileStore | null | undefined;
      if (!scopedEnv && (!localProfile || localProfile.type === "oauth")) {
        sharedStore =
          requestedShared && localTarget
            ? localStore
            : ownership.location === "state-db"
              ? loadPersistedAuthProfileStoreFromRows(
                  await readSharedAuthProfileRows(context),
                  sharedDatabasePath,
                )
              : await readAgent(sharedAgentTarget);
      }
      assertCurrent();
      const sharedProfile = sharedStore?.profiles[params.profileId];
      const useShared =
        !scopedEnv &&
        (requestedShared ||
          (sharedProfile &&
            (!localProfile ||
              shouldUseMainOwnerForLocalOAuthCredential({
                profileId: params.profileId,
                local: localProfile,
                main: sharedProfile,
              }))));
      if (
        !(useShared
          ? (sharedProfile ?? localProfile)
          : (localProfile ?? scopedSharedStore?.profiles[params.profileId]))
      ) {
        return undefined;
      }
      const target: PreparedAuthProfileUsageOwner["target"] | undefined = useShared
        ? ownership.location === "state-db"
          ? { kind: "shared-state", context }
          : sharedAgentTarget
        : localTarget;
      if (!target) {
        return undefined;
      }
      if (target.kind === "agent") {
        const reader = readers.get(target.path);
        if (reader?.identity.key.startsWith("path:")) {
          target.creation = {
            identity: reader.identity,
            handoff: () => {
              // The writer has captured this exact absence before yielding. Its
              // creation authority now replaces only this reader's absence check.
              consultedReaders.delete(reader);
              const closing = reader.dispose();
              readerClosures.set(reader, closing);
              void closing.catch(() => undefined);
            },
          };
        }
      }
      const owner = {
        databasePath: target.kind === "agent" ? target.path : context.admission.databasePath,
        sharedDatabasePath,
        location: ownership.location,
        env,
      };
      return {
        owner,
        target,
        agentDir: target.kind === "agent" ? path.dirname(target.path) : undefined,
        inherited: Boolean(useShared && !requestedShared),
        scopedSharedStore,
        assertCurrent,
      };
    },
    async dispose() {
      disposed = true;
      const results = await Promise.allSettled(
        [...readers.values()].map((reader) => readerClosures.get(reader) ?? reader.dispose()),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Auth profile usage owner cleanup failed", {
          cause: errors[0],
        });
      }
    },
  };
}
