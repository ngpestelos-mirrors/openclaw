import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  toPackageRefExtensionSqlParams,
  toPackageRefSqlFields,
  type PersistedClawPackageRef,
} from "./package-extension-provenance.js";

export function replaceClawPackageRefExpectedInDatabase(
  db: DatabaseSync,
  expected: PersistedClawPackageRef | undefined,
  replacement: PersistedClawPackageRef | undefined,
): void {
  const identity = expected ?? replacement;
  if (!identity) {
    throw new Error("Package reference replacement requires an identity.");
  }
  const kysely = getNodeSqliteKysely<Pick<DB, "claw_package_refs">>(db);
  if (expected) {
    const extension = toPackageRefExtensionSqlParams(expected.extension);
    // Nullable extension fields participate in the same full-row compare-and-swap.
    const result = executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("claw_package_refs")
        .where((eb) => eb.and(toPackageRefSqlFields(expected)))
        .where("extension_id", "is", extension.extension_id)
        .where("extension_format", "is", extension.extension_format)
        .where("extension_detected_format", "is", extension.extension_detected_format)
        .where("extension_mapped_json", "is", extension.extension_mapped_json)
        .where("extension_unavailable_json", "is", extension.extension_unavailable_json)
        .where("extension_adapter_identity", "is", extension.extension_adapter_identity),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Package reference ${JSON.stringify(`${expected.kind}:${expected.ref}`)} changed after planning.`,
      );
    }
  } else {
    // Any version occupies this dependency edge; only one row is needed to reject it.
    const occupied = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("claw_package_refs")
        .select((eb) => eb.val(1).as("occupied"))
        .where("agent_id", "=", identity.agentId)
        .where("package_kind", "=", identity.kind)
        .where("package_source", "=", identity.source)
        .where("package_ref", "=", identity.ref)
        .limit(1),
    );
    if (occupied) {
      throw new Error(
        `Package reference ${JSON.stringify(`${identity.kind}:${identity.ref}`)} appeared after planning.`,
      );
    }
  }
  if (replacement) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("claw_package_refs").values({
        ...toPackageRefSqlFields(replacement),
        ...toPackageRefExtensionSqlParams(replacement.extension),
      }),
    );
  }
}
