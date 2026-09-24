import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChannelIngressFailedHealth,
  ChannelIngressPressureHealth,
} from "./ingress-queue-health.kernel.js";
import type {
  ChannelIngressClaimRequest,
  ChannelIngressClaimSnapshot,
  ChannelIngressListInput,
  ChannelIngressRow,
} from "./ingress-queue.types.js";

type ChannelIngressReadOperations = {
  "channelIngress.list": { input: ChannelIngressListInput; output: ChannelIngressRow[] };
  "channelIngress.accounts": { input: { channelId: string }; output: string[] };
  "channelIngress.claimSnapshot": {
    input: ChannelIngressClaimRequest;
    output: ChannelIngressClaimSnapshot;
  };
  "channelIngress.staleClaims": {
    input: { queueName: string; cutoff: number };
    output: ChannelIngressRow[];
  };
  "channelIngress.failedHealth": { input: undefined; output: ChannelIngressFailedHealth[] };
  "channelIngress.pressureHealth": {
    input: { now: number };
    output: ChannelIngressPressureHealth[];
  };
};

export type ChannelIngressReadCommand = {
  [Kind in keyof ChannelIngressReadOperations]: {
    type: Kind;
  } & (ChannelIngressReadOperations[Kind]["input"] extends undefined
    ? { input?: undefined }
    : { input: ChannelIngressReadOperations[Kind]["input"] });
}[keyof ChannelIngressReadOperations];

export function isChannelIngressReadCommand(value: unknown): value is ChannelIngressReadCommand {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "channelIngress.failedHealth") {
    return true;
  }
  const input = value.input;
  if (!isRecord(input)) {
    return false;
  }
  if (value.type === "channelIngress.pressureHealth") {
    return typeof input.now === "number";
  }
  if (value.type === "channelIngress.accounts") {
    return typeof input.channelId === "string";
  }
  if (typeof input.queueName !== "string") {
    return false;
  }
  if (value.type === "channelIngress.staleClaims") {
    return typeof input.cutoff === "number";
  }
  if (value.type === "channelIngress.list") {
    return (
      (input.status === "pending" ||
        input.status === "claimed" ||
        input.status === "failed" ||
        input.status === "unsettled") &&
      (input.limit === undefined || input.limit === "all" || typeof input.limit === "number") &&
      (input.orderBy === undefined || input.orderBy === "received" || input.orderBy === "id")
    );
  }
  return (
    value.type === "channelIngress.claimSnapshot" &&
    typeof input.deriveLaneKey === "boolean" &&
    Array.isArray(input.blockedLaneKeys) &&
    input.blockedLaneKeys.every((key) => typeof key === "string") &&
    (input.candidateIds === undefined ||
      (Array.isArray(input.candidateIds) &&
        input.candidateIds.every((id) => typeof id === "string"))) &&
    (input.scanLimit === undefined || typeof input.scanLimit === "number") &&
    (input.orderBy === undefined || input.orderBy === "received" || input.orderBy === "id")
  );
}

export type ChannelIngressReadReply = {
  [Kind in keyof ChannelIngressReadOperations]: {
    ok: true;
    type: Kind;
    sourceAdmitted: true;
    result: ChannelIngressReadOperations[Kind]["output"];
  };
}[keyof ChannelIngressReadOperations];
