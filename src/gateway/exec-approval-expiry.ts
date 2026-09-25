import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { computeBackoff } from "../infra/backoff.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { ExecApprovalLifecycle, type PendingEntry } from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalReadAuthority,
} from "./exec-approval-manager.types.js";
import { assertExecApprovalMutationPersistenceCurrent } from "./exec-approval-recovery.js";
import type {
  OperatorApprovalResolver,
  OperatorApprovalTerminalReason,
  OperatorApprovalStoreGuard,
} from "./operator-approval-store.types.js";

/** The existing pending entry owns its deadline and any definite-refusal retry. */
export abstract class ExecApprovalExpiry<TPayload> extends ExecApprovalLifecycle<TPayload> {
  protected abstract override readonly options: Pick<
    ExecApprovalManagerOptions<TPayload>,
    "persistence" | "onError" | "onExpired" | "onLifecycle"
  >;
  abstract forceDenyDetailed(
    recordId: string,
    reason: OperatorApprovalTerminalReason,
    resolver: OperatorApprovalResolver,
    status?: "denied" | "expired" | "cancelled",
    localDecision?: ExecApprovalDecision | null,
    requireDue?: boolean,
    localResolvedBy?: string | null,
    assertResolverCurrent?: () => void,
    callerGuard?: OperatorApprovalStoreGuard,
  ): Promise<ExecApprovalForceDenyResult<TPayload>>;

  protected override scheduleExpiryTimer(
    entry: PendingEntry<TPayload>,
    delayMs = entry.record.expiresAtMs - Date.now(),
  ): void {
    if (
      this.retired ||
      entry.record.resolvedAtMs !== undefined ||
      this.pending.get(entry.record.id) !== entry
    ) {
      return;
    }
    clearTimeout(entry.timer ?? undefined);
    const timer = setTimeout(
      () => {
        if (this.retired || this.pending.get(entry.record.id) !== entry || entry.timer !== timer) {
          return;
        }
        entry.timer = null;
        void this.expireDue(entry.record.id).catch((error: unknown) => {
          this.reportError(error, { approvalId: entry.record.id, operation: "expire" });
        });
      },
      resolveTimerTimeoutMs(delayMs, 1),
    );
    entry.timer = timer;
  }

  protected override async expireDue(
    recordId: string,
    authority?: ExecApprovalReadAuthority,
  ): Promise<boolean> {
    authority?.assertCurrent();
    if (this.retired) {
      return false;
    }
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    this.assertPendingPersistenceCurrent(entry);
    const persistence = entry.persistence;
    let result: ExecApprovalForceDenyResult<TPayload>;
    try {
      result = await this.forceDenyDetailed(
        recordId,
        "timeout",
        { kind: "system", id: null },
        "expired",
        undefined,
        true,
        null,
        undefined,
        authority?.guard,
      );
    } catch (error) {
      // Only canonical pre-execution refusals can replay the timeout CAS. Cleanup
      // aggregates and lost replies retain their existing outcome-unknown recovery.
      if (isSqliteWorkerError(error, "overloaded") || isSqliteWorkerError(error, "unavailable")) {
        assertExecApprovalMutationPersistenceCurrent(persistence);
        this.assertPendingPersistenceCurrent(entry);
        entry.expiryRefusals = (entry.expiryRefusals ?? 0) + 1;
        this.scheduleExpiryTimer(
          entry,
          computeBackoff(
            { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.1 },
            entry.expiryRefusals,
          ),
        );
      }
      throw error;
    }
    authority?.assertCurrent();
    if (
      result.outcome === "not-due" ||
      (entry.record.resolvedAtMs === undefined && this.pending.get(recordId) === entry)
    ) {
      // A terminal but unattributable verdict still owns its original deadline after clock rollback.
      this.scheduleExpiryTimer(entry);
      return false;
    }
    return result.outcome === "denied" || result.outcome === "expired";
  }
}
