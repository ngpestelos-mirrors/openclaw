import { afterEach, expect, it, vi } from "vitest";
import {
  captureProviderCatalogExpiries,
  recordLiveCatalogExpiry,
  withProviderCatalogExpiry,
} from "./provider-catalog-expiry.js";

afterEach(() => vi.useRealTimers());

it("makes uncached inventory renewable without shortening a provider's cache deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000);
  const { providerExpiries } = await captureProviderCatalogExpiries(async () => {
    await withProviderCatalogExpiry(
      async () => ["uncached"],
      (providers) => providers,
    );
    await withProviderCatalogExpiry(
      async () => {
        recordLiveCatalogExpiry(121_000);
        return ["cached"];
      },
      (providers) => providers,
    );
  });
  const uncachedExpiry = providerExpiries.get("uncached");
  expect(uncachedExpiry).toBeGreaterThan(Date.now());
  expect(uncachedExpiry).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(providerExpiries.get("cached")).toBe(121_000);
});
