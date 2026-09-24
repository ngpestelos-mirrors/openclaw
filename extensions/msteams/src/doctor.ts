import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { classifyGatewayProbePath } from "openclaw/plugin-sdk/webhook-ingress";

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
  const probe = classifyGatewayProbePath(URL.parse(path, "http://localhost")?.pathname ?? path);
  if (probe === "namespace" || probe === "outside") {
    return undefined;
  }
  return (
    `Microsoft Teams webhook path ${path} is reserved for Gateway probes. ` +
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
