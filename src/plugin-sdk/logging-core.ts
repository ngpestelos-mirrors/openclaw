/**
 * Public SDK subpath for logging, diagnostics, and redaction helpers.
 */
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  startDiagnosticHeartbeat as startOwnedDiagnosticHeartbeat,
  stopDiagnosticHeartbeat as stopOwnedDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { getBoundLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";

let standaloneDiagnosticScheduler: GatewayScheduler | undefined;

/** Standalone SDK callers own this schedule; Gateway plugins use their bound host. */
export function startDiagnosticHeartbeat(
  config?: Parameters<typeof startOwnedDiagnosticHeartbeat>[1],
  opts?: Parameters<typeof startOwnedDiagnosticHeartbeat>[2],
): void {
  const host = getBoundLegacyPluginSdkResourceHost();
  const scheduler = host
    ? host.scheduler
    : (standaloneDiagnosticScheduler ??= new GatewayScheduler());
  startOwnedDiagnosticHeartbeat(scheduler, config, opts);
}

export function stopDiagnosticHeartbeat(): void {
  stopOwnedDiagnosticHeartbeat();
  const scheduler = standaloneDiagnosticScheduler;
  standaloneDiagnosticScheduler = undefined;
  void scheduler?.stop();
}

export { createSubsystemLogger } from "../logging/subsystem.js";
export {
  getChildLogger,
  type LoggerResolvedSettings,
  type LoggerSettings,
} from "../logging/logger.js";
export { logDebug, logError, logInfo } from "../logger.js";
export { logWebhookError, logWebhookProcessed, logWebhookReceived } from "../logging/diagnostic.js";
export {
  redactSensitiveFieldValue,
  redactSensitiveText,
  redactToolPayloadText,
} from "../logging/redact.js";
export { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
