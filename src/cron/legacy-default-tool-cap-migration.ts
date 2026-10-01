import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../state/openclaw-state-snapshot-sanitizer.js";
import { resolveCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import { noteCronJobsStoreCommit } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { loadCronRows, loadedCronStoreFromRows, upsertCronJobRow } from "./store/row-codec.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "./store/runtime-authority-store.js";
import { tryParseJsonObject } from "./store/scalar-codec.js";

export type MigratedDefaultCronToolCap = {
  jobId: string;
  name: string;
  previousToolsAllow: string[];
};

/**
 * Marked agent turns with a scheduled owner policy. Script runtimes reach MCP only
 * through servers named in the list, and policy-less jobs have no owner session to
 * inherit from, so their rows stay untouched.
 */
function loadInheritingDefaultCapRows(db: DatabaseSync, storeKey: string) {
  const rows = loadCronRows(db, storeKey).filter((row) => {
    const payload = tryParseJsonObject(row.job_json)?.payload;
    return isRecord(payload) && payload.toolsAllowIsDefault === true;
  });
  const jobsById = new Map(
    loadedCronStoreFromRows(rows).store.jobs.map((job) => [job.id, job] as const),
  );
  return rows.flatMap((row) => {
    const job = jobsById.get(row.job_id);
    return job &&
      job.payload.kind === "agentTurn" &&
      !job.trigger?.script.trim() &&
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
 * Older builds froze the creator's tool list into agent-created jobs and marked
 * it `toolsAllowIsDefault`. Agent turns with a scheduled owner policy now store
 * `*`, so runs inherit the owner session's current policy. Runtime authority is
 * rebound in the same transaction, after a verified state-database backup.
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
      const entries = loadInheritingDefaultCapRows(db, storeKey);
      const jobs = entries.map(({ job }) => job);
      loadCronRuntimeAuthorities({ db, storeKey, jobs });
      const result: MigratedDefaultCronToolCap[] = [];
      for (const { row, job } of entries) {
        const previousToolsAllow = job.payload.toolsAllow ?? [];
        Reflect.deleteProperty(job.payload, "toolsAllowIsDefault");
        job.payload.toolsAllow = ["*"];
        if (job.toolsAllowExecTargetRequirement?.target) {
          job.toolsAllowExecTargetRequirement.grantIndex = 0;
        }
        const persisted = upsertCronJobRow(db, storeKey, job, row.sort_order);
        replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [persisted] });
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
