import { classifyGatewayProbePath } from "openclaw/plugin-sdk/webhook-ingress";
import { DEFAULT_FEISHU_WEBHOOK_PATH, normalizeFeishuWebhookPath } from "./webhook-path.js";

export function describeFeishuWebhookPathConflict(path: string): string | undefined {
  const normalized = normalizeFeishuWebhookPath(path);
  if (!normalized) {
    return;
  }
  const probe = classifyGatewayProbePath(new URL(normalized, "http://localhost").pathname);
  if (probe === "outside" || probe === "namespace") {
    return;
  }
  return `webhookPath ${JSON.stringify(path)} is reserved for Gateway probes. Set webhookPath to ${DEFAULT_FEISHU_WEBHOOK_PATH} and update the Feishu callback URL or reverse-proxy path to match.`;
}
