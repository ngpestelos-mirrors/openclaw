import type { SessionEntry } from "../../config/sessions/types.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  markCommandReplyForDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";

type FinalReplyAcknowledgment = NonNullable<
  ReturnType<typeof getReplyPayloadMetadata>
>["onFinalDeliverySuccess"];
const policyAcknowledgments = new WeakMap<
  NonNullable<FinalReplyAcknowledgment>,
  {
    deferred: boolean;
    acknowledge: () => Promise<void>;
    publication: Deferred;
  }
>();

/** Gateway capture transfers receipt ownership to its visible final publication. */
export function deferModelPolicyNoticeAcknowledgment(payload: ReplyPayload): void {
  const callback = getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess;
  const receipt = callback ? policyAcknowledgments.get(callback) : undefined;
  if (receipt) {
    receipt.deferred = true;
  }
}

export function waitForModelPolicyNoticePublication(
  payload: ReplyPayload,
): Promise<void> | undefined {
  const callback = getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess;
  const receipt = callback ? policyAcknowledgments.get(callback) : undefined;
  return receipt?.deferred ? receipt.publication.promise : undefined;
}

export async function settleModelPolicyNoticePublication(
  payload: ReplyPayload,
  delivered: boolean,
): Promise<void> {
  const callback = getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess;
  const receipt = callback ? policyAcknowledgments.get(callback) : undefined;
  if (!receipt?.deferred) {
    return;
  }
  try {
    if (delivered) {
      await receipt.acknowledge();
    }
  } finally {
    receipt.publication.resolve();
  }
}

type ModelPolicyNoticeParams = {
  payloads: ReplyPayload[];
  pinnedModel: string;
  primaryModel: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
};

/** The notice preserves the input payload count, including silent payloads. */
export function attachModelPolicyNotice(
  params: ModelPolicyNoticeParams & { payloads: [ReplyPayload, ...ReplyPayload[]] },
): [ReplyPayload, ...ReplyPayload[]];
export function attachModelPolicyNotice(params: ModelPolicyNoticeParams): ReplyPayload[];
export function attachModelPolicyNotice(params: ModelPolicyNoticeParams): ReplyPayload[] {
  const { sessionEntry, pinnedModel, primaryModel, sessionKey, storePath } = params;
  const sessionId = sessionEntry?.sessionId;
  const candidates = params.payloads.flatMap((original, index) => {
    if (original.isReasoning || original.isCommentary || original.isFallbackNotice) {
      return [];
    }
    const normalized = normalizeReplyPayload(original, { applyChannelTransforms: false });
    return normalized ? [{ original, normalized, index }] : [];
  });
  const candidate = candidates.find(({ original }) => !original.isError) ?? candidates[0];
  if (!candidate) {
    return params.payloads;
  }
  const { original, normalized, index } = candidate;
  if (
    !original.isError &&
    sessionId &&
    sessionEntry.modelPolicyNotice?.sessionId === sessionId &&
    sessionEntry.modelPolicyNotice.pinnedModel === pinnedModel
  ) {
    return params.payloads;
  }
  const notice = original.isError
    ? `Pinned model ${pinnedModel} is not in your allow list, and the configured default could not answer. Use /model to change it.`
    : `Pinned model ${pinnedModel} is not in your allow list. This reply used the default (${primaryModel}). Use /model to change it.`;
  const payload = copyReplyPayloadMetadata(original, {
    ...normalized,
    text: normalized.text ? `${notice}\n\n${normalized.text}` : notice,
  });
  const previousSuccess = getReplyPayloadMetadata(original)?.onFinalDeliverySuccess;
  const expectedProvider = sessionEntry?.providerOverride;
  const expectedModel = sessionEntry?.modelOverride;
  let committed = false;
  const receiptOwner = {
    deferred: false,
    publication: createDeferredCore(),
    acknowledge: async () => {
      if (committed) {
        return;
      }
      await previousSuccess?.();
      if (original.isError || !sessionEntry || !sessionId) {
        return;
      }
      const receipt = { sessionId, pinnedModel };
      if (storePath && sessionKey) {
        const { patchSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
        const updated = await patchSessionEntryCore(
          { storePath, sessionKey },
          (current) =>
            current.sessionId === sessionId &&
            current.providerOverride === expectedProvider &&
            current.modelOverride === expectedModel
              ? { modelPolicyNotice: receipt }
              : null,
          { preserveActivity: true, skipMaintenance: true },
        );
        if (!updated) {
          return;
        }
      }
      if (
        sessionEntry.sessionId === sessionId &&
        sessionEntry.providerOverride === expectedProvider &&
        sessionEntry.modelOverride === expectedModel
      ) {
        sessionEntry.modelPolicyNotice = receipt;
      }
      committed = true;
    },
  };
  const onFinalDeliverySuccess = async () => {
    if (!receiptOwner.deferred) {
      await receiptOwner.acknowledge();
    }
  };
  policyAcknowledgments.set(onFinalDeliverySuccess, receiptOwner);
  setReplyPayloadMetadata(payload, { onFinalDeliverySuccess });
  return params.payloads.map((existing, payloadIndex) =>
    payloadIndex === index ? payload : existing,
  );
}

export function attachModelPolicyCommandNotice(params: {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  pinnedModel?: string;
  usesPrimary?: boolean;
  provider: string;
  model: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
}): ReplyPayload | ReplyPayload[] | undefined {
  const reply = markCommandReplyForDelivery(params.reply);
  const { sessionEntry, pinnedModel } = params;
  if (!reply || !params.usesPrimary || !pinnedModel) {
    return reply;
  }
  if (
    sessionEntry?.modelOverride &&
    `${sessionEntry.providerOverride ?? params.provider}/${sessionEntry.modelOverride}` !==
      pinnedModel
  ) {
    return reply;
  }
  const payloads = attachModelPolicyNotice({
    ...params,
    payloads: Array.isArray(reply) ? reply : [reply],
    pinnedModel,
    primaryModel: `${params.provider}/${params.model}`,
  });
  return Array.isArray(reply) ? payloads : payloads[0];
}

export function attachModelPolicyFailureNotice(
  reply: ReplyPayload,
  run: {
    blockedModelOverrideRef?: string;
    blockedModelOverrideUsesPrimary?: boolean;
    provider: string;
    model: string;
  },
): ReplyPayload {
  if (!reply.isError || !run.blockedModelOverrideUsesPrimary || !run.blockedModelOverrideRef) {
    return reply;
  }
  return attachModelPolicyNotice({
    payloads: [reply],
    pinnedModel: run.blockedModelOverrideRef,
    primaryModel: `${run.provider}/${run.model}`,
  })[0];
}
