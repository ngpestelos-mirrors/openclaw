import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import * as kernel from "./ingress-queue.kernel.js";
import type { ChannelIngressWorkerOperations } from "./ingress-queue.worker-contract.js";

export function isChannelIngressCommand(command: {
  type: string;
}): command is { type: keyof ChannelIngressWorkerOperations } {
  return (
    command.type === "channelIngress.enqueue" ||
    command.type === "channelIngress.claim" ||
    command.type === "channelIngress.claimNext" ||
    command.type === "channelIngress.recover" ||
    command.type === "channelIngress.refresh" ||
    command.type === "channelIngress.complete" ||
    command.type === "channelIngress.release" ||
    command.type === "channelIngress.fail" ||
    command.type === "channelIngress.delete" ||
    command.type === "channelIngress.resubmit" ||
    command.type === "channelIngress.prune"
  );
}

export function executeChannelIngressCommand(
  command: SqliteWorkerCommand<ChannelIngressWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): ChannelIngressWorkerOperations[keyof ChannelIngressWorkerOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = executeInTransaction(db, command);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { path: options.database.path, env: options.env },
  );
}

function executeInTransaction(
  db: OpenClawStateDatabase["db"],
  command: SqliteWorkerCommand<ChannelIngressWorkerOperations>,
) {
  switch (command.type) {
    case "channelIngress.enqueue":
      return kernel.enqueueChannelIngressInDatabase(db, command.input);
    case "channelIngress.claim":
      return kernel.claimChannelIngressInDatabase(db, command.input);
    case "channelIngress.claimNext":
      return kernel.claimNextChannelIngressInDatabase(db, command.input);
    case "channelIngress.recover":
      return kernel.recoverChannelIngressClaimInDatabase(db, command.input);
    case "channelIngress.refresh":
      return kernel.refreshChannelIngressClaimInDatabase(db, command.input);
    case "channelIngress.complete":
      return kernel.completeChannelIngressInDatabase(db, command.input);
    case "channelIngress.release":
      return kernel.releaseChannelIngressInDatabase(db, command.input);
    case "channelIngress.fail":
      return kernel.failChannelIngressInDatabase(db, command.input);
    case "channelIngress.delete":
      return kernel.deleteChannelIngressInDatabase(db, command.input);
    case "channelIngress.resubmit":
      return kernel.resubmitChannelIngressInDatabase(db, command.input);
    case "channelIngress.prune":
      return kernel.pruneChannelIngressInDatabase(db, command.input);
  }
  return command satisfies never;
}
