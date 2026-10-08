import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

// Failed discovery keeps saved rows; its catalog owner retries off the read path with capped backoff.
const FAILED_DISCOVERY_RETRY_MS = 30_000;
const FAILED_DISCOVERY_RETRY_MAX_MS = 30 * 60_000;

export function createFailedDiscoveryRetry(
  isCurrent: () => boolean,
  normalizeProvider: (provider: string) => string,
  acquire: (
    options: PreparedModelCatalogRefreshOptions,
    acquireNative: boolean,
  ) => Promise<unknown>,
) {
  const failures = new Map<string, number>();
  const failed = (providers: Iterable<string>) => {
    for (const provider of providers) {
      const attempt = (failures.get(provider) ?? 0) + 1;
      failures.set(provider, attempt);
      setTimeout(
        () => {
          if (isCurrent() && failures.get(provider) === attempt) {
            void acquire({ providerIds: [provider], refresh: true }, false).catch(() => undefined);
          }
        },
        Math.min(FAILED_DISCOVERY_RETRY_MS * 2 ** (attempt - 1), FAILED_DISCOVERY_RETRY_MAX_MS),
      ).unref?.();
    }
  };
  return {
    failed,
    /** Records one acquisition's provider outcomes and returns the providers that failed. */
    observe: (scope: ReadonlySet<string>, outcomes: ModelCatalogSnapshot["providerOutcomes"]) => {
      const failedProviders = new Set(
        outcomes?.flatMap((outcome) =>
          outcome.status === "ready" ? [] : [normalizeProvider(outcome.provider)],
        ),
      );
      for (const provider of scope) {
        if (!failedProviders.has(provider)) {
          failures.delete(provider);
        }
      }
      failed([...failedProviders].filter((provider) => scope.has(provider)));
      return failedProviders;
    },
  };
}
