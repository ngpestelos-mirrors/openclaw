/**
 * Human-owned authority decisions, not a universal privilege ordering. Compare
 * canonical before/after config, including removals, rather than the write path.
 * Tightening is a decision too; operational neighbors are not permission policy.
 */
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveChannelDmAccess } from "../channels/plugins/dm-access.js";
import type { ConfigMutationAdmission } from "../cli/config-cli-runner.js";
import { resolveChannelGroups } from "../config/channel-groups.js";
import { resolveControlUiAllowedOrigins } from "../config/gateway-control-ui-origins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { ExecToolConfig } from "../config/types.tools.js";
import { resolveControlUiBootstrapPresentation } from "../gateway/control-ui-bootstrap-presentation.js";
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
const CHANNEL_ADMISSION_PATHS = [[], ["accounts", ANY]].flatMap((account) =>
  [...CHANNEL_TOOL_SCOPES, ["groups", ANY, "topics", ANY], ["direct", ANY, "topics", ANY]].flatMap(
    (scope) =>
      [
        "dmPolicy",
        "groupPolicy",
        "allowFrom",
        "groupAllowFrom",
        "users",
        "roles",
        "allowBots",
        "enabled",
      ].map((key) => ["channels", ANY].concat(account, scope, key)),
  ),
);
const PERMISSION_POLICY_PATHS: readonly (readonly string[])[] = [
  ...CHANNEL_TOOL_POLICY_PATHS,
  ...CHANNEL_ADMISSION_PATHS,
  // Nested-only channel owners can retain conflicting legacy top-level fields.
  // Compare their canonical admission fields independently of top-level precedence.
  ...[[], ["accounts", ANY]].flatMap((account) =>
    ["policy", "allowFrom", "enabled", "groupEnabled", "groupChannels"].map((key) =>
      ["channels", ANY].concat(account, "dm", key),
    ),
  ),
  ...[[], ["accounts", ANY]].flatMap((account) =>
    CHANNEL_TOOL_SCOPES.filter((scope) => scope[0] !== "direct" && scope[0] !== "groups").map(
      (scope) => ["channels", ANY].concat(account, scope.slice(0, -1)),
    ),
  ),
  // Matrix still reads the shipped room allow alias; Doctor owns its migration.
  ...[[], ["accounts", ANY]].flatMap((account) =>
    ["groups", "rooms"].map((map) => ["channels", "matrix"].concat(account, map, ANY, "allow")),
  ),
  ["channels", "defaults", "groupPolicy"],
  ["channels", "telegram", "groups"],
  ["channels", "telegram", "accounts", ANY, "groups"],
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
  projectLeaf: (leaf: unknown, resolvedPath: readonly string[]) => unknown = (leaf) => leaf,
  resolvedPath: readonly string[] = [],
): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return projectLeaf(value, resolvedPath);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  if (key !== ANY) {
    return projectPath(value[key], rest, projectLeaf, [...resolvedPath, key]);
  }
  const entries = Object.entries(value).flatMap(([id, child]) => {
    const projected = projectPath(child, rest, projectLeaf, [...resolvedPath, id]);
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
    projectPath(config, path, (value, resolvedPath) => {
      if (["rooms", "channels", "guilds", "teams"].includes(path.at(-1) ?? "")) {
        return value === undefined ? undefined : projectGroupMembership(value, resolvedPath[1]);
      }
      if (path[1] === "matrix" && path.at(-1) === "allow") {
        return value === false ? false : undefined;
      }
      if (path[0] === "channels" && path.at(-1) === "enabled" && path.at(-2) !== "dm") {
        return value === false ? false : undefined;
      }
      if (path[0] === "channels" && path.at(-1) === "tools") {
        return projectToolOverride(value);
      }
      if (path.at(-1) === "toolsBySender" && isRecord(value)) {
        return Object.fromEntries(
          Object.entries(value).map(([sender, policy]) => [sender, projectToolOverride(policy)]),
        );
      }
      if ((path.at(-1) === "direct" || path.at(-1) === "groups") && isRecord(value)) {
        // Telegram admission selects a whole exact chat before its wildcard.
        // Group tool policy separately inherits per field; DM tools do not.
        const wildcard = value["*"];
        const hasAdmission = (entry: unknown) =>
          isRecord(entry) &&
          (entry.enabled === false ||
            ["dmPolicy", "groupPolicy", "allowFrom"].some((key) => entry[key] !== undefined));
        const hasWildcardPolicy =
          isRecord(wildcard) &&
          (hasAdmission(wildcard) ||
            (isRecord(wildcard.topics) && Object.values(wildcard.topics).some(hasAdmission)) ||
            (path.at(-1) === "direct" &&
              (wildcard.tools !== undefined ||
                (isRecord(wildcard.toolsBySender) &&
                  Object.keys(wildcard.toolsBySender).length > 0))));
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

function projectGroupMembership(groups: unknown, channelId?: string) {
  if (!isRecord(groups)) {
    return [];
  }
  const wildcard = groups["*"];
  const hasAdmission = (entry: unknown) =>
    isRecord(entry) &&
    (entry.enabled === false ||
      (channelId === "matrix" && entry.allow === false) ||
      [
        "dmPolicy",
        "groupPolicy",
        "allowFrom",
        "groupAllowFrom",
        "users",
        "roles",
        "allowBots",
      ].some((key) => entry[key] !== undefined));
  const hasTools = (entry: unknown) =>
    isRecord(entry) && (entry.tools !== undefined || entry.toolsBySender !== undefined);
  const hidesWildcardPolicy =
    isRecord(wildcard) &&
    (hasAdmission(wildcard) ||
      ((channelId === "matrix" || channelId === "discord") && hasTools(wildcard)) ||
      (isRecord(wildcard.topics) && Object.values(wildcard.topics).some(hasAdmission)) ||
      ["channels", "guilds", "teams", "rooms", "groups"].some((key) => {
        const children = wildcard[key];
        return (
          isRecord(children) &&
          ((!Object.hasOwn(children, "*") && Object.keys(children).length > 0) ||
            Object.values(children).some((entry) => hasAdmission(entry) || hasTools(entry)))
        );
      }));
  // Slack inherits wildcard fields; Discord/Matrix select whole entries.
  // Telegram group tools inherit separately, unlike its admission fields.
  return Object.hasOwn(groups, "*") && (channelId === "slack" || !hidesWildcardPolicy)
    ? ["*"]
    : Object.keys(groups).toSorted();
}

function projectChannelAdmission(config: OpenClawConfig, channelIds: readonly string[]) {
  return Object.fromEntries(
    channelIds.map((id) => {
      const value: unknown = config.channels?.[id];
      const root = isRecord(value) ? value : {};
      // Common root schemas materialize pairing/allowlist; account leaves inherit.
      // Comparing the same channel ids on both sides keeps token-only setup automatic.
      const rootPolicy = {
        ...resolveChannelDmAccess({ account: root, defaultPolicy: "pairing" }),
        groupPolicy: root.groupPolicy ?? config.channels?.defaults?.groupPolicy ?? "allowlist",
        groupAllowFrom: root.groupAllowFrom,
        allowlistOnly: root.allowlistOnly === true,
        allowBots: root.allowBots ?? false,
        nameMatching: root.dangerouslyAllowNameMatching === true,
        groupMembers: projectGroupMembership(root.groups ?? root.rooms, id),
      };
      const accounts = isRecord(root.accounts) ? root.accounts : {};
      return [
        id,
        {
          ...rootPolicy,
          accounts: Object.fromEntries(
            Object.entries(accounts).flatMap(([accountId, account]) => {
              if (!isRecord(account)) {
                return [];
              }
              const policy = {
                ...resolveChannelDmAccess({ account, parent: root, defaultPolicy: "pairing" }),
                groupPolicy: account.groupPolicy ?? rootPolicy.groupPolicy,
                groupAllowFrom: account.groupAllowFrom ?? rootPolicy.groupAllowFrom,
                allowlistOnly: Object.hasOwn(account, "allowlistOnly")
                  ? account.allowlistOnly === true
                  : rootPolicy.allowlistOnly,
                allowBots: Object.hasOwn(account, "allowBots")
                  ? (account.allowBots ?? false)
                  : rootPolicy.allowBots,
                nameMatching: Object.hasOwn(account, "dangerouslyAllowNameMatching")
                  ? account.dangerouslyAllowNameMatching === true
                  : rootPolicy.nameMatching,
                groupMembers: projectGroupMembership(
                  resolveChannelGroups(config, id, accountId) ?? account.rooms ?? root.rooms,
                  id,
                ),
              };
              return isDeepStrictEqual(policy, rootPolicy) ? [] : [[accountId, policy]];
            }),
          ),
        },
      ];
    }),
  );
}

function projectPermissionPolicy(config: OpenClawConfig, channelIds: readonly string[]) {
  const defaults = projectScopedPolicy(config);
  const { embedSandbox, allowExternalEmbedUrls } = resolveControlUiBootstrapPresentation(config);
  // Channel model routing is metadata, not a channel account or admission map.
  const { modelByChannel: _modelByChannel, ...channels } = config.channels ?? {};
  const policyConfig = { ...config, channels };
  return {
    paths: PERMISSION_POLICY_PATHS.map((path) => projectPermissionPath(policyConfig, path)),
    defaults,
    channelAdmission: projectChannelAdmission(config, channelIds),
    allowRealIpFallback: config.gateway?.allowRealIpFallback ?? false,
    browserAuthority: {
      embedSandbox,
      allowExternalEmbedUrls,
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
  const channelIds = [
    ...new Set([...Object.keys(before.channels ?? {}), ...Object.keys(after.channels ?? {})]),
  ].filter((id) => id !== "defaults" && id !== "modelByChannel");
  return !isDeepStrictEqual(
    projectPermissionPolicy(before, channelIds),
    projectPermissionPolicy(after, channelIds),
  );
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
