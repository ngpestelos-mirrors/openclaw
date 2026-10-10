import type { DatabaseSync } from "node:sqlite";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import type { CronJobRow } from "../cron/store/schema.js";
import { compileSqliteQueryBindings, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type AttachedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  agentId: string | null;
  ownerAgentId: string | null;
  storeKey: string;
  declarationKey: string | null;
  revision?: string;
};

/** Inventories cron jobs that would retain a reference to a removed agent. */
export function readAttachedCronJobsInDatabase(
  db: DatabaseSync,
  agentId: string,
): AttachedCronJob[] {
  if (!tableExists(db, "cron_jobs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) => {
    const boundAgentId = parameter((value) => value);
    return getNodeSqliteKysely<Pick<DB, "cron_jobs">>(db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where((eb) =>
        eb.or([eb("agent_id", "=", boundAgentId), eb("owner_agent_id", "=", boundAgentId)]),
      )
      .orderBy("job_id")
      .orderBy("store_key");
  });
  const rows =
    db /* sqlite-allow-raw: preserve native inventory errors outside the write-transaction owner. */
      .prepare(compiled.sql)
      .all(...bind(agentId)) as CronJobRow[];
  return rows.map((row) => {
    const job = loadedCronStoreFromRows([row]).store.jobs[0];
    return {
      id: row.job_id,
      name: row.name,
      enabled: row.enabled === 1,
      agentId: row.agent_id,
      ownerAgentId: row.owner_agent_id,
      storeKey: row.store_key,
      declarationKey: row.declaration_key,
      revision: job ? resolveCronJobConfigRevision(job) : undefined,
    };
  });
}
