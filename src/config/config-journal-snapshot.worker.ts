import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { upsertConfigSnapshotAuditRecordInDatabase } from "./config-journal-snapshot.kernel.js";

export const configSnapshotOperations = {
  "config.metadata.write": (input: { now: string }, { open, stateOptions }) =>
    writeConfigMachineState("config.lastTouchedAt", input.now, {
      ...stateOptions(),
      database: open(),
    }),
  "config.snapshot.upsert": (
    input: Parameters<typeof upsertConfigSnapshotAuditRecordInDatabase>[1],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => upsertConfigSnapshotAuditRecordInDatabase(db, input),
      { ...stateOptions(), database: open() },
    ),
} satisfies WorkerOperationHandlers;
