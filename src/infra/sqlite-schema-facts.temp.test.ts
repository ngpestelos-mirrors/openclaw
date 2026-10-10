import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { readSessionNodesGeneration } from "../config/sessions/session-accessor.sqlite-entry-revision.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { getSqliteDatabaseSchemaRevision } from "./sqlite-database-admission.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  registerSqliteSchemaMutationListener,
} from "./sqlite-schema-facts.js";
import { useSqliteSchemaTestFixture } from "./sqlite-schema-facts.test-support.js";

describe("connection-local SQLite schema admission", () => {
  const { tempDirs, openDatabase } = useSqliteSchemaTestFixture();

  it.each([false, true])(
    "keeps TEMP trigger admission local without hiding subsequent main DDL: %s",
    (mainDdl) => {
      const filename = path.join(tempDirs.make("openclaw-schema-temp-trigger-"), "state.sqlite");
      const writer = openDatabase(undefined, true, filename);
      const sibling = openDatabase("", true, filename);
      const before = getAdmittedSqliteSchemaFacts(sibling)?.admissionId;
      expect(before).toEqual(expect.any(String));
      const revision = getSqliteDatabaseSchemaRevision(sibling)!;
      const localMutation = vi.fn();
      registerSqliteSchemaMutationListener(writer, localMutation);
      writer.exec(`CREATE TEMP TRIGGER IF NOT EXISTS local_observer AFTER INSERT ON original BEGIN
        SELECT CASE WHEN NEW.id > 0 THEN 'END; CREATE TABLE quoted(id)' ELSE 'kept' END;
        /* END; */ SELECT 1;
        END;
        ${mainDdl ? "CREATE TABLE published_after_trigger(id);" : ""}`);
      expect(localMutation).toHaveBeenCalledWith(undefined);
      const after = getAdmittedSqliteSchemaFacts(sibling)?.admissionId;
      if (mainDdl) {
        expect(getSqliteDatabaseSchemaRevision(sibling)).toBeGreaterThan(revision);
        expect(after).not.toBe(before);
      } else {
        expect(getSqliteDatabaseSchemaRevision(sibling)).toBe(revision);
        expect(after).toBe(before);
      }
      expect(tableExists(sibling, "published_after_trigger")).toBe(mainDdl);
      expect(
        writer.prepare("SELECT name FROM temp.sqlite_schema WHERE type='trigger'").all(),
      ).toEqual([{ name: "local_observer" }]);
    },
  );

  it.each([
    "CREATE TABLE unexpected (id INTEGER)",
    "DROP TABLE session_nodes",
    "DROP TABLE main.session_nodes",
    "DROP TABLE temp.openclaw_session_nodes_cache_generation; CREATE TABLE unexpected (id)",
    "DROP TRIGGER temp.openclaw_session_nodes_cache_generation_update",
    "ALTER TABLE temp.openclaw_session_nodes_cache_generation ADD COLUMN unexpected INTEGER",
  ])("still revokes admission for ordinary DDL after tracker installation: %s", (sql) => {
    const database = openDatabase("CREATE TABLE session_nodes (id INTEGER)");
    readSessionNodesGeneration(database);
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    database.exec(sql);
    expect(schemaMutation).toHaveBeenCalledWith(undefined);
  });

  it("observes reentrant MAIN DDL during a declared tracker installation", () => {
    const database = openDatabase("CREATE TABLE session_nodes (id INTEGER)");
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    const nativeExec = DatabaseSync.prototype.exec.bind(database);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce((sql) => {
      database.exec("CREATE TABLE unexpected (id INTEGER)");
      return nativeExec(sql);
    });
    try {
      readSessionNodesGeneration(database);
      expect(schemaMutation).toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it("revokes admission when tracker installation fails after creating its counter", () => {
    const database = openDatabase();
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    expect(() => readSessionNodesGeneration(database)).toThrow(/session_nodes/u);
    expect(schemaMutation).toHaveBeenCalled();
  });

  it.each([
    "CREATE TEMP TABLE openclaw_session_nodes_cache_generation (id INTEGER PRIMARY KEY, generation INTEGER)",
    "CREATE TEMP TRIGGER openclaw_session_nodes_cache_generation_update AFTER INSERT ON main.session_nodes BEGIN SELECT 1; END",
  ])("revokes admission for a preexisting mismatched tracker object: %s", (sql) => {
    const database = openDatabase(`CREATE TABLE session_nodes (id INTEGER); ${sql}`);
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    readSessionNodesGeneration(database);
    expect(schemaMutation).toHaveBeenCalled();
  });

  it("retains readmitted facts when reinstalling the tracker's existing exact shapes", () => {
    const database = openDatabase("CREATE TABLE session_nodes (id INTEGER)");
    expect(readSessionNodesGeneration(database)).toBe(0);
    database.exec("ALTER TABLE session_nodes ADD COLUMN value TEXT");
    admitSqliteSchema(database);
    const schemaMutation = vi.fn();
    registerSqliteSchemaMutationListener(database, schemaMutation);
    expect(readSessionNodesGeneration(database)).toBe(1);
    expect(schemaMutation).not.toHaveBeenCalled();
    database.exec("INSERT INTO session_nodes (id) VALUES (1)");
    expect(readSessionNodesGeneration(database)).toBe(2);
  });
});
