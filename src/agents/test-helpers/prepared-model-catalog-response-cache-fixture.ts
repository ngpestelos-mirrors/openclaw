export function catalogResponseCacheFixtureSource(providerId: string): string {
  return `
          const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
          const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER + ".fetches";
          const id = await getCachedLiveCatalogValue({
            keyParts: [marker], ttlMs: 86400000, refreshOnExplicitRequest: true,
            load: async () => {
              const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) + 1 : 1;
              fs.writeFileSync(marker, String(count));
              return "cached-recommendation-" + count;
            },
          });
          return { provider: {
            baseUrl: "https://worker-catalog.invalid/v1", api: "openai-completions",
            models: [{ id, name: id }],
          }, outcomes: [{ provider: ${JSON.stringify(providerId)}, status: "ready", recommendedModels: [id] }] };
  `;
}
