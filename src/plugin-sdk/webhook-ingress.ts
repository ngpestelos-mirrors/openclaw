/**
 * Public SDK subpath for webhook ingress guards, targets, and request helpers.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayAuthRateLimitConfig } from "../config/types.gateway.js";
import {
  createGatewayAuthRateLimiter,
  type AuthRateLimiter,
  type RateLimitConfig,
} from "../gateway/auth-rate-limit.js";
import { resolveRequestClientIpFromHeaders } from "../gateway/net.js";
import { getBoundLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";

export {
  createBoundedCounter,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_ANOMALY_STATUS_CODES,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type BoundedCounter,
  type FixedWindowRateLimiter,
  type WebhookAnomalyTracker,
} from "./webhook-memory-guards.js";
export {
  applyBasicWebhookRequestGuards,
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  isJsonContentType,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  readJsonWebhookBodyOrReject,
  readWebhookBodyOrReject,
  requestBodyErrorToText,
  WEBHOOK_BODY_READ_DEFAULTS,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  type WebhookBodyReadProfile,
  type WebhookInFlightLimiter,
} from "./webhook-request-guards.js";
export {
  canonicalizeWebhookRouteKey,
  registerPluginHttpRoute,
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  resolveSingleWebhookTarget,
  resolveSingleWebhookTargetAsync,
  normalizeWebhookPath,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrReject,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
  withResolvedWebhookRequestPipeline,
  type RegisterWebhookPluginRouteOptions,
  type RegisterWebhookTargetOptions,
  type RegisteredWebhookTarget,
  type WebhookTargetMatchResult,
} from "./webhook-targets.js";
export function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
  allowRealIpFallback = false,
): string | undefined {
  // The Gateway validates managed ingress before plugin dispatch; raw requests remain fallback.
  return (
    getPluginRuntimeGatewayRequestScope()?.client?.clientIp ??
    resolveRequestClientIpFromHeaders(req, trustedProxies, allowRealIpFallback)
  );
}
export function createAuthRateLimiter(config?: RateLimitConfig): AuthRateLimiter & {
  updateConfig: (config?: GatewayAuthRateLimitConfig) => void;
} {
  const host = getBoundLegacyPluginSdkResourceHost();
  host?.assertOpen();
  return createGatewayAuthRateLimiter(config, {
    scheduler: host?.scheduler,
    id: `auth/sdk:${randomUUID()}`,
  });
}
export type { AuthRateLimiter, RateLimitConfig } from "../gateway/auth-rate-limit.js";
export { rawDataToString } from "../infra/ws.js";
export { normalizePluginHttpPath } from "../plugins/http-path.js";
export { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "../infra/http-body.js";
