// Persists the root ownership record for one Claw-created agent and workspace.

import { assertClawPackageLifecycleWriteArtifact } from "../state/claw-package-lifecycle-lease.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import type { ClawAgentOrigin } from "./provenance-agent-origin.js";
import { readClawPackageOwnership } from "./provenance-async.js";
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
import { executeClawProvenanceWrite, type ClawProvenanceWriteOptions } from "./provenance-write.js";
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

export async function persistClawPackageRef(
  arg0: Parameters<typeof kernel.persistClawPackageRef>[0],
  arg1: Parameters<typeof kernel.persistClawPackageRef>[1],
  options: NonNullable<Parameters<typeof kernel.persistClawPackageRef>[2]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.persistClawPackageRef>> {
  if (options.lease) {
    assertClawPackageLifecycleWriteArtifact(options.lease, arg1);
  }
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.persistPackage",
      input: {
        arg0,
        arg1,
        options: {
          nowMs: options.nowMs,
          status: options.status,
          relationship: options.relationship,
          origin: options.origin,
          independentOwner: options.independentOwner,
        },
      },
    },
    options,
  );
  return result;
}

export async function updateClawPackageRefStatus(
  arg0: Parameters<typeof kernel.updateClawPackageRefStatus>[0],
  arg1: Parameters<typeof kernel.updateClawPackageRefStatus>[1],
  options: NonNullable<Parameters<typeof kernel.updateClawPackageRefStatus>[2]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.updateClawPackageRefStatus>> {
  if (options.lease) {
    assertClawPackageLifecycleWriteArtifact(options.lease, arg0);
  }
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.updatePackageStatus",
      input: { arg0, arg1, options: { nowMs: options.nowMs } },
    },
    options,
  );
  return result;
}

export async function readClawInstallRecordAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return (await readClawPackageOwnership({ ...options, agentId })).install;
}
export async function readClawInstallRecordsAsync(options: OpenClawStateDatabaseOptions = {}) {
  return (await readClawPackageOwnership(options, true)).installs;
}
export async function readClawPackageRefsAsync(
  options: OpenClawStateDatabaseOptions & ClawPackageRefQuery = {},
) {
  const { packageRefs } = await readClawPackageOwnership(options);
  return packageRefs.filter(
    (ref) =>
      (options.kind === undefined || ref.kind === options.kind) &&
      (options.source === undefined || ref.source === options.source) &&
      (options.ref === undefined || ref.ref === options.ref) &&
      (options.version === undefined || ref.version === options.version) &&
      (options.integrity === undefined || ref.integrity === options.integrity) &&
      (options.status === undefined || ref.status === options.status),
  );
}
