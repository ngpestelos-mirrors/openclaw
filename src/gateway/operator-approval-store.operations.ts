import {
  prepareCronReceiptAuthorityPublication,
  readCronReceiptAuthorityAttachment,
} from "../cron/store/receipt-authority-publication.js";
import type {
  CronReceiptAuthorityAttachment,
  CronReceiptAuthorityPublication,
} from "../cron/store/receipt-authority.types.js";
import { execApprovalsPublication } from "../infra/exec-approvals-publication.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { WorkerOperationContext } from "../state/worker-operation-registry.js";
import * as grants from "./operator-approval-standing-grants.js";
import type { CronStandingGrantRecord } from "./operator-approval-standing-grants.types.js";
import * as store from "./operator-approval-store.kernel.js";
import {
  operatorApprovalPublication,
  operatorStandingGrantPublication,
} from "./operator-approval-store.publication.js";
import { getOperatorApprovalResolutionKey } from "./operator-approval-store.rows.js";
import * as transitions from "./operator-approval-store.transitions.js";

export type OperatorApprovalCommitReceipt = {
  type?: "operatorApprovals.resolve";
  resolutionKey?: string;
  grantUse?: CronStandingGrantRecord;
  receiptAuthority?: CronReceiptAuthorityPublication;
  approvalFacts?: ReturnType<typeof operatorApprovalPublication.bound>;
  standingGrantFacts?: ReturnType<typeof operatorStandingGrantPublication.bound>;
  execFacts?: ReturnType<typeof execApprovalsPublication.bound>;
};
type Context = Pick<WorkerOperationContext, "open" | "stateOptions"> & {
  native?: {
    assertCurrent: () => void;
    receiptAuthority: CronReceiptAuthorityAttachment;
    onCommitted: (receipt: OperatorApprovalCommitReceipt) => void;
  };
};
type Input<Handler extends (input: never) => unknown> = Omit<
  NonNullable<Parameters<Handler>[0]>,
  "databaseOptions"
>;

function operation<Handler extends (input: never) => unknown>(
  apply: Handler,
  receiptOf?: (result: ReturnType<Handler>) => OperatorApprovalCommitReceipt | undefined,
): (input: Input<Handler>, context: Context) => ReturnType<Handler>;
function operation<Payload, Result>(
  apply: (input: Payload & { databaseOptions: OpenClawStateDatabaseOptions }) => Result,
  receiptOf?: (result: Result) => OperatorApprovalCommitReceipt | undefined,
) {
  return (input: Payload, context: Context): Result => {
    const attachment = context.native
      ? context.native.receiptAuthority
      : readCronReceiptAuthorityAttachment();
    const options = { ...context.stateOptions(), database: context.open() };
    const assertCurrent = (stage: "transaction" | "commit") =>
      context.native
        ? context.native.assertCurrent()
        : requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
    return runOpenClawStateWriteTransaction((database) => {
      assertCurrent("transaction");
      const approval = operatorApprovalPublication.capture(database.db, () =>
        operatorStandingGrantPublication.capture(database.db, () =>
          execApprovalsPublication.capture(database.db, () =>
            apply({ ...input, databaseOptions: { ...options, database } }),
          ),
        ),
      );
      const standing = approval.result;
      const exec = standing.result;
      const result = exec.result;
      const receiptAuthority = attachment
        ? context.native
          ? { nonce: attachment.nonce, sequence: 1 }
          : prepareCronReceiptAuthorityPublication(database.db, attachment)
        : undefined;
      const receipt = {
        ...receiptOf?.(result),
        ...(receiptAuthority ? { receiptAuthority } : {}),
        approvalFacts: operatorApprovalPublication.bound(approval.receipt),
        standingGrantFacts: operatorStandingGrantPublication.bound(standing.receipt),
        execFacts: execApprovalsPublication.bound(exec.receipt),
      };
      if (!context.native) {
        const changed =
          approval.receipt.facts.size + standing.receipt.facts.size + exec.receipt.facts.size > 0;
        deferSqliteWorkerCommitReceipt(
          database.db,
          receipt,
          changed || receipt.resolutionKey || receipt.grantUse ? "commit" : "settlement",
        );
      } else {
        const publish = context.native.onCommitted;
        if (!deferSqlitePostCommitPublication(database.db, () => publish(receipt))) {
          throw new Error("Operator approval commit receipt requires a transaction owner");
        }
      }
      assertCurrent("commit");
      return result;
    }, options);
  };
}

export const operatorApprovalOperations = {
  "operatorApprovals.insert": operation(store.insertOperatorApprovalInDatabase),
  "operatorApprovals.get": operation(store.getOperatorApprovalDetailedInDatabase),
  "operatorApprovals.pending": operation(store.listPendingOperatorApprovalsInDatabase),
  "operatorApprovals.resolve": operation(transitions.resolveOperatorApprovalInDatabase, (result) =>
    result.outcome === "resolved"
      ? {
          type: "operatorApprovals.resolve",
          resolutionKey: getOperatorApprovalResolutionKey(result.record),
        }
      : undefined,
  ),
  "operatorApprovals.deny": operation(transitions.forceDenyOperatorApprovalInDatabase),
  "operatorApprovals.expire": operation(transitions.expireDueOperatorApprovalsInDatabase),
  "operatorApprovals.consume": operation(transitions.consumeOperatorApprovalAllowOnceInDatabase),
  "operatorApprovals.consumeCronGrant": operation(
    grants.consumeCronStandingGrantInDatabase,
    (result) => (result.outcome === "consumed" ? { grantUse: result.grant } : undefined),
  ),
  "operatorApprovals.revokeCronGrant": operation(grants.revokeCronStandingGrantInDatabase),
} satisfies Record<string, (input: never, context: Context) => unknown>;
