import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { PreparedModelCatalogInventory } from "./prepared-model-runtime.types.js";

export function filterNativeModelCatalogScopes<T extends { provider: string }>(
  scopes: Readonly<Record<string, readonly T[]>> | undefined,
  includesProvider: (provider: string) => boolean,
): Readonly<Record<string, readonly T[]>> | undefined {
  return (
    scopes &&
    Object.fromEntries(
      Object.entries(scopes).map(([runtime, rows]) => [
        runtime,
        rows.filter(({ provider }) => includesProvider(provider)),
      ]),
    )
  );
}

export function filterPreparedProviderCatalog(
  catalog: ModelCatalogSnapshot,
  includesProvider: (provider: string) => boolean,
): ModelCatalogSnapshot {
  return {
    ...catalog,
    entries: catalog.entries.filter((entry) => includesProvider(entry.provider)),
    routeVariants: catalog.routeVariants.filter((entry) => includesProvider(entry.provider)),
    staticEntries: catalog.staticEntries?.filter((entry) => includesProvider(entry.provider)),
    ...(catalog.providerRecommendations
      ? {
          providerRecommendations: Object.fromEntries(
            Object.entries(catalog.providerRecommendations).filter(([provider]) =>
              includesProvider(provider),
            ),
          ),
        }
      : {}),
    providerOutcomes: catalog.providerOutcomes?.filter((outcome) =>
      includesProvider(outcome.provider),
    ),
    nativeProviderOutcomes: filterNativeModelCatalogScopes(
      catalog.nativeProviderOutcomes,
      includesProvider,
    ),
    nativeHostRows: filterNativeModelCatalogScopes(catalog.nativeHostRows, includesProvider),
  };
}

export function selectPreparedModelCatalogInventory(
  inventory: PreparedModelCatalogInventory,
  includesProvider: (provider: string) => boolean,
): PreparedModelCatalogInventory {
  return {
    ...inventory,
    catalog: filterPreparedProviderCatalog(inventory.catalog, includesProvider),
    runtimeModels: new Map(
      [...inventory.runtimeModels].filter(([provider]) => includesProvider(provider)),
    ),
    providers: new Map([...inventory.providers].filter(([provider]) => includesProvider(provider))),
    discoveryOrigins: inventory.discoveryOrigins.filter(({ provider }) =>
      includesProvider(provider),
    ),
  };
}

export function mergePreparedModelCatalogInventory(
  previous: PreparedModelCatalogInventory | undefined,
  discovered: PreparedModelCatalogInventory,
  providers: ReadonlySet<string>,
  normalize: (provider: string) => string,
): PreparedModelCatalogInventory {
  const retained =
    previous &&
    selectPreparedModelCatalogInventory(
      previous,
      (provider) => !providers.has(normalize(provider)),
    );
  const catalog = discovered.catalog;
  const before = retained?.catalog;
  const outcomes = [...(before?.providerOutcomes ?? []), ...(catalog.providerOutcomes ?? [])];
  return {
    ...discovered,
    catalog: {
      ...catalog,
      entries: [...(before?.entries ?? []), ...catalog.entries],
      routeVariants: [...(before?.routeVariants ?? []), ...catalog.routeVariants],
      staticEntries: [...(before?.staticEntries ?? []), ...(catalog.staticEntries ?? [])],
      ...(before?.providerRecommendations || catalog.providerRecommendations
        ? {
            providerRecommendations: {
              ...before?.providerRecommendations,
              ...catalog.providerRecommendations,
            },
          }
        : {}),
      providerOutcomes: outcomes,
      authoritative: outcomes.every((outcome) => outcome.status === "ready"),
    },
    runtimeModels: new Map([...(retained?.runtimeModels ?? []), ...discovered.runtimeModels]),
    providers: new Map([...(retained?.providers ?? []), ...discovered.providers]),
    discoveryOrigins: [...(retained?.discoveryOrigins ?? []), ...discovered.discoveryOrigins],
  };
}
