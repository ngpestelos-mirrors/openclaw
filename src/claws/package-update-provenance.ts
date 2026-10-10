import { assertClawPackageLifecycleWriteArtifact } from "../state/claw-package-lifecycle-lease.js";
import { digestClawValue } from "./digest.js";
import type { PersistedClawPackageRef } from "./package-extension-provenance.js";
import { executeClawProvenanceWrite, type ClawProvenanceWriteOptions } from "./provenance-write.js";

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

export async function replaceClawPackageRefExpected(
  expected: PersistedClawPackageRef | undefined,
  replacement: PersistedClawPackageRef | undefined,
  options: ClawProvenanceWriteOptions = {},
): Promise<void> {
  if (!expected && !replacement) {
    throw new Error("Package reference replacement requires an identity.");
  }
  if (options.lease) {
    for (const ref of [expected, replacement]) {
      if (ref) {
        assertClawPackageLifecycleWriteArtifact(options.lease, ref);
      }
    }
  }
  await executeClawProvenanceWrite(
    { type: "clawProvenance.replacePackageRef", input: { expected, replacement } },
    options,
  );
}
