import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareModelPricingContext } from "../model-catalog/pricing.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  ownerKey,
  prepareModelRuntimeOwner,
  publishPreparedModelRuntimeOwnerBatch,
} from "./prepared-model-runtime.owner.js";
import {
  discardPreparedPluginGeneration,
  releasePreparedPluginPublication,
} from "./prepared-model-runtime.plugin-lifetime.js";
import {
  collectPreparedModelRuntimeInventories,
  isPreparedModelRuntimeOwnerInRefreshScope,
  listConfiguredRefreshInputs,
  updateOwnersForScopedRefresh,
} from "./prepared-model-runtime.refresh-scope.js";
import type {
  PreparedModelRuntimeInput,
  PreparedModelRuntimeOwner,
  PreparedModelRuntimeRefreshOptions,
} from "./prepared-model-runtime.types.js";

/** Rebuilds active owners after config/plugin runtime publication. */
export async function refreshPreparedModelRuntimeSnapshotsNow(
  config: OpenClawConfig,
  options: PreparedModelRuntimeRefreshOptions,
  context: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    agentBuildCompletions: Map<string, Promise<void>>;
    buildTimeoutMs: number;
    gatewayLifecycleActive: boolean;
    isPublicationCurrent: () => boolean;
    acquisitionSignal: AbortSignal;
    progress?: Parameters<typeof publishPreparedModelRuntimeOwnerBatch>[0]["progress"];
  },
): Promise<void> {
  const { owners, agentBuildCompletions, gatewayLifecycleActive, isPublicationCurrent, progress } =
    context;
  const catalogMode = options.catalogMode ?? "live";
  const staleError = new Error("prepared model runtime owner is stale after config publication");
  const inventories = collectPreparedModelRuntimeInventories(owners.values());
  updateOwnersForScopedRefresh(owners, options.agentIds, staleError, {
    retainedConfig: config,
  });
  const entries: Array<{ owner?: PreparedModelRuntimeOwner; input: PreparedModelRuntimeInput }> =
    [];
  const knownKeys = new Set<string>();
  for (const input of listConfiguredRefreshInputs(config, options, owners)) {
    if (options.agentIds && input.agentId && !options.agentIds.has(input.agentId)) {
      continue;
    }
    const key = ownerKey(input);
    if (knownKeys.has(key)) {
      continue;
    }
    knownKeys.add(key);
    const owner = owners.get(key);
    entries.push({ owner, input });
  }
  for (const [key, owner] of owners) {
    if (!isPreparedModelRuntimeOwnerInRefreshScope(owner, options.agentIds)) {
      continue;
    }
    if (!knownKeys.has(key) && (gatewayLifecycleActive || owner.provenance === "configured")) {
      owners.delete(key);
      retirePreparedModelRuntimeGeneration(owner);
      releasePreparedPluginPublication(owner);
    }
  }
  const candidates = entries.map(({ owner: existing, input }) => {
    // Dynamic and standalone owners have different lifetime contracts. A configured publication
    // must replace them so an older lease release cannot remove the committed generation.
    const owner = prepareModelRuntimeOwner(
      input,
      "configured",
      catalogMode,
      existing?.provenance === "configured" ? existing : undefined,
    );
    owner.catalogInventory = inventories.get(
      ownerKey({ ...input, runtimePluginSelections: undefined }),
    );
    return owner;
  });
  await publishPreparedModelRuntimeOwnerBatch({
    ownersToPublish: candidates,
    owners,
    agentBuildCompletions,
    buildTimeoutMs: progress ? undefined : context.buildTimeoutMs,
    isPublicationCurrent,
    // Config replacement is one transaction. Per-owner auth supersession may retire individual
    // candidates, while a newer config epoch stops every remaining build in this publication.
    isBuildCurrent: isPublicationCurrent,
    onBuildStats: options.onBuildStats,
    pluginMetadataSnapshot: options.pluginMetadataSnapshot,
    registerEntriesAfterBuildStart: true,
    progress,
    acquisitionSignal: context.acquisitionSignal,
  });
}

