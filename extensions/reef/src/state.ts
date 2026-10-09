import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateCompareIntent,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from defining modules, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { base64url, fromBase64url } from "../protocol/encoding.js";
import { generateIdentity } from "../protocol/identity.js";
import type { ReviewApproval, ReviewRequest } from "../protocol/pipeline.js";
import { openReefAuditStore } from "./audit-state.js";
import {
  parseReefIdentityBinding,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_MAX_ENTRIES,
  type ReefIdentityBinding,
} from "./registration-state.js";
import { ReefSqliteReplayStore, REEF_REPLAY_TTL_MS } from "./replay-store.js";
import {
  parseReefKeys,
  REEF_KEYS_NAMESPACE,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_DURABLE_MIGRATION_KEY,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  type ReefReviewRecord,
  type ReefIdentityMigrationRecord,
  type ReefDurableMigrationRecord,
} from "./state-format.js";
import {
  assertLegacyReefIdentityMigrationComplete,
  generateAndStoreLegacyKeys,
  loadLegacyKeys,
  LegacyReviewApprovalStore,
} from "./state.legacy.js";
import type { ReefKeys } from "./types.js";

export * from "./audit-state.js";
export * from "./registration-state.js";
export * from "./state-format.js";

export const REEF_DELIVERED_NAMESPACE = "delivered";
export const REEF_DELIVERED_MAX_ENTRIES = 5_000;
export const REEF_DELIVERED_TTL_MS = REEF_REPLAY_TTL_MS;
const REEF_INBOX_CURSOR_NAMESPACE = "inbox-cursor";
const REEF_INBOX_CURSOR_KEY = "current";
const REEF_INBOX_CURSOR_MAX_ENTRIES = 1;

