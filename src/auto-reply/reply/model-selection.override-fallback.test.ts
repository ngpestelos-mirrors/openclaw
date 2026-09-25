// Rejected stored model pins must resolve to the configured primary.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextWindowCaches } from "../../agents/context-cache.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createModelSelectionState } from "./model-selection.js";

type PersistReplySessionEntry =
  (typeof import("./session-entry-persistence.js"))["persistReplySessionEntry"];

const DEFAULT_MOCK_CATALOG_ENTRIES = vi.hoisted(() => [
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.5" },
  { provider: "inferencer", id: "deepseek-v3-4bit-mlx", name: "DeepSeek V3" },
  { provider: "kimi", id: "kimi-code", name: "Kimi Code" },
  { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
  { provider: "xai", id: "grok-4", name: "Grok 4" },
  { provider: "xai", id: "grok-4.20-reasoning", name: "Grok 4.20 (Reasoning)" },
]);

const sessionPersistenceMocks = vi.hoisted(() => ({
  persistReplySessionEntry: vi.fn<PersistReplySessionEntry>(),
}));

const catalogRuntimeMocks = vi.hoisted(() => {
  const loadModelCatalog = vi.fn(
    async (_params?: unknown): Promise<unknown[]> => DEFAULT_MOCK_CATALOG_ENTRIES,
  );
  return {
    loadModelCatalog,
    // Delegate to the entries mock so per-test `loadModelCatalog.mockResolvedValueOnce`
    // still drives selection; tests that need a degraded snapshot override this directly.
    loadModelCatalogSnapshot: vi.fn(async (params?: unknown) => {
      const entries = await loadModelCatalog(params as never);
      return { entries, routeVariants: entries, authoritative: true };
    }),
  };
});

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: catalogRuntimeMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: catalogRuntimeMocks.loadModelCatalogSnapshot,
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../channels/plugins/session-conversation.js", () => ({
  resolveSessionParentSessionKey: (sessionKey?: string) =>
    sessionKey?.replace(/:thread:[^:]+$/, "").replace(/:topic:[^:]+$/, "") ?? null,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: sessionPersistenceMocks.persistReplySessionEntry,
}));

const authProfileStoreMock = vi.hoisted(() => {
  let store = { version: 1, profiles: {} } as {
    version: 1;
    profiles: Record<string, { type: "api_key"; provider: string; key: string }>;
  };
  const ensureAuthProfileStore = vi.fn(() => store);
  return {
    get store() {
      return store;
    },
    set store(next) {
      store = next;
    },
    ensureAuthProfileStore,
    reset() {
      store = { version: 1, profiles: {} };
      ensureAuthProfileStore.mockClear();
    },
  };
});

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: authProfileStoreMock.ensureAuthProfileStore,
}));

// Alias-aware stub: mirrors the real isStoredCredentialCompatibleWithAuthProvider
// but inlines the claude-cli->anthropic alias so tests don't need live plugin metadata.
vi.mock("../../agents/auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: ({
    provider,
    credential,
  }: {
    provider: string;
    credential: { type: string; provider: string };
  }) => {
    const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const resolveAuthKey = (v: string) => {
      const n = normalize(v);
      // claude-cli is a deprecated choice id that resolves to the anthropic auth key
      if (n === "claudecli") {
        return "anthropic";
      }
      return n;
    };
    const providerKey = resolveAuthKey(provider);
    const credentialKey = resolveAuthKey(credential.provider);
    if (credentialKey === providerKey) {
      return true;
    }
    // OpenAI Codex compat: openai api_key credential works for openai-codex provider
    if (providerKey === "openaiapicodex" || providerKey === "openaicodex") {
      return credentialKey === "openai" && credential.type === "api_key";
    }
    return false;
  },
}));

afterEach(() => {
  getContextWindowCaches().discoveredTokenCache.clear();
  sessionPersistenceMocks.persistReplySessionEntry.mockReset();
  authProfileStoreMock.reset();
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
});