/** Builds privately; only the final serialized commit replaces request-visible owners. */
export async function publishPreparedModelRuntimeCatalogReplacement(params: {
  owners: Map<string, PreparedModelRuntimeOwner>;
  agentBuildCompletions: Map<string, Promise<void>>;
  buildTimeoutMs: number;
  signal: AbortSignal;
  isPublicationCurrent: () => boolean;
  prepareCommit: (owners: readonly PreparedModelRuntimeOwner[]) => () => void;
  commit: (publish: () => void) => Promise<void>;
}): Promise<boolean> {
  const claims = [...params.owners.values()]
    .filter((owner) => owner.provenance === "configured")
    .map((owner) => ({ owner, generation: owner.generation, input: owner.input }));
  if (
    !claims.length ||
    claims.some(({ owner }) => !owner.snapshot || owner.needsRefresh || owner.pending)
  ) {
    return false;
  }
  const staged = new Map<string, PreparedModelRuntimeOwner>();
  let committed = false;
  const isCurrent = () =>
    !params.signal.aborted &&
    params.isPublicationCurrent() &&
    claims.every(
      ({ owner, generation, input }) =>
        params.owners.get(ownerKey(input)) === owner &&
        owner.generation === generation &&
        owner.input === input &&
        !owner.needsRefresh &&
        !owner.pending,
    );
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "remote catalog publication was superseded",
      );
    }
  };
  const candidates = claims.map(({ input, generation }) => {
    const candidate = prepareModelRuntimeOwner(input, "configured", "static");
    candidate.generation = generation;
    return candidate;
  });
  const retireCandidates = () => {
    for (const owner of candidates) {
      owner.generation += 1;
      retirePreparedModelRuntimeGeneration(owner);
    }
  };
  params.signal.addEventListener("abort", retireCandidates, { once: true });
  try {
    assertCurrent();
    await publishPreparedModelRuntimeOwnerBatch({
      ownersToPublish: candidates,
      owners: staged,
      agentBuildCompletions: params.agentBuildCompletions,
      buildTimeoutMs: params.buildTimeoutMs,
      registerEntriesAfterBuildStart: true,
      acquisitionSignal: params.signal,
      isPublicationCurrent: () => committed || isCurrent(),
      isOwnerRegistered: (key, owner) => (committed ? params.owners : staged).get(key) === owner,
      isOwnerPublished: (key, owner) => committed && params.owners.get(key) === owner,
    });
    for (const owner of candidates) {
      assertCurrent();
      const catalog = await owner.snapshot?.loadFullModelCatalog?.({
        refresh: true,
        waitForCompletion: true,
      });
      if (!catalog || catalog.authoritative === false || catalog.refreshFailed) {
        throw new Error("Remote catalog preparation could not acquire a complete model inventory");
      }
    }
    for (const config of new Set(candidates.map((owner) => owner.input.config))) {
      await prepareModelPricingContext(config);
    }
    await params.commit(() => {
      assertCurrent();
      const commit = params.prepareCommit(candidates);
      assertCurrent();
      commit();
      for (const owner of candidates) {
        params.owners.set(ownerKey(owner.input), owner);
      }
      committed = true;
      // Existing leases retain their pair; other owners must rebuild before new admission.
      for (const owner of params.owners.values()) {
        if (owner.provenance !== "configured") {
          owner.needsRefresh = true;
        }
      }
      for (const { owner } of claims) {
        owner.generation += 1;
        retirePreparedModelRuntimeGeneration(owner);
        releasePreparedPluginPublication(owner);
      }
      claims.length = 0;
      staged.clear();
    });
    return true;
  } finally {
    params.signal.removeEventListener("abort", retireCandidates);
    if (!committed) {
      retireCandidates();
      for (const owner of candidates) {
        releasePreparedPluginPublication(owner);
      }
      await Promise.all(
        candidates.map((owner) =>
          owner.pluginGeneration
            ? discardPreparedPluginGeneration(owner.pluginGeneration)
            : undefined,
        ),
      );
    }
  }
}
