import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  classifyGatewayProbePath,
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  resolveGatewayPort,
} from "openclaw/plugin-sdk/gateway-config-runtime";
import { listFeishuAccountIds, resolveFeishuAccount } from "./accounts.js";
import { DEFAULT_FEISHU_WEBHOOK_PATH, normalizeFeishuWebhookPath } from "./webhook-path.js";

export function describeFeishuWebhookPathConflict(path: string): string | undefined {
  const normalized = normalizeFeishuWebhookPath(path);
  if (!normalized) {
    return;
  }
  const pathname = new URL(normalized, "http://localhost").pathname;
  const probe = classifyGatewayProbePath(pathname);
  let reason: string;
  if (probe !== "outside" && probe !== "namespace") {
    reason = "is reserved for Gateway probes";
  } else if (isProtectedPluginRoutePathFromContext(resolvePluginRoutePathContext(pathname))) {
    reason = "requires Gateway authentication";
  } else {
    return;
  }
  return `webhookPath ${JSON.stringify(path)} ${reason}. Set webhookPath to ${DEFAULT_FEISHU_WEBHOOK_PATH} and update the Feishu callback URL or reverse-proxy path to match.`;
}

export const collectFeishuWebhookWarnings: NonNullable<
  ChannelDoctorAdapter["collectPreviewWarnings"]
> = ({ cfg, env }) =>
  listFeishuAccountIds(cfg).flatMap((accountId) => {
    const account = resolveFeishuAccount({ cfg, accountId });
    if (account.config.connectionMode !== "webhook") {
      return [];
    }
    const route = account.config.webhookPath ?? DEFAULT_FEISHU_WEBHOOK_PATH;
    const pathConflict = describeFeishuWebhookPathConflict(route);
    if (pathConflict) {
      return [
        `Feishu account "${accountId}" ${pathConflict} ${account.config.legacyWebhook ? "The configured legacyWebhook listener keeps the old path working. Move webhookPath and the callback or proxy before deleting legacyWebhook." : "Webhook startup is blocked until the path is changed."} Use Gateway port ${resolveGatewayPort(cfg, env)}.`,
      ];
    }
    const upstream = `Gateway port ${resolveGatewayPort(cfg, env)}, path ${route}`;
    return [
      `Feishu account "${accountId}" uses ${upstream}. Point the Feishu callback URL or reverse-proxy upstream there; accounts sharing a path need distinct encrypt keys. ${account.config.legacyWebhook ? `The explicitly configured legacy listener on ${account.config.legacyWebhook.host ?? "127.0.0.1"}:${account.config.legacyWebhook.port} forwards into that same route. Remove legacyWebhook after updating the upstream; retirement is planned after a two-month migration window with no automatic cutoff.` : "No separate webhook listener is opened; the former default port 3000 is no longer used."}`,
    ];
  });
