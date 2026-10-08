import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateCompareIntent,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { z } from "zod";
import type { ReefChannelConfig } from "./config-schema.js";
import {
  ReefAutonomySchema,
  ReefPeerTrustSchema,
  matchesReefPeerIdentity,
  reefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerTrust,
} from "./friend-types.js";
import { createReefPeerAssertion } from "./trust-store-authority.js";
import { applyReefStateBatch, REEF_STATE_KEEP as KEEP } from "./trust-store-batch.js";
import {
  createReefRejectionRecovery,
  prepareReefOutboundDelivery,
  readReefOutboundDelivery,
} from "./trust-store-delivery.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
  REEF_OUTBOUND_DELIVERY_TTL_MS,
  MESSAGE_ID_PATTERN,
  ReefOutboundDeliverySchema,
  ReefPeerStateSchema,
  createReefPairingApproval,
  parseReefPairingApproval,
  reefOutboundRequestStatus,
  withoutReefOutboundRequest,
  type ReefRequestSettlement,
  requirePeer,
  resolveReefIdentityScope,
  type ReefPeerStateSnapshot,
  type ReefOutboundDelivery,
} from "./trust-store-format.js";
import { LegacyReefTrustStore } from "./trust-store.legacy.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState, RelayFriend } from "./types.js";

export {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  isReefPairingApprovalToken,
  resolveReefTrustStoreKey,
  ReefPeerTrustChangedError,
} from "./trust-store-format.js";
export type ReefTrustStore = WorkerReefTrustStore | LegacyReefTrustStore;
type ReefTrustStores = {
  peers: PluginStateKeyedStore<ReefPeerStateSnapshot>;
  deliveries: PluginStateKeyedStore<ReefOutboundDelivery>;
};

