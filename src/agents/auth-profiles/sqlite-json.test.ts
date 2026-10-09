import path from "node:path";
import { StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  inspectAgentAuthProfileJsonCellReadOnly,
  readAuthProfileRowsReadOnly,
  writeAuthProfileJsonCell,
} from "./sqlite-json.js";
import { closeAuthProfileReadDatabase } from "./sqlite-read-pool.js";
import type { PersistedAuthProfileStoreInspection } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses admitted auth table facts across readers and refreshes them after owner writes", () => {
  const databasePath = path.join(tempDirs.make("auth-schema-facts-"), "agent.sqlite");
  const writer = openNodeSqliteDatabase(databasePath);
  const storeSchema = `CREATE TABLE auth_profile_store (
    store_key TEXT PRIMARY KEY, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`;
  const first = { version: 1, profiles: {} };
  const updated = { version: 1, profiles: { synthetic: { type: "api_key", key: "fixture" } } };
  const missingTable = { status: "missing", reason: "table" } as const;
  let observation: ReturnType<typeof observeSqliteReadSql> | undefined;
  try {
    writer.exec(storeSchema);
    admitSqliteSchema(writer);
    runSqliteImmediateTransactionSync(writer, () =>
      writeAuthProfileJsonCell(writer, "store", "agent", first),
    );
    observation = observeSqliteReadSql(StatementSync.prototype);
    const reads = observation;
    const assertRows = (
      store: PersistedAuthProfileStoreInspection,
      state: PersistedAuthProfileStoreInspection = missingTable,
    ) => {
      reads.queries.length = 0;
      expect(inspectAgentAuthProfileJsonCellReadOnly(databasePath, "store")).toEqual(store);
      expect(readAuthProfileRowsReadOnly(databasePath)).toMatchObject({ store, state });
      // The batched reader closes its native handle; the next read borrows the same facts.
      expect(inspectAgentAuthProfileJsonCellReadOnly(databasePath, "store")).toEqual(store);
      expect(
        reads.queries.filter((sql) => /\b(?:sqlite_master|sqlite_schema)\b/iu.test(sql)),
      ).toEqual([]);
    };

    assertRows({ status: "readable", raw: first });
    runSqliteImmediateTransactionSync(writer, () =>
      writeAuthProfileJsonCell(writer, "store", "agent", updated),
    );
    assertRows({ status: "readable", raw: updated });

    writer.exec(
      "DROP TABLE auth_profile_store; CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json",
    );
    assertRows({ status: "unreadable" });
    writer.exec("DROP VIEW auth_profile_store");
    assertRows(missingTable);

    writer.exec(`${storeSchema}; CREATE TABLE auth_profile_state (
      state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const state = { lastGood: { fixture: "synthetic" } };
    runSqliteImmediateTransactionSync(writer, () => {
      writeAuthProfileJsonCell(writer, "store", "agent", updated);
      writeAuthProfileJsonCell(writer, "state", "agent", state);
    });
    assertRows({ status: "readable", raw: updated }, { status: "readable", raw: state });
  } finally {
    observation?.restore();
    closeAuthProfileReadDatabase(databasePath);
    writer.close();
  }
});
