import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawValue } from "./digest.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import { replaceClawPackageRefExpectedInDatabase } from "./package-update-provenance.kernel.js";

export function digestClawPackageRef(ref: PersistedClawPackageRef): string {
  const persisted = {
    schemaVersion: ref.schemaVersion,
    agentId: ref.agentId,
    clawName: ref.clawName,
    kind: ref.kind,
    source: ref.source,
    ref: ref.ref,
    version: ref.version,
    integrity: ref.integrity,
    status: ref.status,
    relationship: ref.relationship,
    origin: ref.origin,
    independentOwner: ref.independentOwner,
    ...(ref.extension ? { extension: ref.extension } : {}),
    installedAtMs: ref.installedAtMs,
    updatedAtMs: ref.updatedAtMs,
  };
  return digestClawValue(persisted);
}

export function replaceClawPackageRefExpected(
  expected: PersistedClawPackageRef | undefined,
  replacement: PersistedClawPackageRef | undefined,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const identity = expected ?? replacement;
  if (!identity) {
    throw new Error("Package reference replacement requires an identity.");
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    replaceClawPackageRefExpectedInDatabase(db, expected, replacement);
  }, options);
}
