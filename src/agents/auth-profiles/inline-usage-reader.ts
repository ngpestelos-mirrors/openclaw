import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../../state/openclaw-agent-worker-store.js";
import type { AuthProfileUsageOperations } from "./inline-usage-kernel.js";
import { captureAuthProfileMutationSource } from "./mutation-admission.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import type { AuthProfileRowRead } from "./types.js";

/** Fresh usage rows borrow the canonical executor instead of launching a disposable reader. */
export function captureAgentAuthProfileUsageRead(options: {
  databasePath: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
}): {
  identity: DatabasePathIdentity;
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
  dispose: () => Promise<void>;
} {
  const target = {
    path: path.resolve(options.databasePath),
    agentId: options.agentId,
    env: cloneEnvWithPlatformSemantics(options.env),
  };
  const identity = readDatabasePathIdentitySync(target.path);
  if (!identity.key.startsWith("file:")) {
    const source = captureAuthProfileMutationSource({ env: target.env, agent: target });
    let reader: ReturnType<typeof captureAgentAuthProfileUsageRead> | undefined;
    return {
      get identity() {
        return reader?.identity ?? identity;
      },
      read() {
        source.admit();
        if (!reader) {
          const current = readDatabasePathIdentitySync(target.path);
          reader = current.key.startsWith("file:")
            ? captureAgentAuthProfileUsageRead(options)
            : { ...prepareAgentAuthProfileRowsRead(options), identity: current };
        }
        return reader.read();
      },
      assertCurrent() {
        source.assertCurrent();
        reader?.assertCurrent();
      },
      async dispose() {
        source.dispose();
        await reader?.dispose();
      },
    };
  }
  const execution = captureOpenClawAgentDatabaseExecution(target, {
    expectedIdentity: {
      kind: "file",
      physicalIdentity: identity.key.slice("file:".length),
      nativeLocation: identity.canonicalPath,
      birthtime: identity.birthtime,
    },
  });
  let client: Promise<OpenClawAgentSqliteWorkerStore<AuthProfileUsageOperations>> | undefined;
  const pending = new Set<Promise<AuthProfileRowRead>>();
  let disposed = false;
  let closing: Promise<void> | undefined;
  const assertCurrent = () => {
    if (disposed) {
      throw new Error("Auth profile usage reader was released");
    }
    execution.assertCurrent();
    const current = readDatabasePathIdentitySync(target.path);
    if (
      current.key !== identity.key ||
      current.canonicalPath !== identity.canonicalPath ||
      current.birthtime !== identity.birthtime
    ) {
      throw new Error("Auth profile database file identity changed during its read");
    }
  };
  return {
    identity,
    read() {
      const operation = (async (): Promise<AuthProfileRowRead> => {
        assertCurrent();
        client ??= openOpenClawAgentSqliteWorkerStore<AuthProfileUsageOperations>(
          target,
          { execution },
          {
            moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileInlineUsage),
            input: {},
          },
        );
        const reader = await client;
        assertCurrent();
        const rows = await reader.run(
          (scope) => scope.execute({ type: "authProfiles.usageSnapshot", input: undefined }),
          assertCurrent,
        );
        assertCurrent();
        return rows;
      })();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => undefined);
      return operation;
    },
    assertCurrent,
    dispose() {
      disposed = true;
      closing ??= (async () => {
        await Promise.allSettled(pending);
        const failures: unknown[] = [];
        // Failed setup settles with its read; only a successfully opened client owns cleanup.
        const opened = await client?.catch(() => undefined);
        try {
          await opened?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await execution.release();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Auth profile usage reader cleanup failed", {
            cause: failures[0],
          });
        }
      })();
      return closing;
    },
  };
}
