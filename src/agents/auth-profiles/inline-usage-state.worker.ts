import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { updateUserModelAuthProfile } from "../../state/user-model-accounts.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  applyAuthProfileSuccess,
  recordAuthProfileUsageInDatabase,
  type AuthProfileStateSuccessOperations,
  type AuthProfileSuccessInput,
  type AuthProfileUsageReceipt,
  type AuthProfileUsageResult,
} from "./inline-usage-kernel.js";
import { settleAuthProfileUsageTransaction } from "./inline-usage.worker.js";
import type { AuthProfileStore } from "./types.js";

function recordPersonalSuccess(
  input: AuthProfileSuccessInput,
  options: OpenClawStateDatabaseOptions,
): AuthProfileUsageReceipt {
  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  let receipt: AuthProfileUsageReceipt | undefined;
  updateUserModelAuthProfile(
    input.profileId,
    (profile) => {
      store.profiles[input.profileId] = profile.credential;
      store.usageStats = profile.usageStats ? { [input.profileId]: profile.usageStats } : undefined;
      receipt = applyAuthProfileSuccess(store, input);
      if (!receipt.applied) {
        return false;
      }
      profile.usageStats = receipt.nextStats;
      return true;
    },
    options,
  );
  return receipt ?? applyAuthProfileSuccess(store, input);
}

/** Shared and personal bookkeeping retain the shared-state coordinator and account owner. */
export function executeAuthProfileStateSuccess(
  command: SqliteWorkerCommand<AuthProfileStateSuccessOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): AuthProfileUsageResult {
  return settleAuthProfileUsageTransaction(options.database.db, (onCommitted) =>
    runOpenClawStateWriteTransaction(({ db, path }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const receipt =
        command.type === "authProfiles.personalSuccess"
          ? recordPersonalSuccess(command.input, options)
          : recordAuthProfileUsageInDatabase(db, path, command.input, "shared-state");
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
      deferSqlitePostCommitPublication(db, () => onCommitted(receipt));
      deferSqliteWorkerCommitReceipt(db, receipt);
      return receipt;
    }, options),
  );
}
