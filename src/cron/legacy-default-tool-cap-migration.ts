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
  inherits: boolean;
};

function loadLegacyDefaultCapRows(db: DatabaseSync, storeKey: string) {
  return loadCronRows(db, storeKey).filter((row) => {
    const payload = tryParseJsonObject(row.job_json)?.payload;
    return isRecord(payload) && payload.toolsAllowIsDefault === true;
  });
}

/**
 * Older builds froze the creator's tool list into agent-created jobs and marked
 * it `toolsAllowIsDefault`. Agent turns with a scheduled owner policy now store
 * `*`, so runs inherit the owner session's current policy; other jobs keep their
 * list as an explicit cap. Runtime authority is rebound in the same transaction,
 * after a verified state-database backup.
 */
export async function migrateLegacyDefaultCronToolCaps(params: {
  storePath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ migrated: MigratedDefaultCronToolCap[]; backupPath?: string }> {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  const evidence = runOpenClawStateWriteTransaction(
    ({ db }) =>
      loadLegacyDefaultCapRows(db, storeKey).map(({ job_id, job_json }) => ({ job_id, job_json })),
    { env: params.env },
    { operationLabel: "cron.legacy-default-tool-caps.inspect" },
  );
  if (evidence.length === 0) {
    return { migrated: [] };
  }
  const assertRowsUnchanged = (db: DatabaseSync) => {
    const current = loadLegacyDefaultCapRows(db, storeKey).map(({ job_id, job_json }) => ({
      job_id,
      job_json,
    }));
    if (!isDeepStrictEqual(current, evidence)) {
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
      const rows = loadLegacyDefaultCapRows(db, storeKey);
      const jobs = loadedCronStoreFromRows(rows).store.jobs;
      loadCronRuntimeAuthorities({ db, storeKey, jobs });
      const sortOrderById = new Map(rows.map((row) => [row.job_id, row.sort_order] as const));
      const result: MigratedDefaultCronToolCap[] = [];
      for (const job of jobs) {
        const previousToolsAllow = job.payload.toolsAllow ?? [];
        // Script runtimes reach MCP only through servers named in the list, so `*`
        // would remove access they already have; their lists stay as explicit caps.
        const inherits =
          job.payload.kind === "agentTurn" &&
          !job.trigger?.script.trim() &&
          resolveCronScheduledToolPolicy({
            toolsAllow: job.payload.toolsAllow,
            scheduledToolPolicy: job.scheduledToolPolicy,
            owner: job.owner,
          }) !== undefined;
        Reflect.deleteProperty(job.payload, "toolsAllowIsDefault");
        if (inherits) {
          job.payload.toolsAllow = ["*"];
          if (job.toolsAllowExecTargetRequirement?.target) {
            job.toolsAllowExecTargetRequirement.grantIndex = 0;
          }
        }
        const persisted = upsertCronJobRow(db, storeKey, job, sortOrderById.get(job.id) ?? 0);
        replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [persisted] });
        result.push({ jobId: job.id, name: job.name, previousToolsAllow, inherits });
      }
      deferSqlitePostCommitPublication(db, () => noteCronJobsStoreCommit(storeKey));
      return result;
    },
    { env: params.env },
    { operationLabel: "cron.legacy-default-tool-caps" },
  );
  return { migrated, backupPath };
}
