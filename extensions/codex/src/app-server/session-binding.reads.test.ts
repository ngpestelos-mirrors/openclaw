import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  resolveCodexSessionBinding,
} from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

describe("Codex app-server binding reads", () => {
  it("keeps ordered failures without synchronous reads or retrying failed bulk acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const lookup = vi.spyOn(state.asyncReads, "lookup");
    const lookupMany = vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => ({ ok: true as const, value: readValue(key) })),
    );
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { lookup, lookupMany },
    });
    const first = { kind: "conversation" as const, bindingId: "first" };
    const invalid = { kind: "conversation" as const, bindingId: " " };
    state.register(bindingStoreKey(first), {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    });
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:first",
    );
    expect(lookupMany).not.toHaveBeenCalled();
    state.delete(bindingStoreKey(first));
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Codex app-server conversation binding requires a binding id",
    );
    lookup.mockClear();
    const failure = new Error("bulk database unavailable");
    lookupMany.mockImplementation(async () => {
      throw failure;
    });
    await expect(
      collect(store.readMany([first, { ...first, bindingId: "second" }])),
    ).rejects.toThrow(failure);
    expect(lookupMany).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(syncLookup).not.toHaveBeenCalled();
  });

  it("keeps async fallback and oversized cohorts readable without synchronous acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const first = { kind: "conversation" as const, bindingId: "first" };
    const last = { kind: "conversation" as const, bindingId: "last" };
    const binding = { threadId: "owned", cwd: "/repo" };
    state.register(bindingStoreKey(last), { version: 1, state: "active", binding });
    const legacy = createLazyCodexAppServerBindingStore(state);
    expect(await collect(legacy.readMany([first, last]))).toEqual([undefined, binding]);
    const lookupMany = vi.fn(async (keys: readonly string[]) => {
      if (keys.length > 10_000) {
        throw new Error("host bulk limit exceeded");
      }
      return keys.map((key) => ({ ok: true as const, value: readValue(key) }));
    });
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { ...state.asyncReads, lookupMany },
    });
    const identities = [...Array.from({ length: 10_000 }, () => first), last];
    const result = await collect(store.readMany(identities));
    expect(result).toHaveLength(identities.length);
    expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
    expect(result.at(-1)).toEqual(binding);
    expect(lookupMany.mock.calls.map(([keys]) => keys.length)).toEqual([10_000, 1]);
    expect(syncLookup).not.toHaveBeenCalled();
  });
  it("combines lease and mutation lineage and refuses a same-id predecessor change", async () => {
    const fixture = await createOpenClawTestState({
      prefix: "codex-combined-authority-",
      layout: "state-only",
      applyEnv: false,
    });
    const storePath = path.join(fixture.stateDir, "sessions.json");
    const store = createCodexAppServerBindingStore(createCodexTestBindingStateStore());
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "current",
      sessionKey: "agent:main:lease",
    };
    const source = { ...identity, sessionKey: "agent:main:mutation" };
    const binding = { threadId: "native-thread", cwd: "/repo" };
    try {
      for (const target of [identity, source]) {
        await upsertSessionEntry({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath,
          entry: { sessionId: target.sessionId, previousSessionId: "previous", updatedAt: 1 },
        });
      }
      await store.mutate(identity, { kind: "set", binding });
      const lease = await resolveCodexSessionBinding({ bindingStore: store, identity, storePath });
      const mutation = await resolveCodexSessionBinding({
        bindingStore: store,
        identity: source,
        storePath,
      });
      await store.withLease(
        identity,
        async () => {
          await expect(
            store.mutate(
              identity,
              {
                kind: "patch",
                threadId: binding.threadId,
                patch: { model: "first" },
              },
              mutation.authority.assertCurrent,
              mutation.authority,
            ),
          ).resolves.toBe(true);
          await patchSessionEntry({
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            storePath,
            update: () => ({ previousSessionId: "changed-without-new-session-id" }),
          });
          // Pure caller liveness remains valid. Only the fresh composed source
          // validation can refuse this mutation, even though its lease is current.
          mutation.authority.assertCurrent();
          await expect(
            store.mutate(
              identity,
              {
                kind: "patch",
                threadId: binding.threadId,
                patch: { model: "must-not-publish" },
              },
              mutation.authority.assertCurrent,
              mutation.authority,
            ),
          ).rejects.toThrow("Codex session generation is no longer current");
          expect(store.read(identity)?.model).toBe("first");
        },
        { authority: lease.authority, assertCurrent: lease.authority.assertCurrent },
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
