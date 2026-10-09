import { copyFileSync, existsSync, renameSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentFacts } from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import * as sqlite from "../infra/node-sqlite.js";
import { runSqlitePinnedReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import * as mutationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "./plugin-state-store.js";
import type { PluginStateCompareIntent } from "./plugin-state-store.types.js";
import * as workerClient from "./plugin-state-worker-client.js";

describe("plugin state cross-namespace batches", () => {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "plugin-state-batch" });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    await state.cleanup();
  });

  const open = (namespace: string, maxEntries = 10) =>
    createPluginStateKeyedStore<string>("batch-test", {
      namespace,
      maxEntries,
      overflowPolicy: "reject-new",
      env: state.env,
    });

  it("keeps a missing source absent during batch reads", async () => {
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.path("missing-read-source") };
    const first = createPluginStateKeyedStore<string>("batch-test", {
      namespace: "absent-first",
      maxEntries: 10,
      env,
    });
    const second = createPluginStateKeyedStore<string>("batch-test", {
      namespace: "absent-second",
      maxEntries: 10,
      env,
    });
    const batch = first.createBatch([first, second]);
    const path = resolveOpenClawStateSqlitePath(env);
    expect(existsSync(path)).toBe(false);
    expect(
      await batch.observeExisting([
        { store: 1, key: "second" },
        { store: 0, key: "first" },
      ]),
    ).toBeUndefined();
    expect(await batch.entries(0)).toEqual([]);
    batch.assertCurrentValue({ store: 0, key: "missing" }, (value) => {
      expect(value).toBeUndefined();
    });
    expect(existsSync(path)).toBe(false);
  });

  it("compares every namespace before writing and observes a foreign commit", async () => {
    const first = open("atomic-first");
    const second = open("atomic-second");
    await first.register("same-key", "first");
    await second.register("same-key", "second");
    const batch = first.createBatch([first, second]);
    const keys = [
      { store: 0, key: "same-key" },
      { store: 1, key: "same-key" },
    ];
    const observed = await batch.observeExisting(keys);
    expect(observed?.map(({ value }) => value)).toEqual(["first", "second"]);
    expect(await batch.observeExisting([{ store: 0, key: "missing" }])).toEqual([
      { value: undefined, comparison: expect.any(String) },
    ]);
    // This native connection is foreign to the retained worker connection.
    createPluginStateSyncKeyedStore<string>("batch-test", {
      namespace: "atomic-second",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env: state.env,
    }).register("same-key", "foreign");
    const hostSql = observeHostDataSql();
    try {
      expect((await batch.observeExisting(keys))?.map(({ value }) => value)).toEqual([
        "first",
        "foreign",
      ]);
      const conflict = await batch.compareAndApply(
        keys.map((key, index) => ({
          store: key.store,
          key: key.key,
          comparison: observed![index]!.comparison,
          intent: { operation: "update", action: "set", value: "candidate" },
        })),
      );
      expect(conflict).toMatchObject({
        status: "conflict",
        current: [{ value: "first" }, { value: "foreign" }],
      });
      expect(await first.lookup("same-key")).toBe("first");
      const current = await batch.observeExisting(keys);
      expect(current?.map((entry) => entry.value)).toEqual(["first", "foreign"]);
      expect(
        await batch.compareAndApply(
          keys.map((key, index) => ({
            store: key.store,
            key: key.key,
            comparison: current![index]!.comparison,
            intent: { operation: "update", action: "set", value: "committed" },
          })),
        ),
      ).toEqual({ status: "applied" });
      expect(await first.lookup("same-key")).toBe("committed");
      expect(await second.lookup("same-key")).toBe("committed");
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      hostSql.restore();
    }
  });

  it("rolls back earlier deletes on capacity failure and applies ordered replacement atomically", async () => {
    const store = open("capacity", 1);
    await store.register("old", "original");
    const batch = store.createBatch([store]);
    const keys = ["old", "new", "overflow"].map((key) => ({ store: 0, key }));
    const observed = await batch.observe(keys);
    const changes = keys.map((key, index) => ({
      store: key.store,
      key: key.key,
      comparison: observed[index]!.comparison,
      intent:
        index === 0
          ? ({ operation: "delete", action: "delete" } as const)
          : ({ operation: "update", action: "set", value: key.key } as const),
    }));
    await expect(batch.compareAndApply(changes)).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    expect((await store.entries()).map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "old", value: "original" },
    ]);
    expect(await batch.compareAndApply(changes.slice(0, 2))).toEqual({ status: "applied" });
    expect((await store.entries()).map(({ key, value }) => ({ key, value }))).toEqual([
      { key: "new", value: "new" },
    ]);
  });

  it.each(["transaction", "commit"] as const)(
    "preserves each bound store's authority at %s admission",
    async (stage) => {
      const first = open(`authority-first-${stage}`);
      const second = open(`authority-second-${stage}`);
      await first.register("key", "first");
      await second.register("key", "second");
      let current = true;
      let denied = false;
      const guarded = second.withCurrent({
        assertCurrent() {
          if (!current) {
            denied = true;
            throw new Error("batch action retired");
          }
        },
      });
      const batch = first.createBatch([first, guarded]);
      const keys = [
        { store: 0, key: "key" },
        { store: 1, key: "key" },
      ];
      const observed = await batch.observe(keys);
      const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
      vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === stage) {
              current = false;
            }
            admit(request, grant);
          }, attachment),
      );
      await expect(
        batch.compareAndApply(
          keys.map((key, index) => ({
            store: key.store,
            key: key.key,
            comparison: observed[index]!.comparison,
            intent: { operation: "update", action: "set", value: "forbidden" },
          })),
        ),
      ).rejects.toMatchObject({
        code: "PLUGIN_STATE_WRITE_FAILED",
        operation: "register",
        cause: { name: "SqliteWorkerError", code: "closed" },
      });
      expect(current).toBe(false);
      expect(denied).toBe(true);
      expect(await first.lookup("key")).toBe("first");
      expect(await second.lookup("key")).toBe("second");
    },
  );

  it("does not disclose observations after batch authority closes at commit", async () => {
    const store = open("read-authority");
    await store.register("key", "private");
    let current = true;
    const batch = store.createBatch([store], {
      assertCurrent() {
        if (!current) {
          throw new Error("batch reader retired");
        }
      },
    });
    const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          admit(request, grant);
          if (request.stage === "commit") {
            current = false;
          }
        }, attachment),
    );
    await expect(batch.observe([{ store: 0, key: "key" }])).rejects.toMatchObject({
      cause: { message: "batch reader retired" },
    });
    expect(current).toBe(false);
  });

  it("keeps a retained factory and its batches bound to the creating action", async () => {
    const store = open("factory-authority");
    let current = true;
    const guarded = store.withCurrent({
      assertCurrent() {
        if (!current) {
          throw new Error("creating action retired");
        }
      },
    });
    const createBatch = guarded.createBatch!;
    const batch = createBatch([store]);
    current = false;
    expect(() => createBatch([store])).toThrow("creating action retired");
    await expect(batch.observe([{ store: 0, key: "key" }])).rejects.toThrow(
      "creating action retired",
    );
    const assertion = vi.fn();
    expect(() => batch.assertCurrentValue({ store: 0, key: "key" }, assertion)).toThrow(
      "creating action retired",
    );
    expect(assertion).not.toHaveBeenCalled();
  });

  it("rechecks action authority before returning read-only batch observations", async () => {
    const store = open("lookup-authority");
    await store.register("key", "private");
    let current = true;
    const guarded = store.withCurrent({
      assertCurrent() {
        if (!current) {
          throw new Error("batch reader retired");
        }
      },
    });
    const batch = guarded.createBatch!([store]);
    const observe = workerClient.observeExistingPluginStateBatchInWorker;
    vi.spyOn(workerClient, "observeExistingPluginStateBatchInWorker").mockImplementation(
      async (params) => {
        const values = await observe(params);
        current = false;
        return values;
      },
    );
    await expect(batch.observeExisting([{ store: 0, key: "key" }])).rejects.toThrow(
      "batch reader retired",
    );
    expect(current).toBe(false);
  });

  it("carries a later store's session restriction into the shared transaction", async () => {
    const target = { agentId: "main", sessionKey: "agent:main:batch", env: state.env };
    const entry = { sessionId: "batch-session", updatedAt: 1, lifecycleRevision: "original" };
    await upsertSessionEntryCore(target, entry);
    const read = await withSessionEntryReadOnlyInWorker(
      target,
      () => {},
      async (result, owner) => {
        if (!result.ok) {
          throw result.error;
        }
        return captureSessionEntryCurrentRead(target, owner);
      },
    );
    if (!read.source) {
      throw new Error("Expected a file-backed session");
    }
    const first = open("session-first");
    const second = open("session-second");
    const facts: Array<SessionEntryCurrentFacts | undefined> = [];
    const guarded = second.withCurrent({
      assertCurrent: read.assertSourceCurrent,
      sessionEntryCurrent: {
        source: read.source,
        assertCurrent(current: SessionEntryCurrentFacts | undefined) {
          facts.push(current);
          if (current?.lifecycleRevision !== "original") {
            throw new Error("session claim changed");
          }
        },
      },
    });
    const batch = first.createBatch([first, guarded]);
    const keys = [
      { store: 0, key: "claim" },
      { store: 1, key: "claim" },
    ];
    const finalAssertion = vi.fn();
    expect(() => batch.assertCurrentValue(keys[0]!, finalAssertion)).toThrow("session-restricted");
    expect(finalAssertion).not.toHaveBeenCalled();
    const observed = await batch.observe(keys);
    await upsertSessionEntryCore(target, { ...entry, lifecycleRevision: "successor" });
    await expect(
      batch.compareAndApply(
        keys.map((key, index) => ({
          store: key.store,
          key: key.key,
          comparison: observed[index]!.comparison,
          intent: { operation: "update", action: "set", value: "forbidden" },
        })),
      ),
    ).rejects.toMatchObject({
      code: "PLUGIN_STATE_WRITE_FAILED",
      operation: "register",
      cause: { name: "SqliteWorkerError", code: "closed" },
    });
    expect(facts).toContainEqual(expect.objectContaining({ lifecycleRevision: "successor" }));
    expect(await first.lookup("claim")).toBeUndefined();
    expect(await second.lookup("claim")).toBeUndefined();
  });

  it("requires minted same-source handles and unique storage keys", async () => {
    const store = open("validation");
    expect(() => store.createBatch([{ ...store }])).toThrow("host-owned");
    const sync = createPluginStateSyncKeyedStore("batch-test", {
      namespace: "validation",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env: state.env,
    });
    expect(() => Reflect.apply(store.createBatch, undefined, [[sync]])).toThrow("host-owned");
    expect(() =>
      store.createBatch([
        store,
        createPluginStateKeyedStore("other-plugin", {
          namespace: "validation",
          maxEntries: 10,
          env: state.env,
        }),
      ]),
    ).toThrow("one plugin");
    expect(() =>
      store.createBatch([
        store,
        createPluginStateKeyedStore("batch-test", {
          namespace: "validation",
          maxEntries: 10,
          overflowPolicy: "reject-new",
          env: { ...state.env, OPENCLAW_STATE_DIR: state.path("other-state") },
        }),
      ]),
    ).toThrow("one physical state source");
    const batch = store.createBatch([store, store]);
    await expect(
      batch.observe([
        { store: 0, key: "same" },
        { store: 1, key: "same" },
      ]),
    ).rejects.toThrow("unique");
    await expect(
      batch.observe([
        { store: 0, key: "\ud800" },
        { store: 1, key: "\ufffd" },
      ]),
    ).rejects.toThrow("unique");
    await expect(batch.observe([{ store: 2, key: "key" }])).rejects.toThrow("unknown store");
    await expect(
      batch.observe(Array.from({ length: 10_001 }, (_, key) => ({ store: 0, key: String(key) }))),
    ).rejects.toThrow("at most 10000");
  });

  it("ignores extra intent scope fields instead of bypassing an omitted store's authority", async () => {
    const permitted = open("intent-permitted");
    const restricted = open("intent-restricted");
    await restricted.register("private", "protected");
    let current = true;
    const guarded = restricted.withCurrent({
      assertCurrent() {
        if (!current) {
          throw new Error("restricted action retired");
        }
      },
    });
    const prior = await guarded.observe("private");
    current = false;
    await expect(guarded.observe("private")).rejects.toThrow("restricted action retired");
    const batch = permitted.createBatch([permitted]);
    const [allowed] = await batch.observe([{ store: 0, key: "missing" }]);
    const injected = {
      pluginId: "batch-test",
      namespace: "intent-restricted",
      key: "private",
      comparison: prior.comparison,
      maxEntries: 100,
      overflowPolicy: "evict-oldest",
    };
    const deleting = {
      ...injected,
      operation: "delete",
      action: "delete",
    } satisfies PluginStateCompareIntent<unknown>;
    await expect(
      batch.compareAndApply([
        {
          store: 0,
          key: "missing",
          comparison: allowed!.comparison,
          intent: deleting,
        },
      ]),
    ).resolves.toEqual({ status: "unchanged" });
    expect(await restricted.lookup("private")).toBe("protected");

    await restricted.register("private", "private successor");
    const keeping = {
      ...injected,
      operation: "delete",
      action: "keep",
    } satisfies PluginStateCompareIntent<unknown>;
    await expect(
      batch.compareAndApply([
        {
          store: 0,
          key: "missing",
          comparison: allowed!.comparison,
          intent: keeping,
        },
      ]),
    ).resolves.toEqual({ status: "unchanged" });
    expect(await restricted.lookup("private")).toBe("private successor");
  });

  it("keeps the captured physical target when store environment changes during planning", async () => {
    const env = { ...state.env };
    const store = createPluginStateKeyedStore<string>("batch-test", {
      namespace: "captured-source",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env,
    });
    await store.register("key", "original");
    const batch = store.createBatch([store]);
    env.OPENCLAW_STATE_DIR = state.path("redirected-state");
    await store.register("key", "redirected source");
    const observed = (await batch.observeExisting([{ store: 0, key: "key" }]))?.[0];
    expect(observed?.value).toBe("original");
    expect(await batch.entries(0)).toEqual([
      expect.objectContaining({ key: "key", value: "original" }),
    ]);
    expect(
      await batch.compareAndApply([
        {
          store: 0,
          key: "key",
          comparison: observed!.comparison,
          intent: { operation: "update", action: "set", value: "same source" },
        },
      ]),
    ).toEqual({ status: "applied" });
    expect(await open("captured-source").lookup("key")).toBe("same source");
    batch.assertCurrentValue({ store: 0, key: "key" }, (value) => {
      expect(value).toBe("same source");
    });
    expect(await store.lookup("key")).toBe("redirected source");
  });

  it("checks current final authority outside an inherited native snapshot", async () => {
    await closeOpenClawStateDatabaseAsync();
    const options = {
      namespace: "final-pinned",
      maxEntries: 10,
      overflowPolicy: "reject-new" as const,
      env: state.env,
    };
    const writer = createPluginStateSyncKeyedStore<string>("batch-test", options);
    writer.register("key", "allowed");
    const store = createPluginStateKeyedStore<string>("batch-test", options);
    const batch = store.createBatch([store]);
    const database = openOpenClawStateDatabase({ env: state.env });
    const foreign = sqlite.openNodeSqliteDatabase(database.path);
    try {
      runSqlitePinnedReadSnapshotSync(database.db, () => {
        expect(writer.lookup("key")).toBe("allowed");
        foreign
          .prepare(
            "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
          )
          .run('"revoked"', "batch-test", options.namespace, "key");
        expect(writer.lookup("key")).toBe("allowed");
        const effect = vi.fn();
        expect(() => {
          batch.assertCurrentValue({ store: 0, key: "key" }, (value) => {
            if (value !== "allowed") {
              throw new Error("current authority revoked");
            }
          });
          effect();
        }).toThrow("current authority revoked");
        expect(effect).not.toHaveBeenCalled();
      });
    } finally {
      foreign.close();
    }
  });

  it("refuses final authority after physical source replacement", async () => {
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.path("final-source") };
    const replacementEnv = { ...state.env, OPENCLAW_STATE_DIR: state.path("final-replacement") };
    const options = { namespace: "final-replacement", maxEntries: 10 };
    const original = createPluginStateKeyedStore<string>("batch-test", { ...options, env });
    const replacement = createPluginStateKeyedStore<string>("batch-test", {
      ...options,
      env: replacementEnv,
    });
    await original.register("key", "allowed");
    await replacement.register("key", "allowed");
    await closeOpenClawStateDatabaseAsync();
    const batch = original.createBatch([original]);
    const pathname = resolveOpenClawStateSqlitePath(env);
    renameSync(pathname, `${pathname}.original`);
    copyFileSync(resolveOpenClawStateSqlitePath(replacementEnv), pathname);
    const assertion = vi.fn();
    expect(() => batch.assertCurrentValue({ store: 0, key: "key" }, assertion)).toThrow(
      "identity changed",
    );
    expect(assertion).not.toHaveBeenCalled();
  });

  it("reuses final guard admission without a host writer and sees foreign revocation", async () => {
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.path("final-worker-only") };
    const store = createPluginStateKeyedStore<string>("batch-test", {
      namespace: "worker-only-guard",
      maxEntries: 10,
      env,
    });
    await store.register("key", "allowed");
    const pathname = resolveOpenClawStateSqlitePath(env);
    expect(isOpenClawStateDatabaseOpen(pathname)).toBe(false);
    const batch = store.createBatch([store]);
    const check = () =>
      batch.assertCurrentValue({ store: 0, key: "key" }, (value) => {
        if (value !== "allowed") {
          throw new Error("worker-only authority revoked");
        }
      });
    check();
    const opens = vi.spyOn(sqlite, "openNodeSqliteDatabase");
    const observed = observeSqliteReadSql(sqlite.requireNodeSqlite().StatementSync.prototype);
    try {
      for (let index = 0; index < 3; index++) {
        check();
      }
      expect(opens).not.toHaveBeenCalled();
      expect(
        observed.queries.filter((sql) => /from "plugin_state_entries"/iu.test(sql)),
      ).toHaveLength(3);
      expect(
        observed.queries.filter((sql) =>
          /\b(?:sqlite_schema|sqlite_master)\b|^PRAGMA\s+(?:schema_version|user_version|query_only|trusted_schema|busy_timeout)\b/iu.test(
            sql,
          ),
        ),
      ).toEqual([]);
    } finally {
      observed.restore();
      opens.mockRestore();
    }
    const foreign = sqlite.openNodeSqliteDatabase(pathname);
    try {
      foreign
        .prepare(
          "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
        )
        .run('"revoked"', "batch-test", "worker-only-guard", "key");
      expect(check).toThrow("worker-only authority revoked");
    } finally {
      foreign.close();
    }
    expect(isOpenClawStateDatabaseOpen(pathname)).toBe(false);
  });

  it("rejects authority closure during a final assertion and asynchronous assertions", async () => {
    const store = open("final-assertion-lifetime");
    await store.register("key", "allowed");
    let current = true;
    const batch = store.createBatch([store], {
      assertCurrent() {
        if (!current) {
          throw new Error("final assertion owner closed");
        }
      },
    });
    const effect = vi.fn();
    expect(() => {
      batch.assertCurrentValue({ store: 0, key: "key" }, () => {
        current = false;
      });
      effect();
    }).toThrow("final assertion owner closed");
    expect(effect).not.toHaveBeenCalled();
    const unbound = store.createBatch([store]);
    expect(() => unbound.assertCurrentValue({ store: 0, key: "key" }, async () => {})).toThrow(
      "must remain synchronous",
    );
  });
});
