import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "./openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";

const templates = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeDatabases();
    cleanup();
  });
});
let templatePath: string;

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
}

beforeAll(async () => {
  const env = { OPENCLAW_STATE_DIR: templates.make("agent-integrity-recovery-template-") };
  templatePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  await closeDatabases();
});

it.each(["writable", "readonly", "async"] as const)(
  "refuses orphan rows and recovers %s admission after external repair",
  async (admission) => {
    const stateDir = tempDirs.make("agent-integrity-recovery-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const options = { agentId: "worker-1", env };
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.copyFileSync(templatePath, databasePath, fs.constants.COPYFILE_EXCL);

    const { DatabaseSync } = requireNodeSqlite();
    {
      using corrupted = new DatabaseSync(databasePath);
      corrupted.exec(`PRAGMA foreign_keys = OFF;
        INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
          VALUES ('orphan-window', 'missing-node', 1, 1);`);
      expect({
        quick: corrupted.prepare("PRAGMA quick_check").get(),
        integrity: corrupted.prepare("PRAGMA integrity_check").get(),
        foreignKey: corrupted.prepare("PRAGMA foreign_key_check").get(),
      }).toEqual({
        quick: { quick_check: "ok" },
        integrity: { integrity_check: "ok" },
        foreignKey: { table: "session_windows", rowid: 1, parent: "session_nodes", fkid: 1 },
      });
    }

    expect(() => openOpenClawAgentDatabase(options)).toThrow(
      /foreign_key_check failed.*session_windows row 1 references session_nodes \(foreign key 1\)/iu,
    );
    if (admission === "readonly") {
      const failure = new Error("foreign_key_check failed before external repair");
      failure.name = "SqliteIntegrityError";
      recordOpenClawAgentDatabaseOpenFailure(databasePath, failure);
      using changed = new DatabaseSync(databasePath);
      changed.prepare("UPDATE session_windows SET updated_at = 2").run();
    }
    const open = async () => {
      if (admission === "readonly") {
        const result = openOpenClawAgentDatabaseReadOnly(options);
        expect(result.found).toBe(true);
        if (result.found) {
          result.database.close();
        }
      } else if (admission === "async") {
        await withOpenClawAgentDatabaseAsync(options, () => undefined);
      } else {
        openOpenClawAgentDatabase(options);
      }
    };
    await expect(open()).rejects.toThrow("foreign_key_check failed");
    // External repair changes persisted rows without clearing this process's latch.
    {
      using repaired = new DatabaseSync(databasePath);
      repaired.prepare("DELETE FROM session_windows WHERE session_id = ?").run("orphan-window");
      expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    await expect(open()).resolves.toBeUndefined();
  },
);
