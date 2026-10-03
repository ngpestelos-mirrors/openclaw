import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";

export function resolveCronSourceDeliveryPlan(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: SourceDeliveryPlan["target"] & {
    ok?: boolean;
    deliverySuppressionReason?: "channel_transform";
  };
}): SourceDeliveryPlan {
  const target = {
    channel: params.resolvedDelivery.channel,
    to: params.resolvedDelivery.to,
    accountId: params.resolvedDelivery.accountId,
    threadId: params.resolvedDelivery.threadId,
  };

  if (params.deliveryPlan.mode === "webhook") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_webhook",
      messageToolEnabled: false,
      directFallback: false,
    });
  }

  if (params.deliveryPlan.mode === "none") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target,
      messageToolEnabled: !params.resolvedDelivery.deliverySuppressionReason,
      messageToolForced: false,
      directFallback: false,
    });
  }

  return createSourceDeliveryPlan({
    owner: "direct_fallback",
    reason: "cron_announce",
    target,
    messageToolEnabled:
      !params.resolvedDelivery.deliverySuppressionReason &&
      (params.deliveryPlan.target !== "owner" || params.resolvedDelivery.ok === true),
    messageToolForced: false,
    requireExplicitMessageTarget: true,
    requireExplicitMessageTargetEvidence: true,
    directFallback: true,
    skipFallbackWhenMessageToolSentToTarget: params.resolvedDelivery.ok ?? true,
  });
}
