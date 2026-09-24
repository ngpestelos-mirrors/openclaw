import { classifyGatewayProbePath } from "openclaw/plugin-sdk/webhook-ingress";

export const DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH = "/nextcloud-talk-webhook";

export function describeNextcloudTalkWebhookProbeConflict(
  path: string,
  gatewayPort: number,
): string | undefined {
  const pathname = URL.parse(path, "http://localhost")?.pathname ?? path;
  const probe = classifyGatewayProbePath(pathname);
  if (probe === "outside" || probe === "namespace") {
    return undefined;
  }
  return (
    `Webhook path "${path}" is reserved for Gateway probes and cannot receive Nextcloud callbacks on the Gateway port. ` +
    `Set webhookPath to "${DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH}" and update the Nextcloud bot callback and reverse-proxy upstream to Gateway port ${gatewayPort}${DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH}.`
  );
}
