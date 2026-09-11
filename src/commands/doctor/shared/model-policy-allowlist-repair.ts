import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import {
  resolveLogicalModelCatalogEntryState,
  resolveLogicalVisibleModelCatalog,
} from "../../../agents/model-catalog-visibility.js";
import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
import { resolveConfiguredModelRef } from "../../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../../agents/model-visibility-policy.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import {
  hasExplicitModelPolicyAllow,
  hasModelPolicyAllowlistMigrationMarker,
} from "../../../config/model-policy-allowlist-migration.js";
import {
  createModelPolicyRefValidator,
  parseModelPolicyWildcardRef,
} from "../../../config/model-policy-ref.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorConfigMutationResult } from "./config-mutation-state.js";

const ALLOW_PATH = "agents.defaults.modelPolicy.allow";

function modelPolicyInspectionConfig(config: OpenClawConfig): OpenClawConfig {
  const inspectionConfig = structuredClone(config);
  for (const agent of [inspectionConfig.agents?.defaults, ...listAgentEntries(inspectionConfig)]) {
    if (Array.isArray(agent?.modelPolicy?.allow)) {
      agent.modelPolicy.allow = agent.modelPolicy.allow.filter(
        (entry) => typeof entry === "string",
      );
    }
  }
  return inspectionConfig;
}

export async function prepareDoctorModelPolicyAllowlist(params: {
  config: OpenClawConfig;
  sourceConfig: unknown;
  repair: boolean;
}): Promise<DoctorConfigMutationResult & { warnings: string[] }> {
  const { config } = params;
  if (
    ![config.agents?.defaults, ...listAgentEntries(config)].some(
      (agent) => Array.isArray(agent?.modelPolicy?.allow) && agent.modelPolicy.allow.length > 0,
    )
  ) {
    return { config, changes: [], warnings: [] };
  }
  const { withPreparedModelCatalogOwner } =
    await import("../../../agents/prepared-model-catalog.js");
  const { createModelCatalogDecisions } =
    await import("../../../agents/model-catalog-decisions.js");
  const { getPreparedModelRuntimeAuthStore, getPreparedModelRuntimeAuthMaterializations } =
    await import("../../../agents/prepared-model-runtime-auth.js");
  const { openAIModelCatalogRoutePolicy } = await import("../../../agents/openai-model-routes.js");
  const { PreparedModelRuntimePublicationSupersededError } =
    await import("../../../agents/prepared-model-runtime.errors.js");
  const { isManifestPluginAvailableForControlPlane } =
    await import("../../../plugins/manifest-contract-eligibility.js");
  const inspectionConfig = modelPolicyInspectionConfig(config);
  return withPreparedModelCatalogOwner(
    { config: inspectionConfig, readOnly: true },
    async (owner) => {
      const authStore = getPreparedModelRuntimeAuthStore(owner);
      const agentId = owner.catalogOwner?.agentId;
      if (!authStore || !agentId) {
        throw new Error("Model catalog owner omitted its auth store or agent scope");
      }
      const decisions = createModelCatalogDecisions({
        cfg: inspectionConfig,
        agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
        snapshot: owner.modelCatalog,
        metadataSnapshot: owner.metadataSnapshot,
        preparedAuthStore: authStore,
        preparedRuntimeAuthModes: owner.authModes,
        preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(owner),
        pluginRegistry: owner.pluginRegistry,
        observationConfig: owner.observationConfig,
        isCurrent: owner.isCurrent,
      });
      const { allowList } = await resolveLogicalVisibleModelCatalog({
        cfg: inspectionConfig,
        catalog: owner.modelCatalog.entries,
        defaultProvider: DEFAULT_PROVIDER,
        routePolicy: openAIModelCatalogRoutePolicy,
        routeVariants: owner.modelCatalog.routeVariants,
        evaluateEntry: async (entry, variants) =>
          resolveLogicalModelCatalogEntryState({
            evaluation: decisions.evaluateNative(
              entry,
              await decisions.evaluateEntry(entry, variants),
            ),
            provider: entry.provider,
            routePolicy: openAIModelCatalogRoutePolicy,
          }),
      });
      const providers = new Set([
        ...owner.modelCatalog.entries.map((row) => row.provider),
        ...Object.keys(config.models?.providers ?? {}),
        ...owner.metadataSnapshot.plugins.flatMap((plugin) => plugin.providers),
      ]);
      for (const provider of providers) {
        const owners = owner.metadataSnapshot.plugins.filter((plugin) =>
          plugin.providers.includes(provider),
        );
        if (
          owners.length > 0 &&
          !owners.some((plugin) =>
            isManifestPluginAvailableForControlPlane({
              snapshot: owner.metadataSnapshot,
              plugin,
              config,
            }),
          )
        ) {
          providers.delete(provider);
        }
      }
      const result = inspectModelPolicyAllowlist({
        config,
        catalog: owner.modelCatalog.entries,
        enabledProviders: providers,
        sourceConfig: params.sourceConfig,
        hiddenCount: allowList?.hiddenCount ?? 0,
      });
      if (!decisions.isCurrent()) {
        throw new PreparedModelRuntimePublicationSupersededError(
          "Model catalog changed while checking the allow list",
        );
      }
      return params.repair ? result : { config, changes: [], warnings: result.warnings };
    },
  );
}

