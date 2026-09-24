import type { DatabaseSync } from "node:sqlite";
import {
  countChannelIngressQueuePressureInDatabase,
  countFailedChannelIngressQueueEntriesInDatabase,
} from "./ingress-queue-health.kernel.js";
import type {
  ChannelIngressReadCommand,
  ChannelIngressReadReply,
} from "./ingress-queue-read-contract.js";
import {
  listChannelIngressAccountsInDatabase,
  listChannelIngressRowsInDatabase,
  listStaleChannelIngressClaimsInDatabase,
  readChannelIngressClaimSnapshotInDatabase,
} from "./ingress-queue.kernel.js";

export function readChannelIngressInDatabase(
  db: DatabaseSync,
  command: ChannelIngressReadCommand,
): ChannelIngressReadReply {
  switch (command.type) {
    case "channelIngress.list":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: listChannelIngressRowsInDatabase(db, command.input),
      };
    case "channelIngress.accounts":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: listChannelIngressAccountsInDatabase(db, command.input),
      };
    case "channelIngress.claimSnapshot":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: readChannelIngressClaimSnapshotInDatabase(db, command.input),
      };
    case "channelIngress.staleClaims":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: listStaleChannelIngressClaimsInDatabase(db, command.input),
      };
    case "channelIngress.failedHealth":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: countFailedChannelIngressQueueEntriesInDatabase(db),
      };
    case "channelIngress.pressureHealth":
      return {
        ok: true,
        sourceAdmitted: true,
        type: command.type,
        result: countChannelIngressQueuePressureInDatabase(db, command.input.now),
      };
  }
  return command satisfies never;
}
