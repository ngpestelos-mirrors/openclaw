import type {
  PluginStateBatch,
  PluginStateCompareIntent,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { matchesReefPeerIdentity, sameReefPeerIdentity } from "./friend-types.js";
import { applyReefStateBatch, REEF_STATE_KEEP as KEEP } from "./trust-store-batch.js";
import {
  ReefOutboundDeliveryBindingSchema,
  ReefOutboundDeliverySchema,
  ReefOutboundRejectionSchema,
  ReefPeerStateSchema,
  ReefPeerTrustChangedError,
  type ReefDeliverySettlement,
  type ReefOutboundDelivery,
  type ReefOutboundDeliveryBinding,
  type ReefOutboundDeliveryPreparation,
} from "./trust-store-format.js";

function matchesBinding(
  current: ReefOutboundDelivery,
  expected: ReefOutboundDeliveryBinding,
): boolean {
  return (
    current.bodyHash === expected.bodyHash &&
    current.textHash === expected.textHash &&
    sameReefPeerIdentity(current.recipient, expected.recipient)
  );
}

export async function prepareReefOutboundDelivery(
  batch: PluginStateBatch<unknown>,
  peerKey: string,
  deliveryKey: string,
  peer: string,
  id: string,
  assertCurrent: () => void,
): Promise<ReefOutboundDeliveryPreparation | undefined> {
  const rows = [
    { store: 0, key: peerKey },
    { store: 1, key: deliveryKey },
  ];
  const observations = await batch.observeExisting(rows);
  assertCurrent();
  const peerValue = observations?.[0]?.value;
  const trust = peerValue === undefined ? undefined : ReefPeerStateSchema.parse(peerValue).trust;
  if (!trust) {
    return undefined;
  }
  let pending = true;
  return {
    trust,
    async record(binding, options = {}) {
      if (!pending) {
        throw new Error("Reef outbound preparation was already consumed");
      }
      pending = false;
      const delivery = ReefOutboundDeliverySchema.parse({
        ...binding,
        ...options,
        sentAt: Date.now(),
      });
      await applyReefStateBatch(
        batch,
        rows,
        ([currentPeer, currentDelivery]) => {
          const current =
            currentPeer === undefined ? undefined : ReefPeerStateSchema.parse(currentPeer).trust;
          if (!matchesReefPeerIdentity(current, delivery.recipient)) {
            throw new ReefPeerTrustChangedError(peer);
          }
          if (currentDelivery !== undefined) {
            throw new Error(`Duplicate outbound Reef delivery id ${id}`);
          }
          return {
            intents: [KEEP, { operation: "update", action: "set", value: delivery }],
            value: undefined,
          };
        },
        observations,
      );
    },
  };
}

export async function readReefOutboundDelivery(
  batch: PluginStateBatch<unknown>,
  key: string,
  assertCurrent: () => void,
): Promise<ReefDeliverySettlement | undefined> {
  const rows = [{ store: 0, key }];
  const observations = await batch.observeExisting(rows);
  assertCurrent();
  const value = observations?.[0]?.value;
  if (value === undefined) {
    return undefined;
  }
  const delivery = ReefOutboundDeliverySchema.parse(value);
  const expected = ReefOutboundDeliveryBindingSchema.parse({
    bodyHash: delivery.bodyHash,
    textHash: delivery.textHash,
    recipient: delivery.recipient,
  });
  let pending = true;
  const settle = <T>(
    prepare: (current: unknown) => { intent: PluginStateCompareIntent<unknown>; value: T },
  ): Promise<T> => {
    if (!pending) {
      return Promise.reject(new Error("Reef delivery settlement was already consumed"));
    }
    pending = false;
    return applyReefStateBatch(
      batch,
      rows,
      ([current]) => {
        const prepared = prepare(current);
        return { intents: [prepared.intent], value: prepared.value };
      },
      observations,
    );
  };
  return {
    delivery,
    consume: () =>
      settle<"consumed" | "unavailable" | "rejected">((current) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(current);
        const remove =
          parsed.success && !parsed.data.rejection && matchesBinding(parsed.data, expected);
        return {
          intent: remove ? { operation: "delete", action: "delete" } : KEEP,
          value: remove
            ? "consumed"
            : parsed.success && parsed.data.rejection
              ? "rejected"
              : "unavailable",
        };
      }),
    discard: () =>
      settle((current) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(current);
        const remove = parsed.success && matchesBinding(parsed.data, expected);
        return { intent: remove ? { operation: "delete", action: "delete" } : KEEP, value: remove };
      }),
    reject: (category) => {
      const rejectedAt = Date.now();
      return settle<ReefOutboundDelivery["rejection"]>((current) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(current);
        if (!parsed.success || !matchesBinding(parsed.data, expected)) {
          return { intent: KEEP, value: undefined };
        }
        if (parsed.data.rejection) {
          // Duplicate receipts do not extend the original delivery retention.
          return { intent: KEEP, value: parsed.data.rejection };
        }
        const rejection = ReefOutboundRejectionSchema.parse({
          ...(category ? { category } : {}),
          ...(parsed.data.resendDisabled ? { notice: { lastRejectionAt: rejectedAt } } : {}),
        });
        return {
          intent: { operation: "update", action: "set", value: { ...parsed.data, rejection } },
          value: rejection,
        };
      });
    },
  };
}
