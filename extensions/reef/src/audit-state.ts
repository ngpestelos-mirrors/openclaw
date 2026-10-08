import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateBatch,
  PluginStateBatchChange,
  PluginStateCompareIntent,
  PluginStateKeyedStore,
  PluginStateObservation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from the defining module, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import {
  createAuditEntry,
  verifyChainSegment,
  type AuditEntry,
  type AuditStore,
} from "../protocol/audit.js";
import {
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_APPEND_RETRY_MS,
  REEF_AUDIT_APPEND_ATTEMPTS,
  parseReefAuditHead,
  parseAuditEntryRecord,
  parseAuditStateRecord,
  reefAuditEntryKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";
import { ReefLegacySqliteAuditStore } from "./audit-state.legacy.js";

export {
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  parseReefAuditHead,
  reefAuditEntryKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";

const HEAD_STORE = 0;
const MIGRATION_STORE = 1;
const ENTRY_STORE = 2;
const HEAD_ROWS = [
  { store: HEAD_STORE, key: REEF_AUDIT_HEAD_KEY },
  { store: MIGRATION_STORE, key: REEF_AUDIT_MIGRATION_KEY },
];

class ReefSqliteAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #maxEntries: number;
  readonly #batch: PluginStateBatch;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    runtime: PluginRuntime,
    auditKey: Uint8Array,
    head: PluginStateKeyedStore<ReefAuditHeadRecord>,
    rng: (length: number) => Uint8Array = randomBytes,
    maxEntries = REEF_AUDIT_MAX_ENTRIES,
    authoritySignal?: AbortSignal,
  ) {
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
    this.#maxEntries = maxEntries;
    const migration = runtime.state.openKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const entries = runtime.state.openKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: maxEntries + 1,
      overflowPolicy: "reject-new",
    });
    this.#batch = head.createBatch!<unknown>([head, migration, entries], {
      assertCurrent: () => authoritySignal?.throwIfAborted(),
    });
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    const capturedPayload = structuredClone(payload);
    return this.#enqueue(() => this.#appendEvent(type, capturedPayload, ts));
  }

  async #observeHead(): Promise<{
    head: ReefAuditHeadRecord;
    changes: PluginStateBatchChange<unknown>[];
  }> {
    const observations = await this.#batch.observe(HEAD_ROWS);
    if (observations[1]!.value !== undefined) {
      throw new Error(
        "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix",
      );
    }
    return {
      head: parseReefAuditHead(observations[0]!.value),
      changes: HEAD_ROWS.map((row, index) => ({
        ...row,
        comparison: observations[index]!.comparison,
        intent: { operation: "delete", action: "keep" },
      })),
    };
  }

  async #appendEvent(type: string, payload: unknown, ts: number): Promise<AuditEntry> {
    for (let attempt = 0; attempt < REEF_AUDIT_APPEND_ATTEMPTS; attempt++) {
      const { head, changes } = await this.#observeHead();
      if (head.pending && head.pending.expiresAt > Date.now()) {
        await sleep(REEF_AUDIT_APPEND_RETRY_MS);
        continue;
      }
      const staleEntryKey = head.pending?.entryKey;
      if (
        staleEntryKey &&
        (!staleEntryKey.startsWith("entry:") || staleEntryKey.length === "entry:".length)
      ) {
        throw new Error("invalid Reef audit staged entry key");
      }
      const entry = createAuditEntry(type, payload, ts, this.#auditKey, head, this.#rng);
      const entryKey = reefAuditEntryKey(entry.entryHash);
      const previousKey = head.hash ? reefAuditEntryKey(head.hash) : undefined;
      const oldestKey =
        head.seq >= this.#maxEntries ? reefAuditEntryKey(head.oldestHash) : undefined;
      const keys = [
        ...new Set(
          [staleEntryKey, head.garbageEntryKey, previousKey, oldestKey, entryKey].filter(
            (key): key is string => key !== undefined,
          ),
        ),
      ];
      const observed = await this.#batch.observe(keys.map((key) => ({ store: ENTRY_STORE, key })));
      const rows = new Map<string, PluginStateObservation<unknown>>(
        keys.map((key, index) => [key, observed[index]!]),
      );
      const intents = new Map<string, PluginStateCompareIntent<unknown>>();
      let preparationError: unknown;
      try {
        // Old writers may leave a staged append or a committed retention orphan.
        // Their cleanup joins the new append so failure cannot shorten the chain.
        for (const key of [staleEntryKey, head.garbageEntryKey]) {
          if (key) {
            intents.set(key, { operation: "delete", action: "delete" });
          }
        }
        if (rows.get(entryKey)!.value !== undefined && !intents.has(entryKey)) {
          throw new Error("Reef audit entry already exists before head advancement");
        }
        if (previousKey) {
          const previous = parseAuditStateRecord(rows.get(previousKey)!.value);
          if (previous.entry.entryHash !== head.hash) {
            throw new Error("Reef audit head entry differs before linking append");
          }
          if (
            previous.nextHash !== undefined &&
            reefAuditEntryKey(previous.nextHash) !== staleEntryKey
          ) {
            throw new Error("Reef audit head already links a committed successor");
          }
          intents.set(previousKey, {
            operation: "update",
            action: "set",
            value: { ...previous, nextHash: entry.entryHash },
          });
        }
        let oldestHash = head.seq === 0 ? entry.entryHash : head.oldestHash;
        if (oldestKey) {
          const oldest = parseAuditStateRecord(rows.get(oldestKey)!.value);
          const nextHash = oldestKey === previousKey ? entry.entryHash : oldest.nextHash;
          if (!nextHash) {
            throw new Error("Reef audit retention pointer is missing");
          }
          oldestHash = nextHash;
          intents.set(oldestKey, { operation: "delete", action: "delete" });
        }
        intents.set(entryKey, {
          operation: "update",
          action: "set",
          value: { kind: "entry", entry },
        });
        changes[0]!.intent = {
          operation: "update",
          action: "set",
          value: { kind: "head", hash: entry.entryHash, seq: entry.event.seq, oldestHash },
        };
      } catch (error) {
        preparationError = error;
      }
      for (const [key, row] of rows) {
        changes.push({
          store: ENTRY_STORE,
          key,
          comparison: row.comparison,
          intent:
            preparationError === undefined
              ? (intents.get(key) ?? { operation: "delete", action: "keep" })
              : { operation: "delete", action: "keep" },
        });
      }
      if (preparationError !== undefined) {
        changes[0]!.intent = { operation: "delete", action: "keep" };
      }
      const result = await this.#batch.compareAndApply(changes);
      if (result.status === "conflict") {
        continue;
      }
      if (preparationError !== undefined) {
        throw preparationError;
      }
      // An unknown commit outcome propagates directly; never compensate or replay it.
      return structuredClone(entry);
    }
    throw new Error("Reef audit append contention exceeded retry budget");
  }

  async entries(): Promise<AuditEntry[]> {
    return this.#enqueue(async () => {
      for (let attempt = 0; attempt < REEF_AUDIT_APPEND_ATTEMPTS; attempt++) {
        const observed = await this.#batch.observeExisting(HEAD_ROWS);
        if (!observed) {
          return [];
        }
        if (observed[1]!.value !== undefined) {
          throw new Error(
            "Reef audit migration is incomplete; repair audit.jsonl and rerun openclaw doctor --fix",
          );
        }
        const head = parseReefAuditHead(observed[0]!.value);
        if (head.seq === 0) {
          return [];
        }
        const rows = await this.#batch.entries(ENTRY_STORE);
        const current = await this.#batch.observeExisting(HEAD_ROWS);
        if (!isDeepStrictEqual(observed, current)) {
          continue;
        }
        const byKey = new Map(rows.map((row) => [row.key, row.value]));
        const reversed: AuditEntry[] = [];
        let hash = head.hash;
        for (let seq = head.seq; seq > 0 && reversed.length < this.#maxEntries; seq--) {
          const record = byKey.get(reefAuditEntryKey(hash));
          if (!record) {
            break;
          }
          const entry = parseAuditEntryRecord(record);
          if (entry.entryHash !== hash || entry.event.seq !== seq) {
            throw new Error("invalid Reef audit chain state");
          }
          reversed.push(entry);
          hash = entry.prevHash;
        }
        const expectedEntries = Math.min(head.seq, this.#maxEntries);
        if (reversed.length !== expectedEntries) {
          throw new Error("Reef audit chain is shorter than its committed retention window");
        }
        const entries = reversed.toReversed();
        const first = entries[0];
        if (
          !first ||
          !verifyChainSegment(entries, {
            previousHash: first.prevHash,
            previousSeq: first.event.seq - 1,
            head: head.hash,
          })
        ) {
          throw new Error("invalid Reef audit chain state");
        }
        return structuredClone(entries);
      }
      throw new Error("Reef audit read contention exceeded retry budget");
    });
  }
}

export function openReefAuditStore(
  runtime: PluginRuntime,
  auditKey: Uint8Array,
  maxEntries?: number,
  authoritySignal?: AbortSignal,
): AuditStore {
  const head = runtime.state.openKeyedStore<ReefAuditHeadRecord>({
    namespace: REEF_AUDIT_HEAD_NAMESPACE,
    maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  // Reef supports released hosts predating worker batches. Retire this adapter
  // with the next approved minimum-host increase; worker errors never select it.
  if (!head.createBatch) {
    return new ReefLegacySqliteAuditStore(runtime, auditKey, randomBytes, maxEntries);
  }
  return new ReefSqliteAuditStore(
    runtime,
    auditKey,
    head,
    randomBytes,
    maxEntries,
    authoritySignal,
  );
}
