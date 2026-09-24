import type { IncomingMessage } from "node:http";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginHttpRouteRegistration } from "./registry-types.js";

type LegacyEndpoint = Readonly<{ port: number; host?: string }>;
const forwardedRequests = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginHttpLegacyListenerRequests"),
  () => new WeakMap<IncomingMessage, LegacyEndpoint>(),
);

/** Host-owned attribution; forwarded headers never select a legacy account endpoint. */
export function markPluginHttpLegacyListener(req: IncomingMessage, endpoint: LegacyEndpoint): void {
  forwardedRequests.set(req, Object.freeze({ ...endpoint }));
}

/** Configured endpoint accepting this request, or undefined on the ordinary Gateway listener. */
export function getWebhookLegacyListener(req: IncomingMessage): LegacyEndpoint | undefined {
  return forwardedRequests.get(req);
}

export function permitsLegacyPluginRoute(
  req: IncomingMessage,
  route: PluginHttpRouteRegistration,
): boolean {
  const endpoint = getWebhookLegacyListener(req);
  return (
    !endpoint ||
    (route.auth === "plugin" &&
      route.legacyListeners?.some(
        (candidate) => candidate.port === endpoint.port && candidate.host === endpoint.host,
      ) === true)
  );
}
