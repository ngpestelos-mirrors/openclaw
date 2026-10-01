import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../state/openclaw-state-snapshot-sanitizer.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import { noteCronJobsStoreCommit } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  resolveCronJobGrantDefinitionRevision,
  upsertCronJobRow,
} from "./store/row-codec.js";
import { loadCronRuntimeAuthorities } from "./store/runtime-authority-store.js";
import { tryParseJsonObject } from "./store/scalar-codec.js";
import { getCronStoreKysely } from "./store/schema.js";

export type MigratedDefaultCronToolCap = {
  jobId: string;
  name: string;
  previousToolsAllow: string[];
};

/**
 * Marked agent turns with a scheduled owner policy. Script runtimes reach MCP only
 * through servers named in the list, policy-less jobs have no owner session to
 * inherit from, and Codex app authority is bound to the captured list, so those
 * rows stay byte-for-byte untouched.
 */
function loadInheritingDefaultCapRows(db: DatabaseSync, storeKey: string) {
  const rows = loadCronRows(db, storeKey, undefined, {
    includeGrantDefinitionProjection: true,
  }).filter((row) => {
    const payload = tryParseJsonObject(row.job_json)?.payload;
    return isRecord(payload) && payload.toolsAllowIsDefault === true;
  });
  const jobs = loadedCronStoreFromRows(rows).store.jobs;
  loadCronRuntimeAuthorities({ db, storeKey, jobs });
  const jobsById = new Map(jobs.map((job) => [job.id, job] as const));
  return rows.flatMap((row) => {
    const job = jobsById.get(row.job_id);
    return job &&
      job.payload.kind === "agentTurn" &&
      !job.trigger?.script.trim() &&
      !job.runtimeAuthority &&
      !job.runtimeAuthorityRecoveryRequired &&
      resolveCronScheduledToolPolicy({
        toolsAllow: job.payload.toolsAllow,
        scheduledToolPolicy: job.scheduledToolPolicy,
        owner: job.owner,
      })
      ? [{ row, job }]
      : [];
  });
}

/**
 * Standing exec grants bind to an exact command for this job, not to its tool list,
 * so grants that were valid before the rewrite follow the job to its new revision.
 */
function rebindCronJobStandingGrants(
  db: DatabaseSync,
  params: {
    jobId: string;
    previous: { configRevision: string; generation: number };
    next: { configRevision: string; generation: number };
  },
): void {
  if (!tableExists(db, "operator_approval_standing_grants")) {
    return;
  }
  const stateDb = getCronStoreKysely(db);
  const grantIds = executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("operator_approval_standing_grants as grant")
      .innerJoin(
        "operator_approval_standing_grant_generations as generation",
        "generation.grant_id",
        "grant.grant_id",
      )
      .select("grant.grant_id")
      .where("grant.cron_job_id", "=", params.jobId)
      .where("grant.revoked_at_ms", "is", null)
      .where("grant.job_config_revision", "=", params.previous.configRevision)
      .where("generation.job_definition_generation", "=", params.previous.generation),
  ).rows.map((row) => row.grant_id);
  if (grantIds.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("operator_approval_standing_grants")
      .set({ job_config_revision: params.next.configRevision })
      .where("grant_id", "in", grantIds),
  );
  executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("operator_approval_standing_grant_generations")
      .set({ job_definition_generation: params.next.generation })
      .where("grant_id", "in", grantIds),
  );
}

/**
 * Older builds froze the creator's tool list into agent-created jobs and marked
 * it `toolsAllowIsDefault`. Eligible agent turns now store `*`, so runs inherit
 * the owner session's current policy. Standing exec grants follow the rewrite in
 * the same transaction, after a verified state-database backup.
 */
export async function migrateLegacyDefaultCronToolCaps(params: {
  storePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ migrated: MigratedDefaultCronToolCap[]; backupPath?: string }> {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  const readEvidence = (db: DatabaseSync) =>
    loadInheritingDefaultCapRows(db, storeKey).map(({ row }) => ({
      job_id: row.job_id,
      job_json: row.job_json,
    }));
  const evidence = runOpenClawStateWriteTransaction(
    ({ db }) => readEvidence(db),
    { env: params.env },
    { operationLabel: "cron.legacy-default-tool-caps.inspect" },
  );
  if (evidence.length === 0) {
    return { migrated: [] };
  }
  const assertRowsUnchanged = (db: DatabaseSync) => {
    if (!isDeepStrictEqual(readEvidence(db), evidence)) {
      throw new Error("Cron tool lists changed during migration; it retries on the next start.");
    }
  };
  const sourcePath = resolveOpenClawStateSqlitePath(params.env);
  const backupPath = `${sourcePath}.cron-default-tool-caps-${Date.now()}.bak`;
  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath: backupPath,
    preserveRowIds: true,
    transform: sanitizeOpenClawStateLeaseRows,
    requireNonEmptySource: true,
    validate: assertRowsUnchanged,
  });
  const migrated = runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertRowsUnchanged(db);
      const entries = loadInheritingDefaultCapRows(db, storeKey).map(({ row, job }) => ({
        row,
        job,
        // Matches the revision a standing grant was minted against; only grants
        // that are valid right now are carried to the rewritten job.
        previousGrantBinding:
          row.grant_definition_revision === resolveCronJobGrantDefinitionRevision(job) &&
          row.grant_definition_updated_at === row.updated_at &&
          typeof row.grant_definition_generation === "number"
            ? {
                configRevision: resolveCronJobConfigRevision(job),
                generation: row.grant_definition_generation,
              }
            : undefined,
      }));
      const result: MigratedDefaultCronToolCap[] = [];
      for (const { row, job, previousGrantBinding } of entries) {
        const previousToolsAllow = job.payload.toolsAllow ?? [];
        Reflect.deleteProperty(job.payload, "toolsAllowIsDefault");
        job.payload.toolsAllow = ["*"];
        if (job.toolsAllowExecTargetRequirement?.target) {
          job.toolsAllowExecTargetRequirement.grantIndex = 0;
        }
        upsertCronJobRow(db, storeKey, job, row.sort_order);
        const nextRows = loadCronRows(db, storeKey, new Set([job.id]), {
          includeGrantDefinitionProjection: true,
        });
        const nextJob = loadedCronStoreFromRows(nextRows).store.jobs[0];
        const nextGeneration = nextRows[0]?.grant_definition_generation;
        if (previousGrantBinding && nextJob && typeof nextGeneration === "number") {
          rebindCronJobStandingGrants(db, {
            jobId: job.id,
            previous: previousGrantBinding,
            next: {
              configRevision: resolveCronJobConfigRevision(nextJob),
              generation: nextGeneration,
            },
          });
        }
        result.push({ jobId: job.id, name: job.name, previousToolsAllow });
      }
      deferSqlitePostCommitPublication(db, () => noteCronJobsStoreCommit(storeKey));
      return result;
    },
    { env: params.env },
    { operationLabel: "cron.legacy-default-tool-caps" },
  );
  return { migrated, backupPath };
}
