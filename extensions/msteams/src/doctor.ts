import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolveGatewayPort,
  resolvePluginRoutePathContext,
} from "openclaw/plugin-sdk/gateway-config-runtime";

const isMSTeamsMutableAllowEntry = buildMutableAllowEntryDetector({
  prefixes: ["msteams:", "user:"],
  stableIdPattern: /^[^\s@]+$/,
});

export const collectMSTeamsMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "msteams",
    detector: isMSTeamsMutableAllowEntry,
    collectLists: (scope) => collectStandardAllowlistLists(scope),
  });

export function resolveMSTeamsWebhookPathIssue({
  cfg,
  env,
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const channel = cfg.channels?.msteams;
  const path = channel?.webhook?.path ?? "/api/messages";
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  const protectedPath = isProtectedPluginRoutePathFromContext(
    resolvePluginRoutePathContext(pathname),
  );
  const reason = protectedPath
    ? "requires Gateway authentication on the main HTTP listener"
    : probe !== "namespace" && probe !== "outside"
      ? "is reserved for Gateway probes"
      : undefined;
  if (!reason) {
    return undefined;
  }
  return (
    `Microsoft Teams webhook path ${path} ${reason}. ` +
    `Set channels.msteams.webhook.path to /api/messages and update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${resolveGatewayPort(cfg, env)}/api/messages; verify delivery before removing legacyWebhook.` +
    (channel?.legacyWebhook
      ? ` The explicitly configured legacy port ${channel.legacyWebhook.port} continues serving the current path during migration.`
      : " No legacy listener is configured, so this path cannot receive Teams callbacks.")
  );
}

export function collectMSTeamsWebhookWarnings({
  cfg,
  env,
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const channel = cfg.channels?.msteams;
  if (!channel || channel.enabled === false) {
    return [];
  }
  const pathIssue = resolveMSTeamsWebhookPathIssue({ cfg, env });
  if (pathIssue) {
    return [pathIssue];
  }
  const path = channel.webhook?.path ?? "/api/messages";
  const port = resolveGatewayPort(cfg, env);
  const legacy = channel.legacyWebhook;
  return [
    legacy
      ? `Microsoft Teams: legacy port ${legacy.port} forwards to Gateway route ${path}. Update the Azure Bot messaging endpoint or reverse proxy to Gateway port ${port}${path}, verify delivery, then remove channels.msteams.legacyWebhook. Forwarding is planned for removal after the two-month migration window; it has no automatic runtime cutoff.`
      : `Microsoft Teams webhooks use Gateway port ${port}${path}. If Azure Bot or your reverse proxy still targets the former default port 3978, point it to this Gateway route.`,
  ];
}
