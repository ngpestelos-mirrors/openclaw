import { assertAgentDeletionAllowsMutation } from "../agents/agent-lifecycle-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readClawInstallRecordFromDatabase } from "./provenance-read.kernel.js";
import { readClawSecondaryReferenceTables } from "./provenance-secondary-references.js";
type ClawAdoptedDatabase = Pick<DB, "claw_installs" | "claw_workspace_files">;

/** Releases adopted ownership metadata without changing the pre-existing agent or files. */
export function releaseAdoptedClawInstallRecordInDatabase(
  database: OpenClawStateDatabase,
  agentId: string,
  expectedPlanIntegrity: string,
): void {
  assertAgentDeletionAllowsMutation(database, agentId);
  const { db } = database;
  const record = readClawInstallRecordFromDatabase(db, agentId);
  if (!record) {
    throw new Error(`No Claw install record exists for agent ${JSON.stringify(agentId)}.`);
  }
  if (
    record.agentOrigin !== "adopted" ||
    record.planIntegrity !== expectedPlanIntegrity ||
    record.status !== "complete"
  ) {
    throw new Error(`Adopted Claw ownership changed for agent ${JSON.stringify(agentId)}.`);
  }
  const secondaryReferences = readClawSecondaryReferenceTables(db, agentId);
  if (secondaryReferences.length > 0) {
    throw new Error(
      `Adopted Claw ownership for agent ${JSON.stringify(agentId)} now includes secondary resources in ${secondaryReferences.join(", ")}; reconcile them before releasing ownership.`,
    );
  }
  const state = getNodeSqliteKysely<ClawAdoptedDatabase>(db);
  executeSqliteQuerySync(
    db,
    state.deleteFrom("claw_workspace_files").where("agent_id", "=", agentId),
  );
  const removed = executeSqliteQuerySync(
    db,
    state
      .deleteFrom("claw_installs")
      .where("agent_id", "=", agentId)
      .where("schema_version", "=", record.schemaVersion)
      .where("plan_integrity", "=", expectedPlanIntegrity),
  );
  if (removed.numAffectedRows !== 1n) {
    throw new Error(`Adopted Claw ownership changed for agent ${JSON.stringify(agentId)}.`);
  }
}
