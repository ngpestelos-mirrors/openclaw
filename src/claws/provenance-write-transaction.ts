import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import { assertAgentDeletionWorkerPredicate } from "../state/agent-deletion.worker.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  assertOpenClawStateLeaseWorkerOwnedInTransaction,
  assertOpenClawStateLeasesWorkerOwnedInTransaction,
} from "../state/openclaw-state-lease-worker.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import type { ClawProvenanceAuthority } from "./provenance-write.worker-contract.js";

export function runClawProvenanceWriteTransaction<T>(
  context: WorkerWriteOperationContext,
  authority: ClawProvenanceAuthority | undefined,
  operation: (database: OpenClawStateDatabase) => T,
): T {
  if (!authority?.lease && !authority?.deletion) {
    return context.writeAdmitted(operation, { receipt: "result" });
  }
  return context.write((database) => {
    const assertOwned = (stage: "transaction" | "commit") => {
      if (authority.deletion) {
        if (authority.lease) {
          assertOpenClawStateLeasesWorkerOwnedInTransaction(
            database.db,
            [authority.deletion.lease, authority.lease],
            stage,
          );
        } else {
          assertOpenClawStateLeaseWorkerOwnedInTransaction(
            database.db,
            authority.deletion.lease,
            "write",
            stage,
          );
        }
        assertAgentDeletionWorkerPredicate(database, authority.deletion.predicate);
      } else if (authority.lease) {
        assertOpenClawStateLeaseWorkerOwnedInTransaction(
          database.db,
          authority.lease,
          "write",
          stage,
        );
      }
    };
    assertOwned("transaction");
    const result = operation(database);
    assertOwned("commit");
    deferSqliteWorkerCommitReceipt(database.db, result);
    return result;
  });
}
