/**
 * Human-owned authority decisions, not a universal privilege ordering. Compare
 * canonical before/after config, including removals, rather than the write path.
 * Tightening is a decision too; operational neighbors are not permission policy.
 */
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { ConfigMutationAdmission } from "../cli/config-cli-runner.js";
import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { ExecToolConfig } from "../config/types.tools.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { secretRefKey } from "../secrets/ref-contract.js";

const TOOL_POLICY_KEYS = [
  "profile",
  "allow",
  "alsoAllow",
  "deny",
  "byProvider",
  "toolsBySender",
  "elevated",
] as const;
const ANY = "*";
// Channel schemas own these conversation maps (including account overrides).
// Project only their tool-policy fields, not prompts, delivery settings or tokens.
// Telegram topics do not accept tools; validation rejects those paths upstream.
const CHANNEL_TOOL_SCOPES = [
  ["groups", ANY],
  ["direct", ANY],
  ["channels", ANY],
  ["rooms", ANY],
  ["guilds", ANY],
  ["guilds", ANY, "channels", ANY],
  ["teams", ANY],
  ["teams", ANY, "channels", ANY],
] as const;
const CHANNEL_TOOL_POLICY_PATHS = [[], ["accounts", ANY]].flatMap((account) =>
  CHANNEL_TOOL_SCOPES.flatMap((scope) =>
    ["tools", "toolsBySender"].map((key) => ["channels", ANY].concat(account, scope, key)),
  ),
);
const PERMISSION_POLICY_PATHS: readonly (readonly string[])[] = [
  ...CHANNEL_TOOL_POLICY_PATHS,
  ["channels", "telegram", "direct"],
  ["channels", "telegram", "accounts", ANY, "direct"],
  ["approvals"],
  ["security"],
  ["commands", "ownerAllowFrom"],
  ["commands", "allowFrom"],
  ...TOOL_POLICY_KEYS.map((key) => ["tools", key]),
  ["tools", "subagents", "tools"],
  ...TOOL_POLICY_KEYS.map((key) => ["agents", "entries", ANY, "tools", key]),
  ["channels", ANY, "execApprovals"],
  ["channels", ANY, "accounts", ANY, "execApprovals"],
  ["skills", "workshop", "approvalPolicy"],
  // Inbound credentials decide who can authenticate; unlike outgoing API keys,
  // rotating them is an authority change, including when supplied as SecretRefs.
  ["gateway", "auth"],
  ["gateway", "roles"],
  ["gateway", "tools"],
  ["gateway", "trustedProxies"],
  ["gateway", "nodes"],
];

