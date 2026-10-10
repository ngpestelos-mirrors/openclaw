import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION =
  "openclaw.clawWorkspaceFileRecord.v1" as const;

export type PersistedClawWorkspaceFile = {
  schemaVersion: typeof CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION;
  agentId: string;
  workspace: string;
  path: string;
  sourcePath: string;
  contentDigest: string;
  status: "pending" | "complete" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
};

type WorkspaceDatabase = Pick<DB, "claw_workspace_files">;
type WorkspaceFileRow = Selectable<DB["claw_workspace_files"]>;

function selectWorkspaceFiles(db: DatabaseSync) {
  return getNodeSqliteKysely<WorkspaceDatabase>(db)
    .selectFrom("claw_workspace_files")
    .select([
      "schema_version",
      "agent_id",
      "workspace",
      "target_path",
      "source_path",
      "content_digest",
      "status",
      "created_at_ms",
      "updated_at_ms",
    ]);
}

function rowToWorkspaceFile(
  row: WorkspaceFileRow,
  schemaVersion: PersistedClawWorkspaceFile["schemaVersion"] = CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
): PersistedClawWorkspaceFile {
  return {
    schemaVersion,
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    // SAFETY: Inventory keeps its unchecked status contract; the retry reader validates it first.
    status: row.status as PersistedClawWorkspaceFile["status"],
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

function workspaceFileToRow(record: PersistedClawWorkspaceFile): WorkspaceFileRow {
  return {
    agent_id: record.agentId,
    target_path: record.path,
    schema_version: record.schemaVersion,
    workspace: record.workspace,
    source_path: record.sourcePath,
    content_digest: record.contentDigest,
    status: record.status,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
  };
}

export function insertClawWorkspaceFileInDatabase(
  db: DatabaseSync,
  record: PersistedClawWorkspaceFile,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WorkspaceDatabase>(db)
      .insertInto("claw_workspace_files")
      .values(workspaceFileToRow(record)),
  );
}

export function readClawWorkspaceFileInDatabase(
  db: DatabaseSync,
  agentId: string,
  targetPath: string,
): PersistedClawWorkspaceFile | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    selectWorkspaceFiles(db)
      .where("agent_id", "=", agentId)
      .where("target_path", "=", targetPath)
      .limit(1),
  );
  if (!row) {
    return undefined;
  }
  if (
    row.schema_version !== CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION ||
    (row.status !== "pending" && row.status !== "complete" && row.status !== "failed")
  ) {
    throw new Error(
      `Claw workspace file ${JSON.stringify(targetPath)} has unsupported provenance state.`,
    );
  }
  return rowToWorkspaceFile(row);
}

export function updateClawWorkspaceFileStatusInDatabase(
  db: DatabaseSync,
  record: PersistedClawWorkspaceFile,
  expectedStatuses: PersistedClawWorkspaceFile["status"][],
): void {
  const result = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WorkspaceDatabase>(db)
      .updateTable("claw_workspace_files")
      .set({ status: record.status, updated_at_ms: record.updatedAtMs })
      .where("agent_id", "=", record.agentId)
      .where("target_path", "=", record.path)
      .where("status", "in", expectedStatuses),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(
      `Claw workspace file ${JSON.stringify(record.path)} changed ownership state concurrently.`,
    );
  }
}

export function upsertClawWorkspaceFileInDatabase(
  db: DatabaseSync,
  record: PersistedClawWorkspaceFile,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WorkspaceDatabase>(db)
      .insertInto("claw_workspace_files")
      .values(workspaceFileToRow(record))
      .onConflict((conflict) =>
        conflict.columns(["agent_id", "target_path"]).doUpdateSet((eb) => ({
          schema_version: eb.ref("excluded.schema_version"),
          workspace: eb.ref("excluded.workspace"),
          source_path: eb.ref("excluded.source_path"),
          content_digest: eb.ref("excluded.content_digest"),
          status: eb.ref("excluded.status"),
          // Update rollback restores the complete prior record, including its creation time.
          created_at_ms: eb.ref("excluded.created_at_ms"),
          updated_at_ms: eb.ref("excluded.updated_at_ms"),
        })),
      ),
  );
}

export function deleteClawWorkspaceFileInDatabase(
  db: DatabaseSync,
  agentId: string,
  path: string,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WorkspaceDatabase>(db)
      .deleteFrom("claw_workspace_files")
      .where("agent_id", "=", agentId)
      .where("target_path", "=", path),
  );
}

export function readClawWorkspaceFilesInDatabase(
  db: DatabaseSync,
  agentId: string,
  readOnly = false,
): PersistedClawWorkspaceFile[] {
  if (readOnly && !tableExists(db, "claw_workspace_files")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string, WorkspaceFileRow>((parameter) =>
    selectWorkspaceFiles(db)
      .where(
        "agent_id",
        "=",
        parameter((value) => value),
      )
      .orderBy("target_path"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native list errors outside the write-transaction owner. */
      .prepare(compiled.sql)
      .all(...bind(agentId)) as WorkspaceFileRow[];
  return rows.map((row) => rowToWorkspaceFile(row));
}

export function readAllClawWorkspaceFilesInDatabase(
  db: DatabaseSync,
): PersistedClawWorkspaceFile[] {
  if (!tableExists(db, "claw_workspace_files")) {
    return [];
  }
  const compiled = selectWorkspaceFiles(db).orderBy("agent_id").orderBy("target_path").compile();
  const rows =
    db /* sqlite-allow-raw: preserve native orphan inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and shared explicit projection provide this generated row shape.
      .all() as WorkspaceFileRow[];
  // Orphan inventory reports the stored version; per-agent inventory uses the current constant.
  return rows.map((row) =>
    rowToWorkspaceFile(row, row.schema_version as PersistedClawWorkspaceFile["schemaVersion"]),
  );
}
