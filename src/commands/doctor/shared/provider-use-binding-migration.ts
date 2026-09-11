import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForRuntime } from "../../../agents/auth-profiles.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
  type CandidateAuthProfileStore,
} from "../../../agents/auth-profiles/candidate-stores.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "../../../agents/model-selection-resolve.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../../agents/model-selection-shared.js";
import { resolveProviderUseAdmission } from "../../../agents/provider-model-auth-source-plan.js";
import { resolveResetPreservedSelection } from "../../../config/sessions/reset-preserved-selection.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.js";
import type { ModelProviderConfigInput } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseEnvTemplateSecretRef } from "../../../config/types.secrets.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../../infra/state-migrations.receipts.js";
import {
  resolveProviderAuthLookupMaps,
  resolveProviderBindingEnvVarCandidates,
} from "../../../secrets/provider-env-vars.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { listExistingAgentDatabaseTargets } from "../../doctor-session-sqlite-readers.js";
import { selectedCanonicalModelRefsForRuntimePolicy } from "./legacy-runtime-model-policy.js";

const MIGRATION = "selected-shared-provider-bindings:v1";
const DEFERRED =
  'Could not read provider upgrade state; shared-key bindings were left unchanged. Rerun "openclaw doctor --fix".';

/** Preserve selected shared-key routes once; ordinary runtime selection never creates bindings. */
export async function prepareProviderUseBindingMigration(params: {
  config: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  config: OpenClawConfig;
  changes: string[];
  pending: boolean;
  warnings?: string[];
  unsetPaths?: string[][];
}> {
  const { config, configPath, env } = params;
  const unchanged = { config, changes: [], pending: false };
  // Doctor retains invalid source values until its config validation step.
  const envProvider: unknown = config.secrets?.defaults?.env;
  if (envProvider !== undefined && typeof envProvider !== "string") {
    return unchanged;
  }
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION, configPath);
  const sessionSelections: Array<{ agentId: string; model: string }> = [];
  let direct: Record<string, readonly string[]>;
  let envCandidateMap: Readonly<Record<string, readonly string[]>>;
  let aliasMap: Readonly<Record<string, string>>;
  const authScopes = new Map<string, { agentDir: string; store: AuthProfileStore }>();
  const localAccounts: Array<CandidateAuthProfileStore & { store: AuthProfileStore }> = [];
  // Receipts and session pins are external state. A failed read must not turn an
  // incomplete selection snapshot into a completed upgrade or prevent startup.
  try {
    const completed = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readLegacyMigrationReceiptFromDatabase(db, sourceKey),
      { env },
    );
    if (completed) {
      return unchanged;
    }
    for (const candidate of await listCandidateAuthProfileStores({ cfg: config, env })) {
      const store = loadCandidateAuthProfileStore(candidate);
      if (store) {
        localAccounts.push({ ...candidate, store });
      }
    }
    let incompletePins = false;
    for (const target of listExistingAgentDatabaseTargets(config, env)) {
      scanDoctorSessionEntriesTolerant(
        { agentId: target.agentId, storePath: target.storePath, env },
        ({ entry, recoveredFromProjections }) => {
          if (recoveredFromProjections) {
            incompletePins = true;
            return;
          }
          const pin = resolveResetPreservedSelection({ entry });
          if (typeof pin.modelOverride === "string") {
            sessionSelections.push({
              agentId: target.agentId,
              model:
                pin.providerOverride && !pin.modelOverride.startsWith(`${pin.providerOverride}/`)
                  ? `${pin.providerOverride}/${pin.modelOverride}`
                  : pin.modelOverride,
            });
          }
        },
      );
    }
    if (incompletePins) {
      return { ...unchanged, warnings: [DEFERRED] };
    }
    for (const agentId of new Set([
      ...listAgentIds(config),
      ...sessionSelections.map((selection) => selection.agentId),
    ])) {
      const agentDir = resolveAgentDir(config, agentId, env);
      authScopes.set(agentId, {
        agentDir,
        store: loadAuthProfileStoreForRuntime(
          agentDir,
          {
            config,
            readOnly: true,
            allowKeychainPrompt: false,
          },
          env,
        ),
      });
    }
    direct = resolveProviderBindingEnvVarCandidates({ config, env });
    ({ envCandidateMap, aliasMap } = resolveProviderAuthLookupMaps({
      config,
      env,
      includeUntrustedWorkspacePlugins: false,
    }));
  } catch {
    return { ...unchanged, warnings: [DEFERRED] };
  }
  if (config.models !== undefined && !isRecord(config.models)) {
    return unchanged;
  }
  if (config.models?.providers !== undefined && !isRecord(config.models.providers)) {
    return unchanged;
  }
  const selectedProviders = new Map<string, Set<string>>();
  for (const agentId of authScopes.keys()) {
    const selected = new Set<string>();
    selectedProviders.set(agentId, selected);
    const selection = {
      cfg: config,
      agentId,
      allowManifestNormalization: false,
      allowPluginNormalization: false,
    };
    const primary = resolveDefaultModelForAgent(selection);
    const rawPrimary = resolveAgentEffectiveModelPrimary(config, agentId);
    if (rawPrimary) {
      selected.add(normalizeProviderId(primary.provider));
    }
    const aliasIndex = buildModelAliasIndex({
      ...selection,
      defaultProvider: primary.provider,
    });
    for (const raw of resolveConfiguredModelFallbacks(selection)) {
      if (typeof raw !== "string") {
        continue;
      }
      const resolved = resolveModelRefFromString({
        ...selection,
        raw,
        defaultProvider: primary.provider,
        aliasIndex,
      });
      if (resolved) {
        selected.add(normalizeProviderId(resolved.ref.provider));
      }
    }
  }
  const manifestVariables = new Set(Object.values(direct).flat());
  const admissions = new Map(
    [...authScopes].map(([agentId, { store }]) => [
      agentId,
      resolveProviderUseAdmission({
        config,
        env,
        providerEnvVars: direct,
        profiles: store.profiles,
      }),
    ]),
  );
  const accountBindings = localAccounts.map((scope) => ({
    agentId: scope.agentId,
    admitted: resolveProviderUseAdmission({ profiles: scope.store.profiles }),
  }));
  const providers: Record<string, ModelProviderConfigInput> = {};
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const [identity, candidates] of Object.entries(envCandidateMap)) {
    const provider = normalizeProviderId(identity);
    const missingAgents = [...selectedProviders]
      .filter(
        ([agentId, selected]) =>
          !admissions.get(agentId)?.has(provider) &&
          (selected.has(provider) ||
            sessionSelections.some(
              (selection) =>
                selection.agentId === agentId &&
                selectedCanonicalModelRefsForRuntimePolicy(selection.model, provider).length > 0,
            )),
      )
      .map(([agentId]) => agentId);
    if (
      (!Object.hasOwn(direct, identity) && !Object.hasOwn(aliasMap, identity)) ||
      missingAgents.length === 0
    ) {
      continue;
    }
    const variable = candidates.find(
      (name) =>
        manifestVariables.has(name) &&
        // The admission owner excludes generic credentials even if a manifest names one.
        resolveProviderUseAdmission({ env, providerEnvVars: { [provider]: [name] } }).has(
          provider,
        ) &&
        Object.entries(envCandidateMap).some(
          ([sibling, names]) => normalizeProviderId(sibling) !== provider && names.includes(name),
        ),
    );
    const apiKey = variable ? parseEnvTemplateSecretRef(`\${${variable}}`, envProvider) : null;
    if (!apiKey) {
      continue;
    }
    const accountOwners = [
      ...new Set(
        accountBindings
          .filter((scope) => scope.admitted.has(provider))
          .map((scope) => scope.agentId),
      ),
    ];
    if (accountOwners.length > 0) {
      warnings.push(
        `Provider ${provider} was not migrated for agents ${missingAgents.join(", ")}: a global env binding would replace an existing account for agents ${accountOwners.join(", ")}. Configure the missing agents explicitly, then rerun "openclaw doctor --fix".`,
      );
      continue;
    }
    providers[provider] = { apiKey };
    changes.push(`Bound selected provider ${provider} to ${variable} with an env SecretRef.`);
  }
  if (changes.length === 0) {
    return {
      ...unchanged,
      pending: warnings.length === 0,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  const validated = validateConfigObjectRaw({ models: { providers } }, { env });
  if (!validated.ok) {
    return {
      ...unchanged,
      warnings: ["Could not validate shared-key provider bindings; config was left unchanged."],
    };
  }
  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: { ...config.models?.providers, ...validated.config.models?.providers },
      },
    },
    changes,
    pending: warnings.length === 0,
    ...(warnings.length ? { warnings } : {}),
    // Doctor consumes materialized config; its writer preserves the sparse source overlay.
    unsetPaths: Object.keys(providers).flatMap((provider) =>
      ["baseUrl", "models"].map((field) => ["models", "providers", provider, field]),
    ),
  };
}

/** A successful Doctor write closes the upgrade window, including an empty selection. */
export function completeProviderUseBindingMigration(
  configPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION, configPath);
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        if (readLegacyMigrationReceiptFromDatabase(db, sourceKey)) {
          return;
        }
        recordLegacyMigrationReceipt(db, {
          sourceKey,
          migrationKind: MIGRATION,
          sourcePath: configPath,
          targetTable: "migration_sources",
          sourceSha256: null,
          sourceSizeBytes: null,
          sourceRecordCount: null,
          runId: sourceKey,
          now: Date.now(),
          reportJson: JSON.stringify({ completed: true, target: "models.providers" }),
        });
      },
      { env },
    );
    return [];
  } catch {
    return ['Could not record the shared-key provider upgrade; rerun "openclaw doctor --fix".'];
  }
}
