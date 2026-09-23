import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  type LeaseRow,
  type LeaseTable,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type CancellationDependencies = {
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  originalUpdateAdmissions: WeakMap<
    ManagedHandoffLease,
    { database: ManagedUpdateLeaseDatabaseIdentity; original: ManagedHandoffLease }
  >;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  transact: <Result>(db: HandoffDatabase, operation: () => Result) => Result;
  mutationCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  storedCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  childAliases: (key: string, db: HandoffDatabase) => string[];
  canRelease: (lease: ManagedHandoffLease) => boolean;
  handle: (root: string, value: LeaseRow) => ManagedHandoffLease;
  updateRow: (
    db: HandoffDatabase,
    lease: ManagedHandoffLease,
    values: Pick<LeaseTable, "payload_json" | "updated_at"> &
      Partial<Pick<LeaseTable, "install_root">>,
  ) => boolean;
  deleteRow: (db: HandoffDatabase, root: string, value: LeaseRow) => boolean;
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
};

export function createManagedHandoffCancellation(deps: CancellationDependencies) {
  const {
    existingIdentity,
    originalUpdateAdmissions,
    withDatabase,
    transact,
    mutationCurrent,
    storedCurrent,
    childAliases,
    canRelease,
    handle,
    updateRow,
    deleteRow,
    processState,
  } = deps;
  const cancellations = new WeakMap<
    ManagedHandoffLease,
    {
      lease: ManagedHandoffLease;
      retained?: ManagedHandoffLease;
      retainedOriginal?: ManagedHandoffLease;
      release: (paired?: ManagedHandoffLease[]) => boolean;
    }
  >();
  function cancelUpdate(lease: ManagedHandoffLease, retained?: ManagedHandoffLease) {
    const admission = originalUpdateAdmissions.get(lease);
    const admitted = admission?.database;
    if (
      !admitted ||
      !isDeepStrictEqual(admission?.original, lease) ||
      !existingIdentity ||
      admitted.databasePath !== existingIdentity.databasePath ||
      admitted.databaseIdentity !== existingIdentity.databaseIdentity ||
      admitted.parentIdentity !== existingIdentity.parentIdentity ||
      lease.version !== 2 ||
      lease.mutationOriginal ||
      lease.action.kind !== "update" ||
      lease.action.mutationProtocol !== "original-cancellation-v1" ||
      lease.key.includes("/.openclaw-update-child-") ||
      lease.helper.pid !== process.pid ||
      !isDeepStrictEqual(lease.helper, lease.executor) ||
      processState(lease.helper) !== "live" ||
      (retained &&
        (retained.key === lease.key ||
          retained.key.includes("/.openclaw-update-child-") ||
          retained.version !== 2 ||
          retained.mutationOriginal ||
          retained.action.kind !== "update" ||
          retained.helper.pid !== process.pid ||
          !isDeepStrictEqual(retained.helper, retained.executor) ||
          processState(retained.helper) !== "live"))
    ) {
      return null;
    }
    const previous = cancellations.get(lease);
    if (previous) {
      return withDatabase(true, (db) =>
        transact(
          db,
          () =>
            isDeepStrictEqual(previous.retainedOriginal, retained) &&
            storedCurrent(previous.lease, db) &&
            (!previous.retained || storedCurrent(previous.retained, db)),
        ),
      )
        ? previous
        : null;
    }
    const descendants = (db: HandoffDatabase, parent: ManagedHandoffLease) => {
      const prefix = `${parent.key}/.openclaw-update-child-`;
      return executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"])
          .where("install_root", ">=", prefix)
          .where("install_root", "<", prefix + "\uffff"),
      ).rows;
    };
    const transitioned = withDatabase(true, (db) =>
      transact(db, () => {
        if (!mutationCurrent(lease, db) || (retained && !mutationCurrent(retained, db))) {
          return null;
        }
        const originalChildren = descendants(db, lease);
        // Old admitted receivers cannot safely race cancellation with nested
        // admission. Only marked original lineage and its known mirrors qualify.
        if (
          originalChildren.some((entry) => {
            const child = handle(entry.install_root, entry);
            return (
              child.version !== 2 ||
              child.action.kind !== "update" ||
              child.action.mutationProtocol !== "original-cancellation-v1"
            );
          })
        ) {
          return null;
        }
        const originalKeys = new Set(originalChildren.map((entry) => entry.install_root));
        if (
          retained &&
          descendants(db, retained).some((entry) => {
            const child = handle(entry.install_root, entry);
            return (
              child.version !== 2 ||
              child.action.kind !== "update" ||
              !childAliases(child.key, db).some((key) => originalKeys.has(key))
            );
          })
        ) {
          return null;
        }
        const transition = (original: ManagedHandoffLease) => {
          const payload = JSON.stringify({
            version: 4,
            helper: original.helper,
            executor: original.executor,
            action: original.action,
            cancellation: {
              key: original.key,
              owner: original.owner,
              payload: original.payload,
              updatedAt: original.updatedAt,
            },
          });
          if (!parseManagedHandoffLeasePayload(payload)) {
            throw new Error("Original cancellation payload is invalid");
          }
          const updatedAt = Math.max(Date.now(), original.updatedAt + 1);
          if (!updateRow(db, original, { payload_json: payload, updated_at: updatedAt })) {
            throw new Error("Original cancellation generation changed");
          }
          return handle(original.key, {
            owner: original.owner,
            payload_json: payload,
            updated_at: updatedAt,
          });
        };
        // Change both CAS generations atomically. Even a previously admitted
        // strict service writer can no longer commit against its old payload.
        return { lease: transition(lease), retained: retained ? transition(retained) : undefined };
      }),
    );
    if (!transitioned) {
      return null;
    }
    const generations = [
      transitioned.lease,
      ...(transitioned.retained ? [transitioned.retained] : []),
    ];
    // Never exposed by the public request. The owner invokes final release only
    // after callback, child and command joins; both generations settle together.
    const successor = {
      ...transitioned,
      retainedOriginal: retained ? structuredClone(retained) : undefined,
      release: (paired: ManagedHandoffLease[] = []) =>
        withDatabase(true, (db) =>
          transact(db, () => {
            if (
              processState(lease.helper) !== "live" ||
              new Set([...generations, ...paired].map((item) => item.key)).size !==
                generations.length + paired.length ||
              paired.some(
                (item) =>
                  item.version !== 2 ||
                  !isDeepStrictEqual(item.mutationOriginal, {
                    key: lease.key,
                    owner: lease.owner,
                    payload: lease.payload,
                    updatedAt: lease.updatedAt,
                  }) ||
                  !canRelease(item) ||
                  !storedCurrent(item, db),
              ) ||
              generations.some(
                (generation) =>
                  !storedCurrent(generation, db) || descendants(db, generation).length > 0,
              )
            ) {
              return false;
            }
            for (const generation of [...generations, ...paired]) {
              if (
                !deleteRow(db, generation.key, {
                  owner: generation.owner,
                  payload_json: generation.payload,
                  updated_at: generation.updatedAt,
                })
              ) {
                // Roll back the paired release rather than commit half a settlement.
                throw new Error("Original cancellation settlement changed");
              }
            }
            return true;
          }),
        ),
    };
    cancellations.set(lease, successor);
    return successor;
  }
  return cancelUpdate;
}
