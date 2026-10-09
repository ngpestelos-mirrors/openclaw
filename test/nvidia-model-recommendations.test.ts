import { afterEach, expect, it, vi } from "vitest";
import nvidia from "../extensions/nvidia/index.js";
import { buildPreparedModelCatalogSnapshot } from "../src/agents/model-catalog.js";
import { listModels } from "../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { resolveRemoteCatalogUrl } from "../src/model-catalog/remote-config.js";
import { withRemoteModelCatalogSnapshot } from "../src/model-catalog/remote-overlay.js";
import { registerSingleProviderPlugin } from "../src/plugin-sdk/plugin-test-runtime.js";
import { clearLiveCatalogCacheForTests } from "../src/plugin-sdk/provider-catalog-shared.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { captureProviderCatalogExpiries } from "../src/plugins/provider-catalog-expiry.js";
import type { ProviderCatalogOutcome } from "../src/plugins/provider-catalog-outcome.js";
import {
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "../src/plugins/provider-discovery.js";

const fetchGuard = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));
afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  fetchGuard.mockReset();
});

it("publishes NVIDIA feed authority through discovery, snapshots and models.list without global union", async () => {
  const ultra = "nvidia/nemotron-3-ultra-550b-a55b";
  const lightning = "nvidia/nemotron-3.5-lightning-30b-a3b";
  const novel = "vendor/new-chat-not-in-hosted-catalog";
  let featured = [novel, ultra, "z-ai/glm-5-3", "vendor/withdrawn"];
  const inventory = [ultra, lightning, novel, "z-ai/glm-5.3", "vendor/embedding"];
  fetchGuard.mockImplementation(async ({ url }: { url: string }) => ({
    response: Response.json(
      url.endsWith("/models")
        ? { data: inventory.map((id) => ({ id })) }
        : {
            "featured-models": featured.map((model) => ({
              model,
              "model-name": model,
              context: 32768,
              "max-output": 8192,
            })),
          },
    ),
    finalUrl: url,
    release: () => {},
  }));
  const provider = await registerSingleProviderPlugin(nvidia);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "nvidia",
        providers: ["nvidia"],
        modelIdNormalization: { providers: { nvidia: { prefixWhenBare: "nvidia" } } },
      },
    ],
  });
  const config = { agents: { defaults: { model: { primary: "other/default" } } } };
  const project = async () => {
    const outcomes: ProviderCatalogOutcome[] = [];
    const result = await runProviderCatalog({
      provider,
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "synthetic-not-real" }),
      resolveProviderAuth: () => ({ apiKey: "synthetic-not-real", mode: "api_key", source: "env" }),
      reportCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    const discovered = normalizePluginDiscoveryResult({ provider, result });
    const rows = Object.entries(discovered).flatMap(([id, cfg]) =>
      cfg.models.map((row) => ({ ...row, provider: id, api: cfg.api, baseUrl: cfg.baseUrl })),
    );
    const snapshot = await buildPreparedModelCatalogSnapshot({
      config,
      agentDir: "/tmp/nvidia-recommendations",
      metadataSnapshot,
      authCredentials: {},
      includeProviderPluginAugmentation: false,
      readOnly: true,
      providerOutcomes: outcomes,
      models: [
        ...rows,
        { provider: "other", id: "default", name: "Default" },
        { provider: "other", id: "central", name: "Central" },
        { provider: "other", id: "rest", name: "Rest" },
      ],
    });
    return listModels({
      cfg: config,
      catalog: snapshot.entries,
      metadataSnapshot,
      catalogComplete: true,
      preparedAuthStore: { version: 1, profiles: {} },
      catalogDiagnostics: {
        providerOutcomes: outcomes,
        providerRecommendations: snapshot.providerRecommendations,
      },
    });
  };
  await withRemoteModelCatalogSnapshot(
    {
      sourceUrl: resolveRemoteCatalogUrl(config),
      generatedAt: 1,
      revision: "unchanged-hosted",
      providers: {
        nvidia: { models: [], recommendedModels: [lightning, ultra] },
        other: { models: [], recommendedModels: ["central"] },
      },
      pricing: {},
      upstreamPricing: {},
    },
    async () => {
      const first = await project();
      expect(
        first.models
          .filter((row) => row.provider === "nvidia")
          .map(({ id, recommended }) => [id, recommended]),
      ).toEqual([
        [novel, true],
        [ultra, true],
        [lightning, false],
      ]);
      expect(
        first.models
          .filter((row) => row.provider === "other")
          .map(({ id, recommended }) => [id, recommended]),
      ).toEqual([
        ["default", undefined],
        ["central", true],
        ["rest", undefined],
      ]);
      // Reordered and empty feeds are visible immediately on explicit refresh,
      // even while both response TTLs and the hosted catalog are unchanged.
      featured = [ultra, novel];
      const reordered = (await captureProviderCatalogExpiries(project, true)).value;
      expect(
        reordered.models
          .filter((row) => row.provider === "nvidia" && row.recommended)
          .map(({ id }) => id),
      ).toEqual([ultra, novel]);
      featured = [];
      const empty = (await captureProviderCatalogExpiries(project, true)).value;
      expect(
        empty.models
          .filter((row) => row.provider === "nvidia")
          .map(({ id, recommended }) => [id, recommended]),
      ).toEqual([
        [ultra, false],
        [lightning, false],
      ]);
    },
  );
});
