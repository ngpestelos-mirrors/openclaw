import { computeBackoff } from "./backoff.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { isRetainedStep, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import type { UpdateRunStep } from "./update-run-record.js";
import { updateRunStepKey } from "./update-run-step-key.js";

const REQUIRED_WRITE_BUDGET_MS = 120_000;
const BOOKKEEPING_WRITE_BUDGET_MS = 1_000;
const WRITE_BACKOFF = { initialMs: 25, maxMs: 250, factor: 2, jitter: 0 };

export class UpdateRunWriteBusyError extends Error {}

/** Recovery reads these receipts as well as phases and terminal outcomes. */
export function isRequiredUpdateRunStep(step: UpdateRunStep & { reason?: string }): boolean {
  const key = updateRunStepKey(step.step);
  return (
    isRetainedStep({ ...step, step: key }) ||
    step.status === "failed" ||
    step.reason !== undefined ||
    key === "openclaw doctor" ||
    key === "package rollback" ||
    key === "config rollback" ||
    key.startsWith("git-rollback-") ||
    key === "git-runtime-rollback"
  );
}

/** Retry only settled synchronous transactions, never a transaction callback. */
export function retryUpdateRunWrite<T>(
  write: (busyTimeoutMs: number) => T,
  options: Pick<UpdateRunLedgerOptions, "busyTimeoutMs">,
  bookkeeping = false,
): T {
  // Two minutes covers observed startup contention while remaining well below
  // the updater's 30-minute step budget. Explicit internal budgets stay bounded.
  const budget = normalizeSqliteNonNegativeInteger(
    options.busyTimeoutMs ?? (bookkeeping ? BOOKKEEPING_WRITE_BUDGET_MS : REQUIRED_WRITE_BUDGET_MS),
    "busyTimeoutMs",
  );
  const deadline = performance.now() + budget;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let attempt = 0;
  for (;;) {
    try {
      return write(Math.min(250, Math.max(0, Math.ceil(deadline - performance.now()))));
    } catch (cause) {
      if (!isSqliteLockError(cause)) {
        throw cause;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new UpdateRunWriteBusyError(
          `Update history database is locked by another writer after ${budget} ms. ` +
            "Wait for the writer to finish, then retry `openclaw update`. " +
            (bookkeeping
              ? "Bookkeeping was not recorded. The update will continue."
              : "Required recovery evidence was not recorded."),
          { cause },
        );
      }
      Atomics.wait(wait, 0, 0, Math.min(remaining, computeBackoff(WRITE_BACKOFF, ++attempt)));
    }
  }
}

export function recordUpdateRunBookkeeping<T>(write: () => T): T | undefined {
  try {
    return write();
  } catch (error) {
    if (!(error instanceof UpdateRunWriteBusyError)) {
      throw error;
    }
    console.warn(
      "[update] Update history database is locked by another writer; " +
        "a bookkeeping receipt could not be recorded. The update will continue.",
    );
    return undefined;
  }
}
