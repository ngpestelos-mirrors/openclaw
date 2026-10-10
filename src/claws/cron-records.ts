import type { Selectable } from "kysely";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { ClawCronJob } from "./types.js";
export const CLAW_CRON_REF_SCHEMA_VERSION = "openclaw.clawCronRef.v1" as const;

export type PersistedClawCronRef = {
  schemaVersion: typeof CLAW_CRON_REF_SCHEMA_VERSION;
  agentId: string;
  manifestId: string;
  declarationKey: string;
  schedulerJobId?: string;
  status: "pending" | "complete" | "failed" | "removed";
  job: ClawCronJob;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CronRefDatabase = Pick<DB, "claw_cron_refs">;
export type CronRefRow = Selectable<CronRefDatabase["claw_cron_refs"]>;

export class ClawCronInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cronJobs: PersistedClawCronRef[],
  ) {
    super(message);
    this.name = "ClawCronInstallError";
  }
}

export function rowToRef(row: CronRefRow): PersistedClawCronRef {
  return {
    schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    manifestId: row.manifest_id,
    declarationKey: row.declaration_key,
    ...(row.scheduler_job_id ? { schedulerJobId: row.scheduler_job_id } : {}),
    // SAFETY: Lifecycle writers own the existing persisted status enum.
    status: row.status as PersistedClawCronRef["status"],
    job: JSON.parse(row.job_json) as ClawCronJob,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function refToRow(ref: PersistedClawCronRef): CronRefRow {
  return {
    schema_version: ref.schemaVersion,
    agent_id: ref.agentId,
    manifest_id: ref.manifestId,
    declaration_key: ref.declarationKey,
    scheduler_job_id: ref.schedulerJobId ?? null,
    status: ref.status,
    job_json: JSON.stringify(ref.job),
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}
