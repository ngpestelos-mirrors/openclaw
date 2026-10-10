// Persists the root ownership record for one Claw-created agent and workspace.

import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import type { ClawAgentOrigin } from "./provenance-agent-origin.js";
import {
  readClawInstallRecordFromDatabase,
  readClawInstallRecordsInDatabase,
  readClawPackageRefsInDatabase,
  type ClawPackageRefQuery,
} from "./provenance-read.kernel.js";
import {
  cacheClawInstallSchemaVersion,
  deleteCachedClawInstallSchemaVersion,
} from "./provenance-runtime-read.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";
import * as kernel from "./provenance.kernel.js";
import type { ClawAddPlan } from "./types.js";
export {
  persistClawMigrationOwnership,
  releaseAdoptedClawInstallRecord,
} from "./provenance-adopted.js";
export {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";
export type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";
export {
  clawInstallRecordMatchesPlan,
  updateClawInstallRecordStatus,
  persistClawPackageRef,
  updateClawPackageRefStatus,
} from "./provenance.kernel.js";

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  return readClawInstallRecordFromDatabase(openOpenClawStateDatabase(options).db, agentId);
}

export function persistClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    status?: ClawInstallStatus;
    nowMs?: number;
    expectedExistingRecord?: PersistedClawInstall;
    expectedExistingPlan?: ClawAddPlan;
    deferLegacyPlanUpgrade?: boolean;
    agentOrigin?: ClawAgentOrigin;
  } = {},
): PersistedClawInstall {
  const record = kernel.persistClawInstallRecord(plan, options);
  cacheClawInstallSchemaVersion(
    plan.agent.finalId,
    record.schemaVersion,
    record.agentConfigDigest,
    options,
  );
  return record;
}

export function updateClawInstallRecord(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    nowMs?: number;
    expectedClaw?: { version: string; integrity: string };
    status?: ClawInstallStatus;
    agentConfigDigest?: string;
  } = {},
): PersistedClawInstall {
  const record = kernel.updateClawInstallRecord(plan, options);
  cacheClawInstallSchemaVersion(
    plan.agent.finalId,
    record.schemaVersion,
    record.agentConfigDigest,
    options,
  );
  return record;
}

export function deleteClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { expectedStatuses?: ClawInstallStatus[] } = {},
): void {
  kernel.deleteClawInstallRecord(agentId, options);
  deleteCachedClawInstallSchemaVersion(agentId, options);
}

export function readClawInstallRecords(
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall[] {
  return readClawInstallRecordsInDatabase(openOpenClawStateDatabase(options).db);
}

export function readClawPackageRefs(
  options: OpenClawStateDatabaseOptions & ClawPackageRefQuery = {},
): PersistedClawPackageRef[] {
  return readClawPackageRefsInDatabase(openOpenClawStateDatabase(options).db, options);
}
