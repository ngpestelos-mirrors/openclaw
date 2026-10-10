import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
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
    cleanup();
  }),
);

it("keeps purge's native generation alive when a retained ordinary borrower is refused", async () => {
  const root = fs.realpathSync(tempDirs.make("delete-retained-writer-"));
  const env = { OPENCLAW_STATE_DIR: root };
  const agentId = "worker";
  const database = openOpenClawAgentDatabase({ agentId, env });
  const target = { agentId, path: database.path };
  replaceSessionEntrySync(
    { agentId, env, sessionKey: "agent:worker:main" },
    { sessionId: "before", updatedAt: 1 },
  );
  await closeOpenClawAgentDatabasesAsync();
  const retained = execution.captureOpenClawAgentDatabaseExecution({ ...target, env });
  const prepared = createDeferredCore();
  const resumePurge = createDeferredCore();
  const closing = createDeferredCore();
  const create = native.createAgentDatabaseNativeGeneration;
  vi.spyOn(native, "createAgentDatabaseNativeGeneration").mockImplementationOnce((...args) => {
    const generation = create(...args);
    let operations = 0;
    return {
      ...generation,
      run(source, operation, ...request) {
        return generation.run(
          source,
          async (scope) => {
            if (++operations === 2) {
              prepared.resolve();
              await resumePurge.promise;
            }
            return operation(scope);
          },
          ...request,
        );
      },
      close() {
        closing.resolve();
        return generation.close();
      },
    };
  });
  try {
    await withAgentDeletion(
      agentId,
      async (begin) => {
        const deletion = await begin({
          agentId,
          agentDir: path.dirname(target.path),
          workspaceDir: path.join(root, "workspace"),
          sessionsDir: path.join(root, "agents", agentId, "sessions"),
        });
        const purging = deletion.runDatabaseCleanup(target, () =>
          purgeDeletedAgentSessionEntries({
            cfg: { agents: { entries: { worker: {}, kept: {} } } },
            agentId,
            storeAgentId: agentId,
            storePath: target.path,
            env,
          }),
        );
        const purged = expect(purging).resolves.toBeUndefined();
        try {
          await awaitGateBeforeSettlement(
            prepared.promise,
            purging,
            "purge did not prepare its native generation",
          );
          const staleOperation = vi.fn(async () => undefined);
          const refused = expect(
            retained.runExisting(
              {
                assertCurrent() {},
                createAdmission() {
                  throw new Error("Refused borrower reached native admission");
                },
              },
              staleOperation,
              { retireNativeOnFailure: true },
            ),
          ).rejects.toThrow(/active deletion cleanup|execution admission is closed/);
          await Promise.race([closing.promise, refused]);
          resumePurge.resolve();
          await refused;
          expect(staleOperation).not.toHaveBeenCalled();
        } finally {
          resumePurge.resolve();
          await purged;
        }
      },
      { env },
    );
  } finally {
    resumePurge.resolve();
    await retained.release();
  }
  const reader = openNodeSqliteDatabase(target.path, { readOnly: true });
  try {
    expect(reader.prepare("SELECT session_key FROM session_nodes").all()).toEqual([]);
  } finally {
    reader.close();
  }
});