function openIdentityState(runtime: PluginRuntime, assertCurrent?: () => void) {
  const stores = [
    runtime.state.openKeyedStore<ReefDurableMigrationRecord>({
      namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
      maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefKeys>({
      namespace: REEF_KEYS_NAMESPACE,
      maxEntries: REEF_KEYS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefIdentityBinding>({
      namespace: REEF_REGISTRATION_NAMESPACE,
      maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  ];
  return stores[0]!.createBatch?.<unknown>(stores, assertCurrent ? { assertCurrent } : undefined);
}

const identityRows = [
  { store: 0, key: REEF_DURABLE_MIGRATION_KEY },
  { store: 1, key: REEF_KEYS_MIGRATION_KEY },
  { store: 2, key: REEF_KEYS_KEY },
  { store: 3, key: REEF_REGISTRATION_IDENTITY_KEY },
];

function assertReefIdentityMigrationComplete(durable: unknown, identity: unknown): void {
  if (durable) {
    throw new Error(
      "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix",
    );
  }
  if (identity) {
    throw new Error(
      "Reef identity migration is incomplete; repair the legacy identity files and rerun openclaw doctor --fix",
    );
  }
}

export async function generateAndStoreKeys(
  runtime: PluginRuntime,
  assertCurrent?: () => void,
): Promise<ReefKeys> {
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent?.();
    return generateAndStoreLegacyKeys(runtime);
  }
  let observations = await state.observe(identityRows);
  const identity = generateIdentity();
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const keys: ReefKeys = {
    ...identity,
    auditKey: base64url(random(32)),
    replayKey: base64url(random(32)),
    keyEpoch: 1,
  };
  for (;;) {
    assertReefIdentityMigrationComplete(observations[0]!.value, observations[1]!.value);
    const binding = parseReefIdentityBinding(observations[3]!.value);
    if (binding) {
      throw new Error(
        `Reef identity @${binding.handle} on ${binding.relayUrl} has no canonical keys; restore the original keys before registration`,
      );
    }
    if (observations[2]!.value !== undefined) {
      throw new Error("Reef keys already exist in plugin state");
    }
    const result = await state.compareAndApply(
      identityRows.map((row, index) => ({
        ...row,
        comparison: observations[index]!.comparison,
        intent:
          index === 2
            ? { operation: "update" as const, action: "set" as const, value: keys }
            : { operation: "delete" as const, action: "keep" as const },
      })),
    );
    if (result.status !== "conflict") {
      return keys;
    }
    observations = result.current;
  }
}

export async function loadKeys(
  runtime: PluginRuntime,
  assertCurrent?: () => void,
): Promise<ReefKeys> {
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent?.();
    return loadLegacyKeys(runtime);
  }
  const observations = await state.observeExisting(identityRows.slice(0, 3));
  assertReefIdentityMigrationComplete(observations?.[0]?.value, observations?.[1]?.value);
  const value = observations?.[2]?.value;
  if (!value) {
    throw Object.assign(new Error("Reef keys are missing from plugin state"), { code: "ENOENT" });
  }
  return parseReefKeys(value);
}

export class ReviewApprovalStore {
  readonly #store: PluginStateKeyedStore<ReefReviewRecord>;
  readonly #maxEntries: number;
  readonly #legacy?: LegacyReviewApprovalStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(
    runtime: PluginRuntime,
    maxEntries = REEF_REVIEWS_MAX_ENTRIES,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#maxEntries = maxEntries;
    const options: OpenKeyedStoreOptions = {
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
    };
    this.#store = runtime.state.openKeyedStore<ReefReviewRecord>(options);
    if (!this.#store.createBatch) {
      this.#legacy = new LegacyReviewApprovalStore(runtime, maxEntries, authoritySignal);
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.authoritySignal?.throwIfAborted();
    const pending = this.#tail.then(work);
    this.#tail = pending.catch(() => {});
    return pending;
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    if (this.#legacy) {
      return this.#legacy.request(review);
    }
    const captured = structuredClone(review);
    const assertCurrent = () => this.authoritySignal?.throwIfAborted();
    const batch = this.#store.createBatch!<ReefReviewRecord>([this.#store], { assertCurrent });
    return this.#enqueue(async () => {
      const key = captured.approvalDigest;
      let [observed] = await batch.observe([{ store: 0, key }]);
      for (;;) {
        if (observed!.value) {
          return observed!.value.approved === undefined
            ? undefined
            : { approved: observed!.value.approved, approvalDigest: key };
        }
        const entries = await batch.entries(0);
        assertCurrent();
        const concurrent = entries.find((entry) => entry.key === key);
        if (concurrent) {
          return concurrent.value.approved === undefined
            ? undefined
            : { approved: concurrent.value.approved, approvalDigest: key };
        }
        const completed =
          entries.length >= this.#maxEntries
            ? entries
                .filter((entry) => entry.value.approved !== undefined)
                .toSorted((left, right) => left.createdAt - right.createdAt)[0]
            : undefined;
        if (entries.length >= this.#maxEntries && !completed) {
          throw new Error("Reef pending review capacity is exhausted");
        }
        const changes = [];
        if (completed) {
          const observations = await batch.observe([
            { store: 0, key },
            { store: 0, key: completed.key },
          ]);
          observed = observations[0]!;
          const candidate = observations[1]!;
          if (observed.value || candidate.value?.approved === undefined) {
            continue;
          }
          changes.push({
            store: 0,
            key: completed.key,
            comparison: candidate.comparison,
            intent: { operation: "delete" as const, action: "delete" as const },
          });
        }
        changes.push({
          store: 0,
          key,
          comparison: observed!.comparison,
          intent: {
            operation: "update" as const,
            action: "set" as const,
            value: { review: captured },
          },
        });
        const result = await batch.compareAndApply(changes);
        if (result.status !== "conflict") {
          return undefined;
        }
        observed = result.current.at(-1)!;
      }
    });
  }

  async lookupDecision(
    approvalDigest: string,
  ): Promise<"none" | "pending" | { approved: boolean }> {
    if (this.#legacy) {
      return this.#legacy.lookupDecision(approvalDigest);
    }
    const batch = this.#store.createBatch!<ReefReviewRecord>([this.#store], {
      assertCurrent: () => this.authoritySignal?.throwIfAborted(),
    });
    return this.#enqueue(async () => {
      this.authoritySignal?.throwIfAborted();
      const observations = await batch.observeExisting([{ store: 0, key: approvalDigest }]);
      const current = observations?.[0]?.value;
      this.authoritySignal?.throwIfAborted();
      if (!current) {
        return "none";
      }
      return current.approved === undefined ? "pending" : { approved: current.approved };
    });
  }

  async decide(
    digest: string,
    approved: boolean,
    assertOwnerCurrent?: () => void,
  ): Promise<ReviewRequest | undefined> {
    if (this.#legacy) {
      return this.#legacy.decide(digest, approved, assertOwnerCurrent);
    }
    const assertCurrent = () => {
      this.authoritySignal?.throwIfAborted();
      assertOwnerCurrent?.();
    };
    const batch = this.#store.createBatch!<ReefReviewRecord>([this.#store], { assertCurrent });
    return this.#enqueue(async () => {
      let [observation] = await batch.observe([{ store: 0, key: digest }]);
      for (;;) {
        const current = observation!.value;
        if (!current) {
          return undefined;
        }
        const result = await batch.compareAndApply([
          {
            store: 0,
            key: digest,
            comparison: observation!.comparison,
            intent: { operation: "update", action: "set", value: { ...current, approved } },
          },
        ]);
        if (result.status !== "conflict") {
          return structuredClone(current.review);
        }
        [observation] = result.current;
      }
    });
  }

  async list(): Promise<ReviewRequest[]> {
    if (this.#legacy) {
      return this.#legacy.list();
    }
    const batch = this.#store.createBatch!<ReefReviewRecord>([this.#store], {
      assertCurrent: () => this.authoritySignal?.throwIfAborted(),
    });
    return this.#enqueue(async () => {
      this.authoritySignal?.throwIfAborted();
      const entries = await batch.entries(0);
      this.authoritySignal?.throwIfAborted();
      return entries
        .filter((entry) => entry.value.approved === undefined)
        .map((entry) => structuredClone(entry.value.review));
    });
  }
}

