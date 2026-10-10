import type { SQLInputValue } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  ClawCronInstallError,
  rowToRef,
  refToRow,
  type CronRefDatabase,
  type CronRefRow,
  type PersistedClawCronRef,
} from "./cron-records.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export function persistPendingRef(
  plan: ClawAddPlan,
  job: ClawCronJob,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  const nowMs = options.nowMs ?? Date.now();
  const declarationKey = `claw:${plan.agent.finalId}:${job.id}`;
  const database = openOpenClawStateDatabase(options);
  const query = getNodeSqliteKysely<CronRefDatabase>(database.db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .where("agent_id", "=", plan.agent.finalId)
    .where("manifest_id", "=", job.id)
    .compile();
  const existing =
    database.db /* sqlite-allow-raw: execute compiled Kysely with the existing native read error boundary. */
      .prepare(query.sql)
      // SAFETY: Compiled predicates bind strings; the canonical schema supplies the row shape.
      .get(...(query.parameters as SQLInputValue[])) as CronRefRow | undefined;
  if (existing) {
    const ref = rowToRef(existing);
    if (ref.declarationKey !== declarationKey || JSON.stringify(ref.job) !== JSON.stringify(job)) {
      throw new ClawCronInstallError(
        "cron_provenance_conflict",
        `Cron declaration ${JSON.stringify(job.id)} differs from its pending ownership record.`,
        [ref],
      );
    }
    if (ref.status === "complete") {
      return ref;
    }
    return updateRef(ref, { status: "pending" }, options);
  }
  const record: PersistedClawCronRef = {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    manifestId: job.id,
    declarationKey,
    status: "pending",
    job,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .insertInto("claw_cron_refs")
        .values(refToRow(record)),
    );
  }, options);
  return record;
}

export function updateRef(
  ref: PersistedClawCronRef,
  update: { schedulerJobId?: string; status: PersistedClawCronRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawCronRef {
  // Omitted fields are cleared in SQLite and must not survive in the returned result.
  const { schedulerJobId: _schedulerJobId, error: _error, ...retained } = ref;
  const updated = {
    ...retained,
    ...update,
    updatedAtMs: options.nowMs ?? Date.now(),
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .updateTable("claw_cron_refs")
        .set({
          scheduler_job_id: updated.schedulerJobId ?? null,
          status: updated.status,
          error: updated.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("manifest_id", "=", ref.manifestId),
    );
  }, options);
  return updated;
}

export function readClawCronRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawCronRef[] {
  const database = openOpenClawStateDatabase(options);
  if (
    options.readOnly &&
    !database.db /* sqlite-allow-raw: read-only Claw cron table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_cron_refs'")
      .get()
  ) {
    return [];
  }
  const query = getNodeSqliteKysely<CronRefDatabase>(database.db)
    .selectFrom("claw_cron_refs")
    .selectAll()
    .where("agent_id", "=", agentId)
    .orderBy("manifest_id")
    .compile();
  const rows =
    database.db /* sqlite-allow-raw: execute compiled Kysely with the existing native read error boundary. */
      .prepare(query.sql)
      // SAFETY: The compiled predicate binds a string; the canonical schema supplies the row shape.
      .all(...(query.parameters as SQLInputValue[])) as CronRefRow[];
  return rows.map(rowToRef);
}

export function deleteClawCronRef(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .deleteFrom("claw_cron_refs")
        .where("agent_id", "=", agentId)
        .where("manifest_id", "=", manifestId),
    );
  }, options);
}

export function markClawCronRefRemoved(
  agentId: string,
  manifestId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawCronRef | undefined {
  const ref = readClawCronRefs(agentId, options).find(
    (candidate) => candidate.manifestId === manifestId,
  );
  return ref ? updateRef(ref, { status: "removed" }, options) : undefined;
}

export function upsertClawCronRef(
  ref: PersistedClawCronRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<CronRefDatabase>(db)
        .insertInto("claw_cron_refs")
        .values(refToRow(ref))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "manifest_id"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            declaration_key: eb.ref("excluded.declaration_key"),
            scheduler_job_id: eb.ref("excluded.scheduler_job_id"),
            status: eb.ref("excluded.status"),
            job_json: eb.ref("excluded.job_json"),
            error: eb.ref("excluded.error"),
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}
