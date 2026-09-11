import { describe, expect, it, vi } from "vitest";
import { buildOpenAICompatibleProviderFamilyCatalog } from "./provider-catalog-live-runtime.js";
import type { ProviderCatalogContext } from "./provider-catalog-shared.js";

describe("provider catalog live-runtime scope", () => {
  it.each([
    { credentialProviderId: undefined, source: "family-plan" },
    { credentialProviderId: "shared-source", source: "shared-source" },
  ])(
    "scopes family entries with credential source $source",
    async ({ credentialProviderId, source }) => {
      const buildPrimary = vi.fn(() => ({
        baseUrl: "not-a-url",
        api: "openai-completions" as const,
        models: [],
      }));
      const buildPlan = vi.fn(() => ({
        baseUrl: "not-a-url",
        api: "openai-completions" as const,
        models: [],
      }));
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        credentialProviderId,
        entries: [
          {
            id: "family",
            label: "Family",
            baseUrl: "not-a-url",
            models: [],
            buildProvider: buildPrimary,
          },
          {
            id: "family-plan",
            label: "Family Plan",
            baseUrl: "not-a-url",
            models: [],
            buildProvider: buildPlan,
          },
        ],
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: vi.fn(),
      });

      const resolveProviderApiKey = vi.fn((provider: string) => ({
        apiKey: provider === source ? "plan-key" : undefined,
      }));
      const context: ProviderCatalogContext = {
        providerIds: ["family-plan"],
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      };
      const result = await family.catalog.run(context);

      expect(result && "providers" in result ? Object.keys(result.providers) : []).toEqual([
        "family-plan",
      ]);
      expect(buildPrimary).not.toHaveBeenCalled();
      expect(buildPlan).toHaveBeenCalledOnce();
      expect(result && "providers" in result && result.providers["family-plan"].apiKey).toBe(
        "plan-key",
      );
      resolveProviderApiKey.mockReturnValueOnce({ apiKey: undefined });
      await expect(family.catalog.run(context)).resolves.toBeNull();

      resolveProviderApiKey.mockClear();
      await expect(family.catalog.run({ ...context, providerIds: ["other"] })).resolves.toBeNull();
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
    },
  );
});