export class ReefDeliveredStore {
  readonly #delivered: PluginStateKeyedStore<{ id: string }>;

  constructor(runtime: PluginRuntime, maxEntries = REEF_DELIVERED_MAX_ENTRIES) {
    this.#delivered = runtime.state.openKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
      // Relay redelivery is bounded by the same envelope-age contract as replay.
      // Keep markers longer than that window and fail closed at live capacity.
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
  }

  async status(id: string): Promise<"delivered" | undefined> {
    return (await this.#delivered.lookup(id))?.id === id ? "delivered" : undefined;
  }

  async confirm(id: string): Promise<void> {
    const inserted = await this.#delivered.registerIfAbsent(id, { id });
    if (!inserted && (await this.#delivered.lookup(id))?.id !== id) {
      throw new Error("Failed persisting Reef delivered marker");
    }
  }
}

type ReefInboxCursorRecord = ReefIdentityBinding & { cursor: number };

function parseReefInboxCursorRecord(value: unknown): ReefInboxCursorRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<ReefInboxCursorRecord>;
  return typeof record.handle === "string" &&
    record.handle.length > 0 &&
    typeof record.relayUrl === "string" &&
    record.relayUrl.length > 0 &&
    Number.isSafeInteger(record.cursor) &&
    (record.cursor ?? -1) >= 0
    ? { handle: record.handle, relayUrl: record.relayUrl, cursor: record.cursor! }
    : undefined;
}

/** Durable relay progress for the single Reef identity bound to this state DB. */
export class ReefInboxCursorStore {
  readonly #store: PluginStateKeyedStore<ReefInboxCursorRecord>;
  readonly #openLegacy: () => PluginStateSyncKeyedStore<ReefInboxCursorRecord>;
  readonly #binding: ReefIdentityBinding;

  constructor(
    runtime: PluginRuntime,
    binding: ReefIdentityBinding,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#binding = { ...binding };
    const options = {
      namespace: REEF_INBOX_CURSOR_NAMESPACE,
      maxEntries: REEF_INBOX_CURSOR_MAX_ENTRIES,
      overflowPolicy: "reject-new" as const,
    };
    this.#store = runtime.state.openKeyedStore<ReefInboxCursorRecord>(options);
    this.#openLegacy = () => runtime.state.openSyncKeyedStore<ReefInboxCursorRecord>(options);
  }

  async load(): Promise<number> {
    this.authoritySignal?.throwIfAborted();
    const value = await this.#store.lookup(REEF_INBOX_CURSOR_KEY);
    this.authoritySignal?.throwIfAborted();
    if (value === undefined) {
      return 0;
    }
    return this.#requireBoundRecord(value).cursor;
  }

