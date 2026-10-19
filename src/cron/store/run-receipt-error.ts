import { receiptHandle } from "./run-receipt-read.js";
import type { CronRunReceipt, CronRunReceiptRecoveryCandidate } from "./run-receipt.types.js";

export class CronRunReceiptConflictError extends Error {
  readonly candidate: CronRunReceiptRecoveryCandidate;

  constructor(readonly receipt: CronRunReceipt) {
    super(`cron job ${receipt.jobId} is already running in process ${receipt.ownerPid}`);
    this.name = "CronRunReceiptConflictError";
    this.candidate = receiptHandle(receipt);
  }
}