function projectPath(
  value: unknown,
  path: readonly string[],
  projectLeaf: (leaf: unknown) => unknown = (leaf) => leaf,
): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return projectLeaf(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (key !== ANY) {
    return projectPath(value[key], rest, projectLeaf);
  }
  const entries = Object.entries(value).flatMap(([id, child]) => {
    const projected = projectPath(child, rest, projectLeaf);
    return projected === undefined ? [] : [[id, projected]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// Empty containers do not author policy. Arrays remain significant: an empty
// allowlist is not interchangeable with an absent one for every policy owner.
function compactPolicy(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const entries = Object.entries(value).flatMap(([key, child]) => {
    const compact = compactPolicy(child);
    return compact === undefined ? [] : [[key, compact]];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// An explicit empty tool override can shadow a restrictive group or wildcard
// sender policy. Preserve it as a comparison sentinel, not an empty container.
function projectToolOverride(value: unknown): unknown {
  return value === undefined ? undefined : (compactPolicy(value) ?? null);
}

function projectPermissionPath(config: OpenClawConfig, path: readonly string[]) {
  return compactPolicy(
    projectPath(config, path, (value) => {
      if (path[0] === "channels" && path.at(-1) === "tools") {
        return projectToolOverride(value);
      }
      if (path.at(-1) === "toolsBySender" && isRecord(value)) {
        return Object.fromEntries(
          Object.entries(value).map(([sender, policy]) => [sender, projectToolOverride(policy)]),
        );
      }
      if (path.at(-1) === "direct" && isRecord(value)) {
        // Telegram selects a whole exact DM entry before resolving tools. Even a
        // prompt-only entry can hide the wildcard's tool restrictions.
        const wildcard = value["*"];
        const hasWildcardPolicy =
          isRecord(wildcard) &&
          (wildcard.tools !== undefined ||
            (isRecord(wildcard.toolsBySender) && Object.keys(wildcard.toolsBySender).length > 0));
        return hasWildcardPolicy ? Object.keys(value).toSorted() : undefined;
      }
      return value;
    }),
  );
}

function projectExec(global?: ExecToolConfig, local?: ExecToolConfig) {
  const policy = applyExecPolicyLayer(applyExecPolicyLayer({}, global), local);
  return {
    // Keep unresolved host-policy defaults unresolved: absent security can inherit
    // host approval floors or sandbox deny, so it is not synonymous with full.
    security: policy.security,
    ask: policy.ask,
    autoReview: policy.mode === "auto",
    host: local?.host ?? global?.host ?? "auto",
    node: local?.node ?? global?.node,
    pathPrepend: local?.pathPrepend ?? global?.pathPrepend,
    safeBins: local?.safeBins ?? global?.safeBins,
    strictInlineEval: local?.strictInlineEval ?? global?.strictInlineEval,
    grantExpiryDays: local?.grantExpiryDays ?? global?.grantExpiryDays,
    safeBinTrustedDirs: local?.safeBinTrustedDirs ?? global?.safeBinTrustedDirs,
    safeBinProfiles: { ...global?.safeBinProfiles, ...local?.safeBinProfiles },
    reviewer: local?.reviewer ?? global?.reviewer,
    applyPatch: local?.applyPatch ?? global?.applyPatch,
  };
}

function projectSandbox(config: OpenClawConfig, agentId?: string) {
  const {
    prune: _prune,
    dockerTmpfsSource: _source,
    ...policy
  } = resolveSandboxConfigForAgent(config, agentId);
  const global = config.agents?.defaults?.sandbox;
  const local = agentId ? config.agents?.entries?.[agentId]?.sandbox : undefined;
  // Runtime sandbox resolution expects materialized SSH secrets. Retain source
  // refs here too: changing remote credentials is itself an authority decision.
  const ssh = policy.scope === "shared" ? global?.ssh : { ...global?.ssh, ...local?.ssh };
  return {
    ...policy,
    sshCredentials: [ssh?.identityData, ssh?.certificateData, ssh?.knownHostsData],
    sessionToolsVisibility:
      (agentId ? config.agents?.entries?.[agentId]?.sandbox?.sessionToolsVisibility : undefined) ??
      config.agents?.defaults?.sandbox?.sessionToolsVisibility ??
      "spawned",
  };
}

function projectScopedPolicy(config: OpenClawConfig, agentId?: string) {
  const tools = agentId ? config.agents?.entries?.[agentId]?.tools : undefined;
  return {
    exec: projectExec(config.tools?.exec, tools?.exec),
    fs: tools?.fs?.workspaceOnly ?? config.tools?.fs?.workspaceOnly ?? false,
    sandbox: projectSandbox(config, agentId),
  };
}

function projectCredentialDependencies(config: OpenClawConfig) {
  const ssh = [
    config.agents?.defaults?.sandbox?.ssh,
    ...Object.values(config.agents?.entries ?? {}).map((agent) => agent.sandbox?.ssh),
  ];
  const values = [
    config.gateway?.auth?.token,
    config.gateway?.auth?.password,
    ...ssh.flatMap((entry) => [entry?.identityData, entry?.certificateData, entry?.knownHostsData]),
  ];
  return Object.fromEntries(
    values.flatMap((value) => {
      const ref = coerceSecretRef(value, config.secrets?.defaults);
      return ref
        ? [
            [
              secretRefKey(ref),
              {
                provider: config.secrets?.providers?.[ref.provider],
                env:
                  ref.source === "env"
                    ? (config.env?.vars?.[ref.id] ?? config.env?.[ref.id])
                    : undefined,
              },
            ],
          ]
        : [];
    }),
  );
}

function projectPermissionPolicy(config: OpenClawConfig) {
  const defaults = projectScopedPolicy(config);
  return {
    paths: PERMISSION_POLICY_PATHS.map((path) => projectPermissionPath(config, path)),
    defaults,
    allowRealIpFallback: config.gateway?.allowRealIpFallback ?? false,
    browserOrigins: {
      allowedOrigins: resolveControlUiAllowedOrigins(config),
      hostHeaderFallback:
        config.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback ?? false,
    },
    // A protected reference can change meaning without changing its path/ref id.
    // Compare only its configured provider/env inputs, never resolve a secret or
    // execute a provider just to decide whether human approval is necessary.
    credentials: projectCredentialDependencies(config),
    agents: Object.fromEntries(
      Object.keys(config.agents?.entries ?? {}).flatMap((id) => {
        const policy = projectScopedPolicy(config, id);
        // An ordinary roster/name/model edit must not create a spurious policy delta.
        return isDeepStrictEqual(policy, defaults) ? [] : [[id, policy]];
      }),
    ),
  };
}

/** Only validated config may enter this comparison; invalid input is not an exemption. */
export function changesPermissionPolicy(before: OpenClawConfig, after: OpenClawConfig): boolean {
  return !isDeepStrictEqual(projectPermissionPolicy(before), projectPermissionPolicy(after));
}

/** Re-evaluate the actual write snapshot: a stale no-op must not restore old authority. */
export const admitUnchangedPermissionPolicy: ConfigMutationAdmission = ({ before, after }) => {
  if (changesPermissionPolicy(before, after)) {
    throw new Error(
      "Permission policy changed while preparing this automatic config write. No settings were saved. Retry the proposal so the user can review the current change.",
    );
  }
  return true;
};
