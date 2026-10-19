import { restoreCronLoadError, serializeCronLoadError } from "./load-error.js";
import { CronRunReceiptConflictError } from "./run-receipt-error.js";
import type { CronRunReceipt } from "./run-receipt.types.js";

export class CronJobsStoreChangedError extends Error {
  constructor(storePath: string) {
    super(`Cron store at ${storePath} changed after it was read; reload it before writing`);
    this.name = "CronJobsStoreChangedError";
  }
}

export type CronSaveError =
  | { kind: "store-changed"; storePath: string }
  | { kind: "receipt-conflict"; receipt: CronRunReceipt }
  | { kind: "other"; error: ReturnType<typeof serializeCronLoadError> };

export function serializeCronSaveError(error: unknown, storePath: string): CronSaveError {
  if (error instanceof CronRunReceiptConflictError) {
    return { kind: "receipt-conflict", receipt: error.receipt };
  }
  return error instanceof CronJobsStoreChangedError
    ? { kind: "store-changed", storePath }
    : { kind: "other", error: serializeCronLoadError(error) };
}

export function restoreCronSaveError(error: CronSaveError): Error {
  if (error.kind === "receipt-conflict") {
    return new CronRunReceiptConflictError(error.receipt);
  }
  return error.kind === "store-changed"
    ? new CronJobsStoreChangedError(error.storePath)
    : restoreCronLoadError(error.error);
}
