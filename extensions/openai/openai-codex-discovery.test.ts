import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogWithFetchGuard } from "./test-support/live-catalog.test-support.js";
const codexClient = vi.hoisted(() => ({
  resolveCodexClientVersion: vi.fn(async (): Promise<string | undefined> => undefined),
}));
// mock-isolation: the real facade loads the Codex plugin, which probes the host PATH for codex.
vi.mock("openclaw/plugin-sdk/codex-client-version-runtime", () => codexClient);
async function discoverCodexModels(models: Record<string, unknown>[]) {
  const fetch = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => ({
    response: Response.json({ models }),
    finalUrl: url,
    release: async () => undefined,
  }));
  const { provider } = await runCatalogWithFetchGuard({
    fetchGuard: fetch,
    auth: {
      mode: "oauth",
      apiKey: "oauth-token",
      discoveryApiKey: "oauth-token",
      source: "profile",
      profileId: "openai:chatgpt",
    },
  });
  return { provider, fetch };
}

describe("OpenAI discovered subscription models", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());
  it("reports the Codex binary version that runs turns as client_version", async () => {
    codexClient.resolveCodexClientVersion.mockResolvedValueOnce("0.162.1");
    const { fetch } = await discoverCodexModels([{ slug: "gpt-5.5", visibility: "list" }]);

    expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1",
    ]);
  });
  it.each([
    { modelId: "gpt-5.4", contextWindow: 272_000, contextTokens: 272_000 },
    { modelId: "gpt-6.1-sol", contextWindow: 128_000, contextTokens: 128_000 },
    { modelId: "gpt-6.1-sol", contextWindow: undefined, contextTokens: 500_000 },
  ])(
    "maps discovered $modelId with active window $contextWindow into a ChatGPT response model",
    async ({ modelId, contextWindow, contextTokens }) => {
      const { provider } = await discoverCodexModels([
        {
          slug: modelId,
          visibility: "list",
          supported_reasoning_levels: ["medium", "high"].map((effort) => ({ effort })),
          context_window: contextWindow,
          max_context_window: 1_050_000,
          max_output_tokens: 128_000,
        },
      ]);
      expect(provider.models[0]).toMatchObject({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1_050_000,
        contextTokens,
        maxTokens: 128_000,
      });
      if (modelId === "gpt-6.1-sol") {
        const discovered = provider.models[0];
        assert(discovered, "expected discovered GPT-6.1 Sol");
        expect(discovered).toMatchObject({
          thinkingLevelMap: { off: null },
          compat: { supportedReasoningEfforts: ["medium", "high"] },
        });
        expect(
          clampThinkingLevel(
            {
              ...discovered,
              provider: "openai",
              api: "openai-chatgpt-responses",
              baseUrl: provider.baseUrl,
              input: discovered.input.filter(
                (modality) => modality === "text" || modality === "image",
              ),
              contextWindow: discovered.contextWindow ?? 1_050_000,
            },
            "off",
          ),
        ).not.toBe("off");
      }
    },
  );
});