  async advance(cursor: number): Promise<void> {
    this.authoritySignal?.throwIfAborted();
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    const { observe, compareAndApply } = this.#store;
    if (observe && compareAndApply) {
      const batch = this.#store.createBatch?.<ReefInboxCursorRecord>([this.#store], {
        assertCurrent: () => this.authoritySignal?.throwIfAborted(),
      });
      const compare = async (
        comparison: string,
        intent: PluginStateCompareIntent<ReefInboxCursorRecord>,
      ) => {
        if (!batch) {
          return compareAndApply(REEF_INBOX_CURSOR_KEY, comparison, intent);
        }
        const result = await batch.compareAndApply([
          {
            store: 0,
            key: REEF_INBOX_CURSOR_KEY,
            comparison,
            intent,
          },
        ]);
        return result.status === "conflict"
          ? { status: result.status, current: result.current[0]! }
          : result;
      };
      let observation = batch
        ? (await batch.observe([{ store: 0, key: REEF_INBOX_CURSOR_KEY }]))[0]!
        : await observe(REEF_INBOX_CURSOR_KEY);
      for (;;) {
        let existing: ReefInboxCursorRecord | undefined;
        try {
          existing =
            observation.value === undefined
              ? undefined
              : this.#requireBoundRecord(observation.value);
        } catch (error) {
          // Refuse only a still-current invalid row; a concurrent repair must
          // be revalidated before publishing the observed domain error.
          const result = await compare(observation.comparison, {
            operation: batch ? "delete" : "update",
            action: "keep",
          });
          if (result.status !== "conflict") {
            throw error;
          }
          observation = result.current;
          continue;
        }
        const value = existing
          ? cursor > existing.cursor
            ? { ...existing, cursor }
            : existing
          : { ...this.#binding, cursor };
        const result = await compare(observation.comparison, {
          operation: "update",
          action: "set",
          value,
        });
        if (result.status !== "conflict") {
          break;
        }
        observation = result.current;
      }
      if (!batch) {
        const persisted = await this.#store.lookup(REEF_INBOX_CURSOR_KEY);
        if (!persisted || this.#requireBoundRecord(persisted).cursor < cursor) {
          throw new Error("failed persisting Reef inbox cursor");
        }
      }
      return;
    }
    // Older supported hosts keep the original atomic update. Select this path
    // before awaiting; worker failures must never retry through native storage.
    const store = this.#openLegacy();
    const update = store.update;
    if (!update) {
      throw new Error("Reef inbox cursor requires atomic plugin-state updates");
    }
    update(REEF_INBOX_CURSOR_KEY, (current) => {
      if (current === undefined) {
        return { ...this.#binding, cursor };
      }
      const existing = this.#requireBoundRecord(current);
      return cursor > existing.cursor ? { ...existing, cursor } : existing;
    });
    const persisted = store.lookup(REEF_INBOX_CURSOR_KEY);
    if (!persisted || this.#requireBoundRecord(persisted).cursor < cursor) {
      throw new Error("failed persisting Reef inbox cursor");
    }
  }

  #requireBoundRecord(value: unknown): ReefInboxCursorRecord {
    const record = parseReefInboxCursorRecord(value);
    if (!record) {
      throw new Error("invalid Reef inbox cursor state");
    }
    if (record.handle !== this.#binding.handle || record.relayUrl !== this.#binding.relayUrl) {
      throw new Error("Reef inbox cursor belongs to a different identity");
    }
    return record;
  }
}

export async function openStores(
  runtime: PluginRuntime,
  keys: ReefKeys,
  options: {
    auditMaxEntries?: number;
    replayMaxEntries?: number;
    deliveredMaxEntries?: number;
    authoritySignal?: AbortSignal;
  } = {},
) {
  const { authoritySignal } = options;
  const assertCurrent = () => authoritySignal?.throwIfAborted();
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent();
    assertLegacyReefIdentityMigrationComplete(runtime);
  }
  const stores = {
    audit: openReefAuditStore(
      runtime,
      fromBase64url(keys.auditKey),
      options.auditMaxEntries,
      options.authoritySignal,
    ),
    replay: new ReefSqliteReplayStore(
      runtime,
      fromBase64url(keys.replayKey),
      randomBytes,
      options.replayMaxEntries,
    ),
    reviews: new ReviewApprovalStore(runtime, undefined, options.authoritySignal),
    delivered: new ReefDeliveredStore(runtime, options.deliveredMaxEntries),
  };
  if (state) {
    const observations = await state.observeExisting(identityRows.slice(0, 2));
    assertReefIdentityMigrationComplete(observations?.[0]?.value, observations?.[1]?.value);
  }
  return stores;
}
