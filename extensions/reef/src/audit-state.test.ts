import fs from "node:fs";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateBatch,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditEntry, verifyChain, verifyChainSegment } from "../protocol/audit.js";
import {
  openReefAuditStore,
  reefAuditEntryKey,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state.js";
import {
  cleanupStateTestDirectory,
  createRuntime,
  createStateTestDirectory,
} from "./state.test-support.js";

function interceptAuditBatch(
  runtime: ReturnType<typeof createRuntime>,
  transform: <T>(batch: PluginStateBatch<T>) => PluginStateBatch<T>,
) {
  const open = runtime.state.openKeyedStore;
  return vi
    .spyOn(runtime.state, "openKeyedStore")
    .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      if (options.namespace === REEF_AUDIT_HEAD_NAMESPACE && store.createBatch) {
        const createBatch = store.createBatch;
        store.createBatch = <V>(
          stores: readonly Pick<PluginStateKeyedStore<V>, "lookup" | "entries">[],
          authority?: { assertCurrent: () => void },
        ) => transform(createBatch<V>(stores, authority));
      }
      return store;
    });
}

describe("Reef SQLite audit state", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = createStateTestDirectory();
  });

  afterEach(async () => {
    await cleanupStateTestDirectory(stateDir);
  });

  it("revalidates a competing audit append before linking its successor", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = openReefAuditStore(runtime, key, 2);
    await initial.appendEvent("initial", { id: 1 }, 10);
    const competing = openReefAuditStore(runtime, key, 2);
    let interleaved = false;
    interceptAuditBatch(runtime, <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
      return {
        ...batch,
        async observe(rows) {
          const observed = await batch.observe(rows);
          if (!interleaved && rows.some((row) => row.key.startsWith("entry:"))) {
            interleaved = true;
            await competing.appendEvent("winner", { id: 2 }, 11);
          }
          return observed;
        },
      };
    });
    const contender = openReefAuditStore(runtime, key, 2);
    await contender.appendEvent("contender", { id: 3 }, 12);
    const retained = await initial.entries();
    expect(retained.map((entry) => entry.event.type)).toEqual(["winner", "contender"]);
    expect(retained[1]!.prevHash).toBe(retained[0]!.entryHash);
  });

  it("preserves legacy staged cleanup on failure and recovers it atomically", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = await openReefAuditStore(runtime, key, 2).appendEvent("initial", { id: 1 }, 10);
    const stale = createAuditEntry("stalled", { id: 2 }, 11, key, {
      hash: initial.entryHash,
      seq: 1,
    });
    const raw = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: 3,
      overflowPolicy: "reject-new",
    });
    raw.register(reefAuditEntryKey(initial.entryHash), {
      kind: "entry",
      entry: initial,
      nextHash: stale.entryHash,
    });
    raw.register(reefAuditEntryKey(stale.entryHash), { kind: "entry", entry: stale });
    raw.register("entry:orphan", { kind: "entry", entry: stale });
    const heads = runtime.state.openSyncKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    const legacyHead: ReefAuditHeadRecord = {
      kind: "head",
      hash: initial.entryHash,
      seq: 1,
      oldestHash: initial.entryHash,
      pending: {
        owner: "retired-writer",
        expiresAt: 1,
        entryKey: reefAuditEntryKey(stale.entryHash),
      },
      garbageEntryKey: "entry:orphan",
    };
    heads.register(REEF_AUDIT_HEAD_KEY, legacyHead);
    const intercepted = interceptAuditBatch(
      runtime,
      <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
        return {
          ...batch,
          compareAndApply: async () => {
            throw new Error("simulated worker refusal");
          },
        };
      },
    );
    await expect(
      openReefAuditStore(runtime, key, 2).appendEvent("refused", { id: 3 }, 12),
    ).rejects.toThrow("simulated worker refusal");
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)).toEqual(legacyHead);
    expect(raw.lookup(reefAuditEntryKey(stale.entryHash))).toEqual({ kind: "entry", entry: stale });
    intercepted.mockRestore();
    const recovered = openReefAuditStore(runtime, key, 2);
    await recovered.appendEvent("recovered", { id: 4 }, 13);
    expect((await recovered.entries()).map((entry) => entry.event.type)).toEqual([
      "initial",
      "recovered",
    ]);
    expect(raw.lookup(reefAuditEntryKey(stale.entryHash))).toBeUndefined();
    expect(raw.lookup("entry:orphan")).toBeUndefined();
    expect(heads.lookup(REEF_AUDIT_HEAD_KEY)?.pending).toBeUndefined();
  });

  it("appends and reads audit history on a released host without worker batches", async () => {
    const runtime = createRuntime(stateDir);
    const open = runtime.state.openKeyedStore;
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(options);
      delete store.createBatch;
      return store;
    };
    const key = new Uint8Array(32).fill(1);
    const audit = openReefAuditStore(runtime, key, 2);
    await audit.appendEvent("one", {}, 10);
    await audit.appendEvent("two", {}, 11);
    await audit.appendEvent("three", {}, 12);
    const reopened = await openReefAuditStore(runtime, key, 2).entries();
    expect(reopened.map((entry) => entry.event.type)).toEqual(["two", "three"]);
    expect(
      verifyChainSegment(reopened, {
        previousHash: reopened[0]!.prevHash,
        previousSeq: 1,
        head: reopened[1]!.entryHash,
      }),
    ).toBe(true);
    // The retained JSON remains readable when the host gains worker support.
    expect(await openReefAuditStore(createRuntime(stateDir), key, 2).entries()).toEqual(reopened);
  });

  it("appends in invocation order and reopens a verified audit chain without native SQL", async () => {
    const key = new Uint8Array(32).fill(1);
    const observation = observeHostDataSql();
    try {
      const first = openReefAuditStore(createRuntime(stateDir), key);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          first.appendEvent("test", { id: index }, 10 + index),
        ),
      );
      const reopened = await openReefAuditStore(createRuntime(stateDir), key).entries();
      expect(reopened.map((entry) => entry.event.payload)).toEqual(
        Array.from({ length: 20 }, (_, id) => ({ id })),
      );
      expect(verifyChain(reopened)).toBe(true);
      expect(observation.queries).toEqual([]);
    } finally {
      observation.restore();
    }
  });

  it.each([1, 2])("retains a verifiable audit suffix with capacity %s", async (maxEntries) => {
    const store = openReefAuditStore(
      createRuntime(stateDir),
      new Uint8Array(32).fill(1),
      maxEntries,
    );
    await store.appendEvent("one", { id: 1 }, 10);
    await store.appendEvent("two", { id: 2 }, 11);
    await store.appendEvent("three", { id: 3 }, 12);
    const retained = await store.entries();
    expect(retained.map((entry) => entry.event.seq)).toEqual(maxEntries === 1 ? [3] : [2, 3]);
    expect(
      verifyChainSegment(retained, {
        previousHash: retained[0]!.prevHash,
        previousSeq: retained[0]!.event.seq - 1,
        head: retained.at(-1)!.entryHash,
      }),
    ).toBe(true);
  });

  it("keeps a committed audit append when its worker acknowledgement is lost", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const initial = openReefAuditStore(runtime, key, 2);
    await initial.appendEvent("one", { id: 1 }, 10);
    await initial.appendEvent("two", { id: 2 }, 11);
    const intercepted = interceptAuditBatch(
      runtime,
      <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
        return {
          ...batch,
          async compareAndApply(changes) {
            await batch.compareAndApply(changes);
            throw new Error("simulated lost acknowledgement");
          },
        };
      },
    );
    await expect(
      openReefAuditStore(runtime, key, 2).appendEvent("three", { id: 3 }, 12),
    ).rejects.toThrow("simulated lost acknowledgement");
    intercepted.mockRestore();
    const recovered = await initial.entries();
    expect(recovered.map((entry) => entry.event.type)).toEqual(["two", "three"]);
    expect(recovered.map((entry) => entry.event.seq)).toEqual([2, 3]);
  });

  it("refuses audit writes after channel authority is revoked during worker preparation", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const current = openReefAuditStore(runtime, key, 2);
    await current.appendEvent("current", {}, 10);
    const controller = new AbortController();
    interceptAuditBatch(runtime, <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
      return {
        ...batch,
        async compareAndApply(changes) {
          controller.abort(new Error("Reef owner retired"));
          return batch.compareAndApply(changes);
        },
      };
    });
    await expect(
      openReefAuditStore(runtime, key, 2, controller.signal).appendEvent("revoked", {}, 11),
    ).rejects.toThrow("Reef owner retired");
    expect((await current.entries()).map((entry) => entry.event.type)).toEqual(["current"]);
  });

  it("rechecks a foreign audit migration marker before committing prepared rows", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const migration = runtime.state.openKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: 1,
      overflowPolicy: "reject-new",
    });
    let interleaved = false;
    interceptAuditBatch(runtime, <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
      return {
        ...batch,
        async observe(rows) {
          const observed = await batch.observe(rows);
          if (!interleaved && rows.some((row) => row.key.startsWith("entry:"))) {
            interleaved = true;
            await migration.register(REEF_AUDIT_MIGRATION_KEY, { pending: true });
          }
          return observed;
        },
      };
    });
    const audit = openReefAuditStore(runtime, key, 2);
    await expect(audit.appendEvent("refused", {}, 10)).rejects.toThrow(
      "audit migration is incomplete",
    );
    await expect(audit.entries()).rejects.toThrow("audit migration is incomplete");
    await migration.delete(REEF_AUDIT_MIGRATION_KEY);
    expect(await audit.entries()).toEqual([]);
  });

  it("reads empty audit history without creating a state database", async () => {
    const store = openReefAuditStore(createRuntime(stateDir), new Uint8Array(32).fill(1));

    await expect(store.entries()).resolves.toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("retries an audit suffix read when a foreign append changes its retained head", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const current = openReefAuditStore(runtime, key, 1);
    await current.appendEvent("old", {}, 10);
    let lookups = 0;
    interceptAuditBatch(runtime, <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => {
      return {
        ...batch,
        async observeExisting(keys) {
          if (++lookups === 2) {
            await current.appendEvent("new", {}, 11);
          }
          return batch.observeExisting(keys);
        },
      };
    });
    const reader = openReefAuditStore(runtime, key, 1);
    expect((await reader.entries()).map((entry) => entry.event.type)).toEqual(["new"]);
  });

  it("retains the audit read source when environment routing changes between lookups", async () => {
    const runtime = createRuntime(stateDir);
    const key = new Uint8Array(32).fill(1);
    const original = openReefAuditStore(runtime, key, 1);
    await original.appendEvent("original", {}, 10);
    const replacementDir = path.join(stateDir, "replacement");
    await openReefAuditStore(createRuntime(replacementDir), key, 1).appendEvent(
      "replacement",
      {},
      11,
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("reef", { ...options, env });
    interceptAuditBatch(runtime, <T>(batch: PluginStateBatch<T>): PluginStateBatch<T> => ({
      ...batch,
      async observeExisting(keys) {
        const rows = await batch.observeExisting(keys);
        env.OPENCLAW_STATE_DIR = replacementDir;
        return rows;
      },
    }));
    const reader = openReefAuditStore(runtime, key, 1);

    expect((await reader.entries()).map((entry) => entry.event.type)).toEqual(["original"]);
  });
});
