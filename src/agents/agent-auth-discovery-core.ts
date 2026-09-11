/** Env/config-backed credential discovery shared by agent auth discovery modes. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderBindingEnvVarCandidates } from "../secrets/provider-env-vars.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import { resolveProviderUseAdmission } from "./provider-model-auth-source-plan.js";

/** Options for discovering env-backed credentials during agent auth discovery. */
export type AgentDiscoveryAuthLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

/** Adds provider credentials resolvable from env/config without mutating existing credentials. */
export function addEnvBackedAgentCredentials(
  credentials: AgentCredentialMap,
  options: AgentDiscoveryAuthLookupOptions = {},
): AgentCredentialMap {
  const env = options.env ?? process.env;
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const lookupMaps = resolveProviderEnvAuthLookupMaps(lookupParams);
  const { aliasMap, envCandidateMap: candidateMap, authEvidenceMap } = lookupMaps;
  const next = { ...credentials };
  const admitted = resolveProviderUseAdmission({
    config: options.config,
    env,
    providerEnvVars: resolveProviderBindingEnvVarCandidates(lookupParams),
  });
  for (const [provider, binding] of admitted) {
    if (next[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider, env, {
      config: options.config,
      workspaceDir: options.workspaceDir,
      aliasMap: binding.kind === "environment" ? {} : aliasMap,
      candidateMap:
        binding.kind === "environment" ? { [provider]: [binding.envVar] } : candidateMap,
      authEvidenceMap: binding.kind === "environment" ? {} : authEvidenceMap,
    });
    if (!resolved?.apiKey) {
      continue;
    }
    next[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return next;
}
