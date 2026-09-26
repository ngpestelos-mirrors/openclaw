import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
  runSqliteDeferredTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { reportCommittedAuthProfileUsage } from "./constants.js";
import {
  recordAuthProfileUsageInDatabase,
  type AuthProfileUsageOperations,
  type AuthProfileUsageReceipt,
  type AuthProfileUsageResult,
} from "./inline-usage-kernel.js";
import { readAdmittedAuthProfileJsonCell } from "./sqlite-json.js";

/** A known commit survives cleanup failures; only a settled rollback is a domain refusal. */
export function settleAuthProfileUsageTransaction(
  database: DatabaseSync,
  transaction: (onCommitted: (receipt: AuthProfileUsageReceipt) => void) => AuthProfileUsageReceipt,
): AuthProfileUsageResult {
  let committedReceipt: AuthProfileUsageReceipt | undefined;
  try {
    return {
      ok: true,
      receipt: transaction((receipt) => {
        committedReceipt = receipt;
      }),
    };
  } catch (error) {
    if (committedReceipt) {
      reportCommittedAuthProfileUsage(
        "Auth usage committed before transaction cleanup failed",
        error,
      );
      return { ok: true, receipt: committedReceipt };
    }
    assertTransactionUsable(database);
    if (!database.isOpen || database.isTransaction) {
      throw error;
    }
    const failure = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
    if (!failure) {
      throw error;
    }
    return { ok: false, error: failure };
  }
}

/** The canonical agent executor lends its connection and transaction/commit admission. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<AuthProfileUsageOperations> {
  return {
    execute(command) {
      if (command.type === "authProfiles.usageSnapshot") {
        return runSqliteDeferredTransactionSync(context.database, () => ({
          store: readAdmittedAuthProfileJsonCell(context.database, "store", "agent"),
          state: readAdmittedAuthProfileJsonCell(context.database, "state", "agent"),
          cacheable: false,
        }));
      }
      return settleAuthProfileUsageTransaction(context.database, (onCommitted) => {
        let receipt: AuthProfileUsageReceipt | undefined;
        return runSqliteImmediateTransactionSync(
          context.database,
          () => {
            context.admit("transaction");
            receipt = recordAuthProfileUsageInDatabase(
              context.database,
              context.databasePath,
              command.input,
              "agent",
            );
            return receipt;
          },
          {
            withCommit(commit) {
              context.admit("commit");
              commit();
              if (receipt) {
                onCommitted(receipt);
              }
            },
          },
        );
      });
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (!context.database.isOpen || context.database.isTransaction) {
        throw new Error("Auth usage left an unsettled agent transaction");
      }
    },
    close() {},
  };
}
