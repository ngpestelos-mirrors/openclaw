import type {
  PluginStateBatch,
  PluginStateCompareIntent,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  matchesReefPeerIdentity,
  sameReefPeerIdentity,
  reefPeerIdentity,
  ReefPeerIdentitySchema,
  type ReefPeerIdentity,
} from "./friend-types.js";
import { createReefPeerAssertion } from "./trust-store-authority.js";
import { applyReefStateBatch, REEF_STATE_KEEP as KEEP } from "./trust-store-batch.js";
import {
  ReefOutboundDeliveryBindingSchema,
  ReefOutboundDeliverySchema,
  ReefOutboundRejectionSchema,
  ReefPeerStateSchema,
  ReefRejectionNoticeStateSchema,
  MESSAGE_ID_PATTERN,
  requirePeer,
  ReefPeerTrustChangedError,
  type ReefDeliverySettlement,
  type ReefOutboundDelivery,
  type ReefPeerStateSnapshot,
  type ReefOutboundDeliveryBinding,
  type ReefOutboundDeliveryPreparation,
} from "./trust-store-format.js";
import type { ReefRejectionRecovery } from "./types.js";

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
    assertCurrent: createReefPeerAssertion(batch, rows[0]!, peer, reefPeerIdentity(trust)),
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
  peerKey: string,
  key: string,
  peer: string,
  assertCurrent: () => void,
): Promise<ReefDeliverySettlement | undefined> {
  const rows = [{ store: 1, key }];
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
    recovery: createReefRejectionRecovery(
      batch,
      peerKey,
      key,
      peer,
      key.slice(key.lastIndexOf(":") + 1),
      expected.recipient,
      assertCurrent,
    ),
    async currentPeer() {
      const current = (await batch.observeExisting([{ store: 0, key: peerKey }]))?.[0]?.value;
      assertCurrent();
      return current === undefined ? undefined : ReefPeerStateSchema.parse(current).trust;
    },
    assertCurrent: createReefPeerAssertion(
      batch,
      { store: 0, key: peerKey },
      peer,
      expected.recipient,
    ),
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

export function createReefRejectionRecovery(
  batch: PluginStateBatch<unknown>,
  peerKey: string,
  deliveryKey: string,
  peer: string,
  id: string,
  recipient: ReefPeerIdentity,
  assertActive: () => void,
): ReefRejectionRecovery {
  const parsePeerState = (value: unknown): ReefPeerStateSnapshot =>
    value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  const capturedRecipient = { ...recipient };
  const rows = [
    { store: 0, key: peerKey },
    { store: 1, key: deliveryKey },
  ];
  return {
    assertCurrent: createReefPeerAssertion(
      batch,
      { store: 0, key: peerKey },
      peer,
      capturedRecipient,
    ),
    async loadState() {
      const value = (await batch.observeExisting([{ store: 0, key: peerKey }]))?.[0]?.value;
      assertActive();
      return parsePeerState(value).rejectionNotice;
    },
    async reserve(state) {
      const expected = ReefPeerIdentitySchema.parse(capturedRecipient);
      const notice = ReefRejectionNoticeStateSchema.parse(state);
      const observations = await batch.observeExisting(rows);
      assertActive();
      if (!observations) {
        throw new Error(`Reef rejection ${id} lost its durable delivery state`);
      }
      return applyReefStateBatch(
        batch,
        rows,
        ([peerValue, value]) => {
          if (!matchesReefPeerIdentity(parsePeerState(peerValue).trust, expected)) {
            throw new Error(
              `Reef peer @${requirePeer(peer)} changed keys before rejection recovery`,
            );
          }
          const parsed = ReefOutboundDeliverySchema.safeParse(value);
          if (
            !parsed.success ||
            !parsed.data.rejection ||
            !sameReefPeerIdentity(parsed.data.recipient, expected)
          ) {
            throw new Error(`Reef rejection ${id} lost its durable delivery state`);
          }
          const existing = parsed.data.rejection.notice;
          // Recovery renews retention even when it reuses an existing reservation.
          return {
            intents: [
              KEEP,
              {
                operation: "update",
                action: "set",
                value: existing
                  ? parsed.data
                  : { ...parsed.data, rejection: { ...parsed.data.rejection, notice } },
              },
            ],
            value: existing
              ? { kind: "existing" as const, state: existing }
              : { kind: "reserved" as const },
          };
        },
        observations,
      );
    },
    async complete(state) {
      const notice = ReefRejectionNoticeStateSchema.parse(state);
      const observations = await batch.observeExisting(rows);
      assertActive();
      if (!observations) {
        throw new Error(`Reef rejection ${id} lost its durable delivery state`);
      }
      return applyReefStateBatch(
        batch,
        rows,
        ([peerValue, value]) => {
          const current = parsePeerState(peerValue);
          const previous = current.rejectionNotice;
          const hasResendAt =
            previous?.lastResendAt !== undefined || notice.lastResendAt !== undefined;
          const next = {
            ...current,
            rejectionNotice: {
              lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, notice.lastRejectionAt),
              ...(hasResendAt
                ? { lastResendAt: Math.max(previous?.lastResendAt ?? 0, notice.lastResendAt ?? 0) }
                : {}),
            },
          };
          const delivery = ReefOutboundDeliverySchema.safeParse(value);
          const deleted = delivery.success && delivery.data.rejection?.notice !== undefined;
          return {
            intents: [
              { operation: "update", action: "set", value: next },
              deleted ? { operation: "delete", action: "delete" } : KEEP,
            ],
            value: deleted || value === undefined,
          };
        },
        observations,
      );
    },
    prepareOutboundDelivery(nextId) {
      if (!MESSAGE_ID_PATTERN.test(nextId)) {
        throw new Error(`Invalid Reef delivery id: ${nextId}`);
      }
      return prepareReefOutboundDelivery(
        batch,
        peerKey,
        `${peerKey}:${nextId}`,
        peer,
        nextId,
        assertActive,
      );
    },
  };
}
