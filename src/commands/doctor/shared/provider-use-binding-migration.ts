import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ensureAuthProfileStore } from "../../../agents/auth-profiles.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../../../agents/auth-profiles/candidate-stores.js";
import { loadPersistedSharedAuthProfileStore } from "../../../agents/auth-profiles/persisted.js";
import { resolveProviderUseAdmission } from "../../../agents/provider-model-auth-source-plan.js";
import { resolveResetPreservedSelection } from "../../../config/sessions/reset-preserved-selection.js";
import { scanDoctorSessionEntriesTolerant } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { parseEnvTemplateSecretRef } from "../../../config/types.secrets.js";
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
}): Promise<{ config: OpenClawConfig; changes: string[]; pending: boolean; warnings?: string[] }> {
  const { config, configPath, env } = params;
  const unchanged = { config, changes: [], pending: false };
  // Doctor retains invalid source values until its config validation step.
  const envProvider: unknown = config.secrets?.defaults?.env;
  if (envProvider !== undefined && typeof envProvider !== "string") {
    return unchanged;
  }
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION, configPath);
  const selections: unknown[] = [config.agents?.defaults?.model];
  let direct: Record<string, readonly string[]>;
  let envCandidateMap: Readonly<Record<string, readonly string[]>>;
  let aliasMap: Readonly<Record<string, string>>;
  const profiles: Record<string, { provider: string }> = {};
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
    const stores = [
      loadPersistedSharedAuthProfileStore(env),
      ensureAuthProfileStore(undefined, {
        config,
        readOnly: true,
        allowKeychainPrompt: false,
      }),
    ];
    for (const candidate of await listCandidateAuthProfileStores({ cfg: config, env })) {
      stores.push(loadCandidateAuthProfileStore(candidate));
    }
    for (const store of stores) {
      for (const profile of Object.values(store?.profiles ?? {})) {
        profiles[profile.provider] = { provider: profile.provider };
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
            selections.push(
              pin.providerOverride && !pin.modelOverride.startsWith(`${pin.providerOverride}/`)
                ? `${pin.providerOverride}/${pin.modelOverride}`
                : pin.modelOverride,
            );
          }
        },
      );
    }
    if (incompletePins) {
      return { ...unchanged, warnings: [DEFERRED] };
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
  const agents = config.agents;
  const roster = isRecord(agents?.entries)
    ? Object.values(agents.entries)
    : Array.isArray(agents?.list)
      ? agents.list
      : [];
  for (const agent of roster) {
    if (isRecord(agent)) {
      selections.push(agent.model);
    }
  }
  if (config.models !== undefined && !isRecord(config.models)) {
    return unchanged;
  }
  if (config.models?.providers !== undefined && !isRecord(config.models.providers)) {
    return unchanged;
  }
  const manifestVariables = new Set(Object.values(direct).flat());
  const admitted = resolveProviderUseAdmission({ config, env, providerEnvVars: direct, profiles });
  const providers = { ...config.models?.providers };
  const changes: string[] = [];
  for (const [identity, candidates] of Object.entries(envCandidateMap)) {
    const provider = normalizeProviderId(identity);
    if (
      (!Object.hasOwn(direct, identity) && !Object.hasOwn(aliasMap, identity)) ||
      admitted.has(provider) ||
      !selections.some(
        (model) => selectedCanonicalModelRefsForRuntimePolicy(model, provider).length > 0,
      )
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
    providers[provider] = { apiKey, baseUrl: "", models: [] };
    changes.push(`Bound selected provider ${provider} to ${variable} with an env SecretRef.`);
  }
  return {
    config: changes.length ? { ...config, models: { ...config.models, providers } } : config,
    changes,
    pending: true,
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