function openStores(openStore: PluginRuntime["state"]["openKeyedStore"]): ReefTrustStores {
  return {
    peers: openStore<ReefPeerStateSnapshot>({
      namespace: REEF_TRUST_STORE_NAMESPACE,
      maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    // The envelope and its receipt can each spend 30 days queued. Keep a
    // boundary margin so a delayed receipt still finds its exact send binding.
    deliveries: openStore<z.infer<typeof ReefOutboundDeliverySchema>>({
      namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
      maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_OUTBOUND_DELIVERY_TTL_MS,
    }),
  };
}

/** Canonical local Reef authorization state for one relay identity. */
class WorkerReefTrustStore {
  readonly #identityScope: string;
  readonly #prefix: string;

  constructor(
    readonly stores: ReefTrustStores,
    config: ReefChannelConfig,
    private readonly currentPeers: PluginStateSyncKeyedStore<ReefPeerStateSnapshot>,
    private readonly assertActive?: () => void,
  ) {
    this.#identityScope = resolveReefIdentityScope(config);
    this.#prefix = `${this.#identityScope}:`;
  }

  async snapshot(peer: string): Promise<ReefPeerStateSnapshot> {
    this.assertActive?.();
    const value = await this.stores.peers.lookup(this.#key(peer));
    this.assertActive?.();
    return this.#parseState(value);
  }

  async get(peer: string): Promise<ReefPeerTrust | undefined> {
    return (await this.snapshot(peer)).trust;
  }

  async observePeer(peer: string) {
    const key = { store: 0, key: this.#key(peer) };
    const batch = this.stores.peers.createBatch!<unknown>([this.stores.peers], {
      assertCurrent: () => this.assertActive?.(),
    });
    const observations = await batch.observeExisting([key]);
    this.assertActive?.();
    const trust = this.#parseState(observations?.[0]?.value).trust;
    return trust
      ? {
          trust,
          assertCurrent: createReefPeerAssertion(
            batch,
            key,
            peer,
            reefPeerIdentity(trust),
            trust.autonomy,
          ),
        }
      : undefined;
  }

  // Released ChannelPlugin policy and account-description adapters are synchronous.
  listCurrent(): Array<{ peer: string; trust: ReefPeerTrust }> {
    this.assertActive?.();
    return this.#list(this.currentPeers.entries());
  }

  async list(): Promise<Array<{ peer: string; trust: ReefPeerTrust }>> {
    this.assertActive?.();
    const entries = await this.stores.peers.entries();
    this.assertActive?.();
    return this.#list(entries);
  }

  #list(entries: PluginStateEntry<unknown>[]): Array<{ peer: string; trust: ReefPeerTrust }> {
    return entries
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const state = ReefPeerStateSchema.parse(entry.value);
        return state.trust
          ? [{ peer: requirePeer(entry.key.slice(this.#prefix.length)), trust: state.trust }]
          : [];
      })
      .toSorted((left, right) => (left.peer === right.peer ? 0 : left.peer < right.peer ? -1 : 1));
  }

  async set(peer: string, trust: ReefPeerTrust): Promise<void> {
    const parsedTrust = ReefPeerTrustSchema.parse(trust);
    await this.#updatePeer(peer, (current) => ({
      ...current,
      revision: current.revision + 1,
      trust: parsedTrust,
    }));
  }

  async remove(peer: string, assertCurrent?: () => void): Promise<boolean> {
    // Keep the revision tombstone so an older reconciliation cannot restore trust.
    return this.#updatePeer(peer, (current) => ({ revision: current.revision + 1 }), assertCurrent);
  }

  async beginRemoval(peer: string, assertOwnerCurrent?: () => void): Promise<() => Promise<void>> {
    const rows = [{ store: 0, key: this.#key(peer) }];
    let phase: "revoking" | "ready" | "settling" | "settled" = "revoking";
    const batch = this.stores.peers.createBatch!<unknown>([this.stores.peers], {
      assertCurrent: () => {
        if (phase === "revoking") {
          this.assertActive?.();
          assertOwnerCurrent?.();
        } else if (phase !== "settling") {
          throw new Error("Reef removal settlement is not active");
        }
      },
    });
    const revoke = () =>
      applyReefStateBatch(batch, rows, ([value]) => ({
        intents: [
          {
            operation: "update",
            action: "set",
            value: { revision: this.#parseState(value).revision + 1 },
          },
        ],
        value: undefined,
      }));
    await revoke();
    // Acknowledged revocation owns one exact-peer cleanup on the captured source.
    phase = "ready";
    return async () => {
      if (phase !== "ready") {
        throw new Error("Reef removal settlement was already consumed");
      }
      phase = "settling";
      try {
        await revoke();
      } finally {
        phase = "settled";
      }
    };
  }

  async setAutonomy(
    peer: string,
    autonomy: ReefAutonomy,
    assertCurrent?: () => void,
  ): Promise<void> {
    const normalized = ReefAutonomySchema.parse(autonomy);
    const changed = await this.#updatePeer(
      peer,
      (current) =>
        current.trust
          ? { ...current, trust: { ...current.trust, autonomy: normalized } }
          : undefined,
      assertCurrent,
    );
    if (!changed) {
      throw new Error(`Reef peer @${requirePeer(peer)} is not locally trusted`);
    }
  }

  async markSafetyNumberChanged(peer: string, expectedRevision: number): Promise<boolean> {
    return this.#updatePeer(peer, (current) =>
      current.revision === expectedRevision && current.trust
        ? {
            ...current,
            revision: current.revision + 1,
            trust: { ...current.trust, safetyNumberChanged: true },
          }
        : undefined,
    );
  }

  async commitPeerTrust(
    friend: RelayFriend,
    options: { expectedRevision: number; expectedOutboundRequestId?: string },
    approvedAt = Date.now(),
  ): Promise<boolean> {
    const capturedFriend = { ...friend };
    const capturedOptions = { ...options };
    return this.#updatePeer(capturedFriend.peer, (current) => {
      if (
        current.revision !== capturedOptions.expectedRevision ||
        (capturedOptions.expectedOutboundRequestId !== undefined &&
          current.outboundRequests?.[capturedOptions.expectedOutboundRequestId] === undefined)
      ) {
        return undefined;
      }
      return {
        revision: current.revision + 1,
        trust: {
          autonomy: current.trust?.autonomy ?? "bounded",
          ed25519PublicKey: capturedFriend.ed25519_pub,
          x25519PublicKey: capturedFriend.x25519_pub,
          keyEpoch: capturedFriend.key_epoch,
          safetyNumberChanged: false,
          approvedAt,
        },
        ...(current.rejectionNotice ? { rejectionNotice: current.rejectionNotice } : {}),
      };
    });
  }

  createPairingApproval(friend: RelayFriend, trustRevision: number): string {
    return createReefPairingApproval(this.#identityScope, friend, trustRevision);
  }

  parsePairingApproval(raw: string) {
    return parseReefPairingApproval(this.#identityScope, raw);
  }

  async matchesPairingApproval(raw: string, friend: RelayFriend): Promise<boolean> {
    const captured = { ...friend };
    return (
      raw.trim() ===
      this.createPairingApproval(captured, (await this.snapshot(captured.peer)).revision)
    );
  }

  async beginRequest(
    peer: string,
    requestedAt = Date.now(),
    assertOwnerCurrent?: () => void,
  ): Promise<ReefRequestSettlement> {
    const requestId = randomUUID();
    const rows = [{ store: 0, key: this.#key(peer) }];
    let phase: "recording" | "ready" | "settling" | "closed" = "recording";
    const batch = this.stores.peers.createBatch!<unknown>([this.stores.peers], {
      assertCurrent: () => {
        if (phase === "recording") {
          this.assertActive?.();
          assertOwnerCurrent?.();
        } else if (phase !== "settling") {
          throw new Error("Reef request settlement is not active");
        }
      },
    });
    await applyReefStateBatch(batch, rows, ([value]) => {
      const current = this.#parseState(value);
      return {
        intents: [
          {
            operation: "update",
            action: "set",
            value: {
              ...current,
              outboundRequests: { ...current.outboundRequests, [requestId]: requestedAt },
            },
          },
        ],
        value: undefined,
      };
    });
    phase = "ready";
    const consume = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (phase !== "ready") {
        throw new Error("Reef request settlement was already consumed");
      }
      phase = "settling";
      try {
        return await operation();
      } finally {
        phase = "closed";
      }
    };
    return {
      requestId,
      status: () =>
        consume(async () =>
          reefOutboundRequestStatus(
            this.#parseState((await batch.observeExisting(rows))?.[0]?.value),
            requestId,
          ),
        ),
      remove: () =>
        consume(() =>
          applyReefStateBatch(batch, rows, ([value]) => {
            const next = withoutReefOutboundRequest(this.#parseState(value), requestId);
            return {
              intents: [
                next === undefined ? KEEP : { operation: "update", action: "set", value: next },
              ],
              value: undefined,
            };
          }),
        ),
      close: () => {
        phase = "closed";
      },
    };
  }

  async hasOutboundRequest(peer: string): Promise<boolean> {
    return Object.keys((await this.snapshot(peer)).outboundRequests ?? {}).length > 0;
  }

  async removeOutboundRequest(peer: string, requestId?: string): Promise<boolean> {
    return this.#updatePeer(peer, (current) => withoutReefOutboundRequest(current, requestId));
  }

  prepareOutboundDelivery(peer: string, id: string) {
    const batch = this.stores.peers.createBatch!<unknown>(
      [this.stores.peers, this.stores.deliveries],
      {
        assertCurrent: () => this.assertActive?.(),
      },
    );
    return prepareReefOutboundDelivery(
      batch,
      this.#key(peer),
      this.#deliveryKey(peer, id),
      peer,
      id,
      () => this.assertActive?.(),
    );
  }

  async overdueOutboundDeliveries(
    olderThanMs: number,
    now = Date.now(),
  ): Promise<Array<{ peer: string; id: string; sentAt: number }>> {
    const batch = this.stores.peers.createBatch!<unknown>(
      [this.stores.peers, this.stores.deliveries],
      { assertCurrent: () => this.assertActive?.() },
    );
    const deliveries = await batch.entries(1);
    const peers = new Map(
      this.#list(await batch.entries(0)).map(({ peer, trust }) => [peer, trust]),
    );
    return deliveries
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const parsed = ReefOutboundDeliverySchema.safeParse(entry.value);
        if (
          !parsed.success ||
          parsed.data.rejection ||
          parsed.data.overdueNotifiedAt !== undefined ||
          parsed.data.sentAt === undefined ||
          parsed.data.sentAt + olderThanMs > now
        ) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        return MESSAGE_ID_PATTERN.test(id) &&
          matchesReefPeerIdentity(peers.get(peer), parsed.data.recipient)
          ? [{ peer, id, sentAt: parsed.data.sentAt }]
          : [];
      });
  }

  async markOutboundDeliveryOverdueNotified(peer: string, id: string): Promise<boolean> {
    const notifiedAt = Date.now();
    return this.#updateDelivery(peer, id, (value) => {
      const parsed = ReefOutboundDeliverySchema.safeParse(value);
      return parsed.success && !parsed.data.rejection && parsed.data.overdueNotifiedAt === undefined
        ? { ...parsed.data, overdueNotifiedAt: notifiedAt }
        : undefined;
    });
  }

  readOutboundDelivery(peer: string, id: string) {
    const batch = this.stores.peers.createBatch!<unknown>(
      [this.stores.peers, this.stores.deliveries],
      {
        assertCurrent: () => this.assertActive?.(),
      },
    );
    return readReefOutboundDelivery(batch, this.#key(peer), this.#deliveryKey(peer, id), peer, () =>
      this.assertActive?.(),
    );
  }

  async pendingOutboundRejections(): Promise<ReefDeliveryRejection[]> {
    const batch = this.stores.peers.createBatch!<unknown>(
      [this.stores.peers, this.stores.deliveries],
      { assertCurrent: () => this.assertActive?.() },
    );
    const deliveries = await batch.entries(1);
    const peers = new Map(
      this.#list(await batch.entries(0)).map(({ peer, trust }) => [peer, trust]),
    );
    return deliveries
      .filter((entry) => entry.key.startsWith(this.#prefix))
      .flatMap((entry) => {
        const delivery = ReefOutboundDeliverySchema.parse(entry.value);
        if (!delivery.rejection) {
          return [];
        }
        const separator = entry.key.lastIndexOf(":");
        const peer = requirePeer(entry.key.slice(this.#prefix.length, separator));
        const id = entry.key.slice(separator + 1);
        if (
          !MESSAGE_ID_PATTERN.test(id) ||
          !matchesReefPeerIdentity(peers.get(peer), delivery.recipient)
        ) {
          return [];
        }
        return [
          {
            id,
            peer,
            recovery: createReefRejectionRecovery(
              batch,
              this.#key(peer),
              entry.key,
              peer,
              id,
              delivery.recipient,
              () => this.assertActive?.(),
            ),
            recipient: delivery.recipient,
            ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
            ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
            ...(delivery.rejection.notice ? { reservedNotice: delivery.rejection.notice } : {}),
          },
        ];
      })
      .toSorted((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1));
  }

  async rejectionNoticeState(peer: string): Promise<ReefRejectionNoticeState | undefined> {
    return (await this.snapshot(peer)).rejectionNotice;
  }

  #updatePeer(
    peer: string,
    update: (value: ReefPeerStateSnapshot) => ReefPeerStateSnapshot | undefined,
    assertCurrent?: () => void,
  ): Promise<boolean> {
    return this.#change(
      [{ store: 0, key: this.#key(peer) }],
      ([value]) => {
        const next = update(this.#parseState(value));
        return {
          intents: [
            next === undefined ? KEEP : { operation: "update", action: "set", value: next },
          ],
          value: next !== undefined,
        };
      },
      assertCurrent,
    );
  }

  #updateDelivery(
    peer: string,
    id: string,
    update: (value: unknown) => ReefOutboundDelivery | undefined,
  ): Promise<boolean> {
    return this.#change([{ store: 1, key: this.#deliveryKey(peer, id) }], ([value]) => {
      const next = update(value);
      return {
        intents: [next === undefined ? KEEP : { operation: "update", action: "set", value: next }],
        value: next !== undefined,
      };
    });
  }

  async #change<T>(
    rows: { store: number; key: string }[],
    prepare: (values: unknown[]) => { intents: PluginStateCompareIntent<unknown>[]; value: T },
    assertCurrent?: () => void,
  ): Promise<T> {
    const batch = this.stores.peers.createBatch!<unknown>(
      [this.stores.peers, this.stores.deliveries],
      {
        assertCurrent: () => {
          this.assertActive?.();
          assertCurrent?.();
        },
      },
    );
    return applyReefStateBatch(batch, rows, prepare);
  }

  #key(peer: string): string {
    return `${this.#prefix}${requirePeer(peer)}`;
  }

  #deliveryKey(peer: string, id: string): string {
    if (!MESSAGE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Reef delivery id: ${id}`);
    }
    return `${this.#prefix}${requirePeer(peer)}:${id}`;
  }

  #parseState(value: unknown): ReefPeerStateSnapshot {
    return value === undefined ? { revision: 0 } : ReefPeerStateSchema.parse(value);
  }
}

export function openReefTrustStore(
  runtime: PluginRuntime,
  config: ReefChannelConfig,
  assertCurrent?: () => void,
): ReefTrustStore {
  const stores = openStores(runtime.state.openKeyedStore);
  if (!stores.peers.createBatch) {
    return new LegacyReefTrustStore(runtime, config, assertCurrent);
  }
  const currentPeers = runtime.state.openSyncKeyedStore<ReefPeerStateSnapshot>({
    namespace: REEF_TRUST_STORE_NAMESPACE,
    maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  return new WorkerReefTrustStore(stores, config, currentPeers, assertCurrent);
}
