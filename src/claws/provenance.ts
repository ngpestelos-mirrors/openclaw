import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assertClawPackageLifecycleWriteArtifact } from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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
import { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";
import { executeClawProvenanceWrite, type ClawProvenanceWriteOptions } from "./provenance-write.js";
import type * as kernel from "./provenance.kernel.js";
export { clawInstallRecordMatchesPlan } from "./provenance.kernel.js";
export {
  persistClawMigrationOwnership,
  releaseAdoptedClawInstallRecord,
} from "./provenance-adopted.js";
export {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import type { PersistedClawInstall } from "./provenance-types.js";
export type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";

export async function persistClawInstallRecord(
  arg0: Parameters<typeof kernel.persistClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof kernel.persistClawInstallRecord>[1]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.persistClawInstallRecord>> {
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.persistInstall",
      input: {
        arg0,
        options: {
          status: options.status,
          nowMs: options.nowMs,
          expectedExistingRecord: options.expectedExistingRecord,
          expectedExistingPlan: options.expectedExistingPlan,
          deferLegacyPlanUpgrade: options.deferLegacyPlanUpgrade,
          agentOrigin: options.agentOrigin,
        },
      },
    },
    options,
    (facts) => publishInstallRecord(facts, options),
  );
  return result;
}

export async function updateClawInstallRecord(
  arg0: Parameters<typeof kernel.updateClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof kernel.updateClawInstallRecord>[1]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.updateClawInstallRecord>> {
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.updateInstall",
      input: {
        arg0,
        options: {
          nowMs: options.nowMs,
          expectedClaw: options.expectedClaw,
          status: options.status,
          agentConfigDigest: options.agentConfigDigest,
        },
      },
    },
    options,
    (facts) => publishInstallRecord(facts, options),
  );
  return result;
}

export async function updateClawInstallRecordStatus(
  arg0: Parameters<typeof kernel.updateClawInstallRecordStatus>[0],
  arg1: Parameters<typeof kernel.updateClawInstallRecordStatus>[1],
  options: NonNullable<Parameters<typeof kernel.updateClawInstallRecordStatus>[2]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.updateClawInstallRecordStatus>> {
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.installStatus",
      input: {
        arg0,
        arg1,
        options: { nowMs: options.nowMs, expectedStatuses: options.expectedStatuses },
      },
    },
    options,
  );
  return result;
}

export async function deleteClawInstallRecord(
  arg0: Parameters<typeof kernel.deleteClawInstallRecord>[0],
  options: NonNullable<Parameters<typeof kernel.deleteClawInstallRecord>[1]> &
    ClawProvenanceWriteOptions = {},
): Promise<ReturnType<typeof kernel.deleteClawInstallRecord>> {
  const result = await executeClawProvenanceWrite(
    {
      type: "clawProvenance.deleteInstall",
      input: { arg0, options: { expectedStatuses: options.expectedStatuses } },
    },
    options,
    () => deleteCachedClawInstallSchemaVersion(arg0, options),
  );
  return result;
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

export function readClawInstallRecord(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawInstall | undefined {
  return readClawInstallRecordFromDatabase(openOpenClawStateDatabase(options).db, agentId);
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

function publishInstallRecord(facts: unknown, options: OpenClawStateDatabaseOptions) {
  if (
    !isRecord(facts) ||
    typeof facts.agentId !== "string" ||
    typeof facts.agentConfigDigest !== "string" ||
    typeof facts.schemaVersion !== "string"
  ) {
    throw new Error("Claw install write has no committed record");
  }
  cacheClawInstallSchemaVersion(
    facts.agentId,
    parseClawInstallRecordSchemaVersion(facts.schemaVersion),
    facts.agentConfigDigest,
    options,
  );
}
