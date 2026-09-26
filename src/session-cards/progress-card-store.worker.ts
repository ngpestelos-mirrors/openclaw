import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { writeSessionProgressCard } from "./progress-card-store.js";

export type ProgressCardWriteOperations = {
  "progress-card.put": {
    input: { sessionKey: string } & Parameters<typeof writeSessionProgressCard>[2];
    output: ReturnType<typeof writeSessionProgressCard>;
  };
};

export function bindSqliteWorkerBackend(
  _input: unknown,
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<ProgressCardWriteOperations> {
  return {
    execute(command) {
      return runSqliteImmediateTransactionSync(
        context.database,
        () => {
          context.admit("transaction");
          return writeSessionProgressCard(
            context.database,
            command.input.sessionKey,
            command.input,
          );
        },
        {
          databaseLabel: context.databasePath,
          operationLabel: command.type,
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (context.database.isTransaction) {
        throw new Error("Progress-card publication left an unsettled transaction");
      }
    },
    close() {},
  };
}
