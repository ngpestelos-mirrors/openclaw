import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { purgeDeletedAgentSessionEntries } from "../config/sessions/session-agent-purge.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import * as native from "./openclaw-agent-execution-native.js";
import * as execution from "./openclaw-agent-execution.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    cleanup();
  }),
);

it.each(["before", "after"] as const)(
  "purges after a straggling entry patch starts %s cleanup captures its executor",
  async (timing) => {
    const root = fs.realpathSync(tempDirs.make("delete-late-write-"));
    const env = { OPENCLAW_STATE_DIR: root };
    const agentId = "worker";
    const database = openOpenClawAgentDatabase({ agentId, env });
    const target = { agentId, path: database.path };
    const scope = { agentId, env, sessionKey: "agent:worker:main" };
    replaceSessionEntrySync(scope, { sessionId: "before", updatedAt: 1 });
    await closeOpenClawAgentDatabasesAsync();
    const cfg = { agents: { entries: { worker: {}, kept: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const refused = createDeferredCore();
    const resumePatch = createDeferredCore();
    const captured = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const create = native.createAgentDatabaseNativeGeneration;
    if (timing === "before") {
      vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementationOnce((...args) => {
        const generation = create(...args);
        return {
          ...generation,
          async run(...request) {
            try {
              return await generation.run(...request);
            } catch (error) {
              refused.resolve();
              await resumePatch.promise;
              throw error;
            }
          },
        };
      });
    }
    const patch = () => patchSessionEntryCore(scope, () => ({ label: "late" }));
    await withAgentDeletion(
      agentId,
      async (begin) => {
        const deletion = await begin({
          agentId,
          agentDir: path.dirname(target.path),
          workspaceDir: path.join(root, "workspace"),
          sessionsDir: path.join(root, "agents", agentId, "sessions"),
        });
        let patched: Promise<void> | undefined;
        if (timing === "before") {
          patched = expect(patch()).rejects.toThrow("unavailable while agent worker is deleted");
          await awaitGateBeforeSettlement(
            refused.promise,
            patched,
            "patch did not reach native refusal",
          );
        }
        const capture = execution.captureOpenClawAgentDatabaseExecution;
        vi.spyOn(execution, "captureOpenClawAgentDatabaseExecution").mockImplementation(
          (...args) => {
            const borrowed = capture(...args);
            captured.resolve();
            return borrowed;
          },
        );
        const purging = deletion.runDatabaseCleanup(target, async () => {
          await purgeDeletedAgentSessionEntries({
            cfg,
            agentId,
            storeAgentId: agentId,
            storePath: target.path,
            env,
          });
          await releaseCleanup.promise;
        });
        const purged = expect(purging).resolves.toBeUndefined();
        try {
          await awaitGateBeforeSettlement(
            captured.promise,
            purging,
            "purge did not capture its executor",
          );
          setRuntimeConfigSnapshot({ agents: { entries: { kept: {} } } });
          if (timing === "after") {
            patched = expect(patch()).rejects.toThrow("active deletion cleanup");
          }
          resumePatch.resolve();
          await patched;
        } finally {
          resumePatch.resolve();
          releaseCleanup.resolve();
          await purged;
        }
      },
      { env },
    );
    const reader = openNodeSqliteDatabase(target.path, { readOnly: true });
    try {
      expect(reader.prepare("SELECT session_key FROM session_nodes").all()).toEqual([]);
    } finally {
      reader.close();
    }
  },
);
