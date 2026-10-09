import { DatabaseSync } from "node:sqlite";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReefInboxCursorStore } from "./state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const binding = { handle: "molty", relayUrl: "https://reefwire.ai" };
const options = { namespace: "inbox-cursor", maxEntries: 1, overflowPolicy: "reject-new" as const };
type CursorHost = "batch" | "comparison" | "native";

describe("Reef inbox cursor persistence", () => {
  let stateDir: string;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = tempDirs.make("reef-inbox-cursor-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  function createRuntime(host: CursorHost = "batch") {
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStore = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store: PluginStateKeyedStore<T> = createPluginStateKeyedStoreForTests<T>("reef", {
        ...storeOptions,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      if (host !== "batch") {
        delete store.createBatch;
      }
      if (host === "native") {
        delete store.observe;
        delete store.compareAndApply;
      }
      return store;
    };
    runtime.state.openSyncKeyedStore = <T>(storeOptions: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...storeOptions,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    return runtime;
  }

  function beforeFirstComparison(
    runtime: ReturnType<typeof createRuntime>,
    change: () => Promise<void>,
  ) {
    const open = runtime.state.openKeyedStore;
    let changed = false;
    const beforeComparison = async () => {
      if (!changed) {
        changed = true;
        await change();
      }
    };
    runtime.state.openKeyedStore = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
      const store = open<T>(storeOptions);
      const createBatch = store.createBatch;
      if (createBatch) {
        store.createBatch = (stores, authority) => {
          const batch = createBatch(stores, authority);
          return {
            ...batch,
            async compareAndApply(changes) {
              await beforeComparison();
              return batch.compareAndApply(changes);
            },
          };
        };
      } else {
        const intercept = (target: Pick<PluginStateKeyedStore<T>, "compareAndApply">) => {
          const compareAndApply = target.compareAndApply!;
          target.compareAndApply = async (...args) => {
            await beforeComparison();
            return compareAndApply.call(target, ...args);
          };
        };
        intercept(store);
        const withCurrent = store.withCurrent;
        if (withCurrent) {
          store.withCurrent = (authority) => {
            const current = withCurrent.call(store, authority);
            intercept(current);
            return current;
          };
        }
      }
      return store;
    };
  }

  it.each(["batch", "comparison", "native"] as const)(
    "preserves monotonic progress on a %s host",
    async (host) => {
      const runtime = createRuntime(host);
      const first = new ReefInboxCursorStore(runtime, binding);
      const second = new ReefInboxCursorStore(runtime, binding);
      await Promise.all([first.advance(12), second.advance(7), second.advance(20)]);
      await expect(new ReefInboxCursorStore(runtime, binding).load()).resolves.toBe(20);
      await expect(first.advance(-1)).rejects.toThrow("invalid Reef inbox cursor");
      await expect(first.load()).resolves.toBe(20);
    },
  );

  it("loads and advances without application-thread SQL", async () => {
    const runtime = createRuntime();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const store = new ReefInboxCursorStore(runtime, binding);
    expect(await store.load()).toBe(0);
    await store.advance(12);
    await store.advance(7);
    expect(await store.load()).toBe(12);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "observation", bound: false },
    { phase: "observation", bound: true },
    { phase: "comparison dispatch", bound: true },
  ])(
    "refuses a comparison host revoked during $phase (bound: $bound)",
    async ({ phase, bound }) => {
      const runtime = createRuntime("comparison");
      const raw = runtime.state.openKeyedStore(options);
      await raw.register("current", { ...binding, cursor: 12 });
      const observed = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const forbiddenBatch = vi.fn(() => {
        observed.resolve();
        throw new Error("comparison-only host must not switch to batches");
      });
      const intercept = <T>(store: PluginStateKeyedStore<T> | PluginStateKeyedStore<T, 2>) => {
        const observe = store.observe!;
        store.observe = async (key) => {
          const result = await observe.call(store, key);
          if (phase === "observation") {
            observed.resolve();
            await released.promise;
          }
          return result;
        };
        const compareAndApply = store.compareAndApply!;
        store.compareAndApply = async (...args) => {
          if (phase === "comparison dispatch") {
            observed.resolve();
            await released.promise;
          }
          return compareAndApply.call(store, ...args);
        };
      };
      const open = runtime.state.openKeyedStore;
      runtime.state.openKeyedStore = <T>(storeOptions: OpenAsyncKeyedStoreOptions) => {
        const store = open<T>(storeOptions);
        const withCurrent = store.withCurrent!;
        if (bound) {
          store.withCurrent = (authority) => {
            const current = withCurrent.call(store, authority);
            current.createBatch = forbiddenBatch;
            intercept(current);
            return current;
          };
        } else {
          delete store.withCurrent;
        }
        intercept(store);
        return store;
      };
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      const controller = new AbortController();
      const refusal = new Error("inbox authority expired");
      const store = new ReefInboxCursorStore(runtime, binding, controller.signal);
      const rejected = expect(store.advance(13)).rejects.toBe(refusal);
      try {
        await observed.promise;
        controller.abort(refusal);
      } finally {
        released.resolve();
      }
      await rejected;
      await expect(raw.lookup("current")).resolves.toEqual({ ...binding, cursor: 12 });
      expect(forbiddenBatch).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["batch", "higher cursor"],
    ["comparison", "higher cursor"],
    ["batch", "different identity"],
    ["comparison", "different identity"],
  ] as const)("revalidates a %s host's conflicting %s before advancing", async (host, conflict) => {
    const runtime = createRuntime(host);
    const competing = runtime.state.openKeyedStore(options);
    beforeFirstComparison(runtime, async () => {
      await competing.register("current", {
        ...binding,
        ...(conflict === "different identity" ? { handle: "clawd" } : {}),
        cursor: 40,
      });
    });
    const store = new ReefInboxCursorStore(runtime, binding);
    if (conflict === "different identity") {
      await expect(store.advance(12)).rejects.toThrow("different identity");
    } else {
      await store.advance(12);
      await expect(store.load()).resolves.toBe(40);
    }
    await expect(competing.lookup("current")).resolves.toMatchObject({
      handle: conflict === "different identity" ? "clawd" : "molty",
      cursor: 40,
    });
  });

  it.each(["batch", "comparison"] as const)(
    "revalidates a repaired row on a %s host instead of publishing a stale binding error",
    async (host) => {
      const runtime = createRuntime(host);
      const competing = runtime.state.openKeyedStore(options);
      await competing.register("current", { ...binding, handle: "clawd", cursor: 3 });
      beforeFirstComparison(runtime, async () => {
        await competing.register("current", { ...binding, cursor: 5 });
      });
      const store = new ReefInboxCursorStore(runtime, binding);
      await store.advance(12);
      await expect(store.load()).resolves.toBe(12);
    },
  );

  it.each(["batch", "comparison", "native"] as const)(
    "refuses invalid stored state on a %s host",
    async (host) => {
      const runtime = createRuntime(host);
      const raw = runtime.state.openKeyedStore(options);
      await raw.register("current", { ...binding, cursor: "invalid" });
      const store = new ReefInboxCursorStore(runtime, binding);
      await expect(store.load()).rejects.toThrow("invalid Reef inbox cursor state");
      if (host === "native") {
        await expect(store.advance(12)).rejects.toMatchObject({
          code: "PLUGIN_STATE_WRITE_FAILED",
          operation: "register",
          message: "Failed to update plugin state entry.",
          cause: expect.objectContaining({ message: "invalid Reef inbox cursor state" }),
        });
      } else {
        await expect(store.advance(12)).rejects.toThrow("invalid Reef inbox cursor state");
      }
      await expect(raw.lookup("current")).resolves.toEqual({ ...binding, cursor: "invalid" });
    },
  );

  it.each(["batch", "comparison"] as const)(
    "propagates a failed comparison on a %s host without falling back to native writes",
    async (host) => {
      const runtime = createRuntime(host);
      const failure = new Error("comparison unavailable");
      beforeFirstComparison(runtime, async () => {
        throw failure;
      });
      const native = vi.spyOn(runtime.state, "openSyncKeyedStore");
      const store = new ReefInboxCursorStore(runtime, binding);
      await expect(store.advance(12)).rejects.toBe(failure);
      await expect(store.load()).resolves.toBe(0);
      expect(native).not.toHaveBeenCalled();
    },
  );
});
