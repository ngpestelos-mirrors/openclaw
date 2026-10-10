import type { DatabaseSync } from "node:sqlite";
import { hasErrnoCode } from "../infra/errno.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawMcpServer } from "./mcp-digest.js";
import {
  CLAW_MCP_REF_SCHEMA_VERSION,
  ClawMcpInstallError,
  refToRow,
  rowToRef,
  selectMcpRefs,
  type McpDatabase,
  type McpRefRow,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";
export function persistPendingRef(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const nowMs = options.nowMs ?? Date.now();
  const configDigest = digestClawMcpServer(server);
  const database = openOpenClawStateDatabase(options);
  const { compiled, bind } = compileSqliteQueryBindings<{ agentId: string; name: string }>(
    (parameter) =>
      selectMcpRefs(database.db)
        .where(
          "agent_id",
          "=",
          parameter((value) => value.agentId),
        )
        .where(
          "name",
          "=",
          parameter((value) => value.name),
        ),
  );
  const existing =
    database.db /* sqlite-allow-raw: preserve native point-read errors outside the write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .get(...bind({ agentId: plan.agent.finalId, name })) as McpRefRow | undefined;
  if (existing) {
    const ref = rowToRef(existing);
    if (ref.configDigest !== configDigest || ref.status === "failed") {
      throw new ClawMcpInstallError(
        "mcp_provenance_conflict",
        `MCP server ${JSON.stringify(name)} differs from its ownership record.`,
        [ref],
      );
    }
    return ref;
  }
  const ref: PersistedClawMcpServerRef = {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    name,
    configDigest,
    ...ownership,
    status: "pending",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db).insertInto("claw_mcp_server_refs").values(refToRow(ref)),
    );
  }, options);
  return ref;
}

export function updateRef(
  ref: PersistedClawMcpServerRef,
  update: { status: PersistedClawMcpServerRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const updated = { ...ref, ...update, updatedAtMs: options.nowMs ?? Date.now() };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .updateTable("claw_mcp_server_refs")
        .set({
          status: update.status,
          error: update.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("name", "=", ref.name),
    );
  }, options);
  return updated;
}

export function readMcpRefsByIdentity(
  db: DatabaseSync,
  column: "agent_id" | "name",
  value: string,
  readOnly = false,
): PersistedClawMcpServerRef[] {
  if (readOnly && getAdmittedSqliteSchemaFacts(db)?.tables.has("claw_mcp_server_refs") === false) {
    return [];
  }
  try {
    const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
      selectMcpRefs(db)
        .where(
          column,
          "=",
          parameter((identity) => identity),
        )
        .orderBy(column === "agent_id" ? "name" : "agent_id"),
    );
    const rows =
      db /* sqlite-allow-raw: preserve native full-agent inventory errors without a write transaction. */
        .prepare(compiled.sql)
        // SAFETY: The canonical table and explicit projection provide this generated row shape.
        .all(...bind(value)) as McpRefRow[];
    return rows.map(rowToRef);
  } catch (error) {
    // Legacy read-only inventories may predate this table; every other native error still fails.
    if (
      readOnly &&
      error instanceof Error &&
      hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
      /^no such table: claw_mcp_server_refs$/iu.test(error.message)
    ) {
      return [];
    }
    throw error;
  }
}
export function readClawMcpServerRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  return readMcpRefsByIdentity(
    openOpenClawStateDatabase(options).db,
    "agent_id",
    agentId,
    options.readOnly,
  );
}

export function readClawMcpServerRefsByName(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  return readMcpRefsByIdentity(
    openOpenClawStateDatabase(options).db,
    "name",
    name,
    options.readOnly,
  );
}

export function deleteClawMcpServerRef(
  agentId: string,
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .deleteFrom("claw_mcp_server_refs")
        .where("agent_id", "=", agentId)
        .where("name", "=", name),
    );
  }, options);
}

export function upsertClawMcpServerRef(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .insertInto("claw_mcp_server_refs")
        .values(refToRow(ref))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "name"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            config_digest: eb.ref("excluded.config_digest"),
            relationship: eb.ref("excluded.relationship"),
            origin: eb.ref("excluded.origin"),
            independent_owner: eb.ref("excluded.independent_owner"),
            status: eb.ref("excluded.status"),
            error: eb.ref("excluded.error"),
            // Existing claims retain their original creation timestamp through updates and undo.
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}
