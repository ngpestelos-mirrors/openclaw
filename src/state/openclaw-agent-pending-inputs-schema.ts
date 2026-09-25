import type { DatabaseSync } from "node:sqlite";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import {
  getAdmittedSqliteSchemaFacts,
  type SqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export const SESSION_PENDING_INPUTS_TABLE = "session_pending_inputs";
export const SESSION_INPUT_COMPLETIONS_TABLE = "session_input_completions";
const completeDatabases = new WeakSet<DatabaseSync>();
const completionDatabases = new WeakSet<DatabaseSync>();
const consumptionColumns = new WeakMap<SqliteSchemaFacts, boolean>();

function retainSchemaReadiness(db: DatabaseSync, ready: WeakSet<DatabaseSync>): void {
  if (!db.isTransaction) {
    ready.add(db);
    return;
  }
  stageSqliteTransactionState(db, {
    stage: () => ready.add(db),
    commit: () => {},
    rollback: () => ready.delete(db),
  });
}

/** Admitted schema facts observe feature creation by another worker on the next snapshot. */
export function hasSessionPendingInputsSchema(db: DatabaseSync): boolean {
  return tableExists(db, SESSION_PENDING_INPUTS_TABLE);
}

/** Lazily installs accepted-input custody without changing either schema version marker. */
export function ensureSessionPendingInputsSchema(db: DatabaseSync): void {
  if (completeDatabases.has(db)) {
    return;
  }
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    `CREATE TABLE IF NOT EXISTS ${SESSION_PENDING_INPUTS_TABLE} (`,
  );
  if (start < 0) {
    throw new Error("OpenClaw pending-input schema marker is missing.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw -- Canonical additive DDL only; application data uses Kysely.
    db.exec(
      OPENCLAW_AGENT_SCHEMA_SQL.slice(
        start,
        OPENCLAW_AGENT_SCHEMA_SQL.indexOf("-- Processing completion"),
      ),
    );
    ensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");
  });
  retainSchemaReadiness(db, completeDatabases);
}

/** Completion tracking is opt-in; ordinary input admission does not create this table. */
export function ensureSessionInputCompletionsSchema(db: DatabaseSync): void {
  if (completionDatabases.has(db)) {
    return;
  }
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(
    "CREATE TABLE IF NOT EXISTS session_input_completions (",
  );
  if (start < 0) {
    throw new Error("OpenClaw input-completion schema marker is missing.");
  }
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(OPENCLAW_AGENT_SCHEMA_SQL.slice(start)); // sqlite-allow-raw -- Canonical additive DDL only.
  });
  retainSchemaReadiness(db, completionDatabases);
}

/** Existing same-version stores converge through Doctor/open; absent tables stay feature-local. */
export function hasPendingInputConsumptionColumnMigration(db: DatabaseSync): boolean {
  return (
    hasSessionPendingInputsSchema(db) &&
    !tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id")
  );
}

export function ensurePendingInputConsumptionColumn(db: DatabaseSync): void {
  ensureColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id TEXT");
}

/** Read-only callers can inspect pre-feature stores without installing schema. */
export function hasPendingInputConsumptionColumn(db: DatabaseSync): boolean {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const cached = schema ? consumptionColumns.get(schema) : undefined;
  if (cached !== undefined) {
    return cached;
  }
  const present = tableHasColumn(db, SESSION_PENDING_INPUTS_TABLE, "consumed_event_id");
  if (schema) {
    consumptionColumns.set(schema, present);
  }
  return present;
}
