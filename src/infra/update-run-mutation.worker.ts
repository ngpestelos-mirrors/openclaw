import {
  openExistingOpenClawStateWriter,
  type ExistingOpenClawStateWriter,
} from "../state/openclaw-state-db-existing-write.js";
import { resolveUpdateRunCodecEnv, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import {
  isRequiredUpdateRunStep,
  retryUpdateRunWrite,
  UpdateRunWriteBusyError,
} from "./update-run-contention.js";
import type {
  UpdateRunWriteCommand,
  UpdateRunWriteOperations,
} from "./update-run-mutation.types.js";
import { readRecovery } from "./update-run-recovery-store.js";
import {
  applyUpdateRunPhase,
  applyUpdateRunStep,
  mutateRunInTransaction,
  updateRunLedgerSchema,
} from "./update-run-write.js";

export function openUpdateRunWriter(options: UpdateRunLedgerOptions): ExistingOpenClawStateWriter {
  return openExistingOpenClawStateWriter(options, {
    schemaSql: updateRunLedgerSchema,
    operationLabel: "update.run",
    beginLockFailureReporting: "suppress",
  });
}

export function recordUpdateRunMutationInWorker(
  command: UpdateRunWriteCommand,
  stateOptions: UpdateRunLedgerOptions,
  assertCurrent: (stage: "transaction" | "commit") => void,
  writer: ExistingOpenClawStateWriter,
): UpdateRunWriteOperations["updateRuns.recordStep"]["output"] {
  const { input } = command;
  const options = {
    ...stateOptions,
    busyTimeoutMs: input.busyTimeoutMs,
    redactPaths: input.redactPaths,
  };
  const codecOptions = {
    ...options,
    env: resolveUpdateRunCodecEnv(options.env, input.redactionFacts),
  };
  // Recovery exclusion is itself an admission decision: it must serialize
  // behind the competing writer even when the progress receipt is expendable.
  const bookkeeping =
    command.type === "updateRuns.recordStep" &&
    !input.requireNoRecovery &&
    !isRequiredUpdateRunStep(command.input.step);
  try {
    return retryUpdateRunWrite(
      (busyTimeoutMs) =>
        writer.run(
          ({ db }) => {
            assertCurrent("transaction");
            if (input.requireNoRecovery) {
              const recovery = readRecovery(db, input.runId);
              if (recovery) {
                assertCurrent("commit");
                return { kind: "recovery-required", recovery };
              }
            }
            const record = mutateRunInTransaction(
              db,
              input.runId,
              (current) => {
                if (command.type === "updateRuns.recordPhase") {
                  applyUpdateRunPhase(current, command.input.phase, command.input.patch);
                } else {
                  applyUpdateRunStep(current, command.input.step);
                }
              },
              codecOptions,
            );
            assertCurrent("commit");
            return { kind: "recorded", record };
          },
          { ...options, busyTimeoutMs },
        ),
      options,
      bookkeeping,
    );
  } catch (error) {
    if (!bookkeeping || !(error instanceof UpdateRunWriteBusyError)) {
      throw error;
    }
    return { kind: "bookkeeping-skipped" };
  }
}