describe("createModelSelectionState disallowed override fallback target", () => {
  // A rejected override must land on the agent's configured primary, not on the first allowed
  // entry in the catalog. `provider-a` is declared first in `models.providers` and first in the
  // allow list, so an accidental first-entry fallback picks `provider-a/model-a1` either way,
  // while the configured primary is `provider-b/model-b1`.
  const sessionKey = "agent:main:discord:channel:g2";
  const cfg = {
    agents: {
      defaults: {
        model: "provider-b/model-b1",
        modelPolicy: { allow: ["provider-a/model-a1", "provider-b/model-b1"] },
      },
    },
    models: {
      providers: {
        "provider-a": {
          api: "openai-responses",
          baseUrl: "https://provider-a.example/v1",
          models: [{ id: "model-a1", name: "Provider A Model 1" }],
        },
        "provider-b": {
          api: "openai-responses",
          baseUrl: "https://provider-b.example/v1",
          models: [{ id: "model-b1", name: "Provider B Model 1" }],
        },
      },
    },
  } as unknown as OpenClawConfig;

  async function runRejectedStoredOverride(
    persistedEntry?: SessionEntry,
    source: "direct" | "parent" | "degraded" = "direct",
  ): Promise<{
    state: Awaited<ReturnType<typeof createModelSelectionState>>;
    sessionEntry: SessionEntry;
  }> {
    const sessionEntry: SessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "user",
    };
    const parentSessionKey = "agent:main:parent";
    const pinnedEntry = { ...sessionEntry };
    if (source === "parent") {
      delete sessionEntry.providerOverride;
      delete sessionEntry.modelOverride;
      delete sessionEntry.modelOverrideSource;
    }
    const sessionStore = { [sessionKey]: sessionEntry, [parentSessionKey]: pinnedEntry };
    if (persistedEntry) {
      // A concurrent writer won the reset's compare-and-swap and the row still holds the pin.
      sessionPersistenceMocks.persistReplySessionEntry.mockResolvedValueOnce({
        status: "current",
        entry: persistedEntry,
      });
    }
    // The reply owner seeds provider/model from the stored override before selection runs.
    const state = await createModelSelectionState({
      agentId: "main",
      cfg:
        source === "degraded"
          ? {
              ...cfg,
              agents: {
                defaults: {
                  ...cfg.agents?.defaults,
                  modelPolicy: { allow: ["provider-a/*", "provider-b/model-b1"] },
                },
              },
            }
          : cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      sessionStore,
      sessionKey,
      parentSessionKey: source === "parent" ? parentSessionKey : undefined,
      ...(source === "degraded"
        ? {
            preparedModelCatalog: {
              authoritative: false,
              entries: [
                { provider: "provider-a", id: "model-a1", name: "First" },
                { provider: "provider-b", id: "model-b1", name: "Primary" },
              ],
              routeVariants: [],
            },
          }
        : {}),
      ...(persistedEntry ? { storePath: "sessions.json" } : {}),
      defaultProvider: "provider-b",
      defaultModel: "model-b1",
      primaryProvider: "provider-b",
      primaryModel: "model-b1",
      provider: "provider-c",
      model: "model-c1",
      hasModelDirective: false,
    });
    if (source === "parent") {
      expect(sessionStore[parentSessionKey]).toMatchObject({
        providerOverride: "provider-c",
        modelOverride: "model-c1",
        modelOverrideSource: "user",
      });
      expect(sessionEntry.modelOverride).toBeUndefined();
    }
    return { state, sessionEntry };
  }

  it("resets a disallowed stored override to the configured primary", async () => {
    const { state, sessionEntry } = await runRejectedStoredOverride();
    expect(state.resetModelOverride).toBe(true);
    expect(state.resetModelOverrideReason).toBe("disallowed");
    expect(state.resetModelOverrideRef).toBe("provider-c/model-c1");
    // provider-a/model-a1 is the first allowed catalog entry; the primary must still win.
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
    // The run and the session the next turn reads agree on the reset target.
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it.each(["parent", "degraded"] as const)(
    "uses the primary without clearing a refused %s pin",
    async (source) => {
      const { state, sessionEntry } = await runRejectedStoredOverride(undefined, source);
      expect(state).toMatchObject({
        provider: "provider-b",
        model: "model-b1",
        resetModelOverride: false,
        resetModelOverrideRef: "provider-c/model-c1",
        resetModelOverrideReason: source === "parent" ? "disallowed" : "temporarily-unavailable",
      });
      if (source === "degraded") {
        expect(sessionEntry.modelOverride).toBe("model-c1");
        expect(sessionEntry.modelOverrideSource).toBe("user");
      }
    },
  );

  it("keeps the configured primary when the reset loses the persistence race", async () => {
    // The refusal is a decision this call already made, so a lost compare-and-swap must not send
    // the turn to the first allowed catalog entry while the row still holds the refused override.
    const { state, sessionEntry } = await runRejectedStoredOverride({
      sessionId: "session-id",
      updatedAt: Date.now() + 1,
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "user",
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.resetModelOverrideReason).toBeUndefined();
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
    // The refused override survives on the row for the next turn to retry the reset.
    expect(sessionEntry.modelOverride).toBe("model-c1");
  });

  it("keeps the stale primary fallback for a caller without a session store", async () => {
    // A session store is optional, and the reset block needs one, so a caller that omits it cannot
    // reset anything. The stale primary fallback predates that block and must keep firing for it.
    const sessionEntry: SessionEntry = {
      sessionId: "session-id",
      updatedAt: Date.now(),
      providerOverride: "provider-c",
      modelOverride: "model-c1",
      modelOverrideSource: "auto",
      modelOverrideRouteResolution: "resolved",
      modelOverrideFallbackOriginProvider: "provider-c",
      modelOverrideFallbackOriginModel: "model-c2",
    };
    const state = await createModelSelectionState({
      agentId: "main",
      cfg,
      agentCfg: cfg.agents?.defaults,
      sessionEntry,
      defaultProvider: "provider-b",
      defaultModel: "model-b1",
      primaryProvider: "provider-b",
      primaryModel: "model-b1",
      provider: "provider-c",
      model: "model-c1",
      hasModelDirective: false,
      isHeartbeat: true,
    });
    expect(state.resetModelOverride).toBe(false);
    expect(state.provider).toBe("provider-b");
    expect(state.model).toBe("model-b1");
  });
});