/** Doctor-only offer: startup must never broaden an upgrade-generated restriction. */
function repairUpgradeGeneratedModelAllowlist(
  config: OpenClawConfig,
  sourceConfig: unknown = config,
): DoctorConfigMutationResult {
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  if (!hasModelPolicyAllowlistMigrationMarker(sourceConfig) || !Array.isArray(allow)) {
    return { config, changes: [] };
  }
  const validRef = createModelPolicyRefValidator();
  const providers = new Set<string>();
  let changed = false;
  let hasExactEntry = false;
  const next = allow.flatMap((entry) => {
    if (typeof entry !== "string" || !validRef(entry)) {
      return [entry];
    }
    const wildcard = parseModelPolicyWildcardRef(entry);
    const ref = parseModelCatalogRef(entry);
    if (!ref || (wildcard && wildcard.key !== `${wildcard.provider}/*`)) {
      return [entry];
    }
    hasExactEntry ||= !wildcard;
    const replacement = `${ref.provider}/*`;
    changed ||= entry !== replacement || providers.has(replacement);
    if (providers.has(replacement)) {
      return [];
    }
    providers.add(replacement);
    return [replacement];
  });
  return hasExactEntry && changed
    ? {
        config: {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              modelPolicy: { ...config.agents?.defaults?.modelPolicy, allow: next },
            },
          },
        },
        changes: [`Replaced upgrade-generated exact entries in ${ALLOW_PATH} with provider/*.`],
      }
    : { config, changes: [] };
}

function inspectModelPolicyAllowlist(params: {
  config: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  enabledProviders: ReadonlySet<string>;
  sourceConfig: unknown;
  hiddenCount: number;
}): DoctorConfigMutationResult & { warnings: string[] } {
  const { config, catalog } = params;
  const allow = config.agents?.defaults?.modelPolicy?.allow;
  const unchanged = { config, changes: [], warnings: [] };
  const warnings: string[] = [];
  // Malformed entries remain in the repair candidate; policy inspection consumes only strings.
  const inspectionConfig = modelPolicyInspectionConfig(config);
  const scopes = [
    {
      allow,
      path: ALLOW_PATH,
      agentId: undefined,
      primary: resolveAgentModelPrimaryValue(config.agents?.defaults?.model),
    },
    ...listAgentEntries(config)
      .filter(
        (agent) =>
          resolveAgentModelPrimaryValue(agent.model) !== undefined ||
          hasExplicitModelPolicyAllow(agent.modelPolicy),
      )
      .map((agent) => ({
        allow: agent.modelPolicy?.allow,
        path: `agents.entries.${agent.id}.modelPolicy.allow`,
        agentId: agent.id,
        primary: resolveAgentEffectiveModelPrimary(config, agent.id),
      })),
  ];
  for (const scope of scopes) {
    for (const entry of Array.isArray(scope.allow) ? scope.allow : []) {
      if (typeof entry !== "string") {
        continue;
      }
      const ref = parseModelCatalogRef(entry);
      if (!ref) {
        continue;
      }
      if (!params.enabledProviders.has(ref.provider)) {
        warnings.push(
          `${scope.path}: ${entry} uses a provider that is not enabled. Enable ${ref.provider} or remove this entry.`,
        );
      } else if (
        !parseModelPolicyWildcardRef(entry) &&
        !catalog.some((row) => row.provider === ref.provider && row.id === ref.modelId)
      ) {
        warnings.push(
          `${scope.path}: ${entry} is absent from the model catalog. Replace it with an available model or ${ref.provider}/*, or remove this entry.`,
        );
      }
    }
    if (scope.primary) {
      const policy = createModelVisibilityPolicy({
        cfg: inspectionConfig,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        agentId: scope.agentId,
      });
      const selected = resolveConfiguredModelRef({
        cfg: inspectionConfig,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        agentId: scope.agentId,
      });
      if (!policy.allowsByList(selected)) {
        const path = policy.allowRepairConfigPath.replace("entries.*", `entries.${scope.agentId}`);
        const model = `${selected.provider}/${selected.model}`;
        warnings.push(
          `Your primary model ${model} is not in your allow list${scope.agentId ? ` for agent ${scope.agentId}` : ""}. It remains usable as Default. Add "${model}" or "${selected.provider}/*" to ${path}.`,
        );
      }
    }
  }
  if (!Array.isArray(allow) || !allow.length) {
    return { ...unchanged, warnings };
  }
  const mutation = repairUpgradeGeneratedModelAllowlist(config, params.sourceConfig);
  if (mutation.changes.length === 0) {
    return { ...unchanged, warnings };
  }
  const hiddenCount = params.hiddenCount;
  if (hiddenCount === 0) {
    return { ...unchanged, warnings };
  }
  warnings.push(
    `${ALLOW_PATH} was generated by an upgrade and hides ${hiddenCount} newer models. Run openclaw doctor --fix to use provider/* for its providers.`,
  );
  return { ...mutation, warnings };
}
