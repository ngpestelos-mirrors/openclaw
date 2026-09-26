import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveUserPath } from "../../utils.js";
import { authProfilesLog } from "./constants.js";
import {
  captureAuthProfileMutationSource,
  runAuthProfileMutationAdmission,
} from "./mutation-admission.js";
import { resolveSharedAuthStoreOwnership, resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthProfileDatabaseOwnerId, resolveAuthProfileDatabasePath } from "./sqlite.js";

/** Capture legacy mutations before OAuth locks or the shared mutation FIFO can yield. */
export function captureAuthProfileStoreMutation(params: {
  agentDir?: string;
  profileId?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}) {
  const env = cloneEnvWithPlatformSemantics(params.env ?? process.env);
  if (!params.env && params.stateDir) {
    env.OPENCLAW_STATE_DIR = params.stateDir;
    env.OPENCLAW_AGENT_DIR = undefined;
  }
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentDir = params.agentDir ? resolveUserPath(params.agentDir, env) : undefined;
  const personal = params.profileId && isUserModelAuthProfileId(params.profileId);
  const databasePath = !personal
    ? agentDir
      ? resolveAuthProfileDatabasePath(agentDir)
      : resolveSharedAuthStorePath(env)
    : undefined;
  const agent =
    databasePath && (agentDir || resolveSharedAuthStoreOwnership(env).location === "legacy-main")
      ? {
          path: databasePath,
          agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(databasePath)),
        }
      : undefined;
  const source = captureAuthProfileMutationSource({ env, agent });
  return { env, source, agentDir };
}

/** Async store mutations retain their existing lock-contention result contract. */
export async function runAuthProfileStoreMutation<T>(
  params: Parameters<typeof captureAuthProfileStoreMutation>[0],
  operation: (env: NodeJS.ProcessEnv, admit: () => void) => Promise<T>,
): Promise<T | null> {
  let captured: ReturnType<typeof captureAuthProfileStoreMutation> | undefined;
  try {
    captured = captureAuthProfileStoreMutation(params);
    const { env, source } = captured;
    return await runAuthProfileMutationAdmission(env, () => {
      source.admit();
      return operation(env, source.admit);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    authProfilesLog.warn(`auth profile store update failed: ${message}`, {
      agentDir: params.agentDir,
      error: message,
    });
    if (!isSqliteLockError(error)) {
      throw error;
    }
    return null;
  } finally {
    captured?.source.dispose();
  }
}
