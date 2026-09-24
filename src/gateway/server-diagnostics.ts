import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  configureDiagnosticHeartbeatScheduler,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "../logging/diagnostic.js";
import { resolveQaDiagnosticHeartbeatTimings } from "./server-qa-diagnostic-timings.js";
import type { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";

export function createGatewayDiagnostics(params: {
  scheduler: GatewayScheduler;
  isClosing: () => boolean;
  eventLoopHealth: ReturnType<typeof createGatewayEventLoopHealthMonitor>;
}) {
  stopDiagnosticHeartbeat();
  configureDiagnosticHeartbeatScheduler(params.scheduler);
  const configureDiagnostics = (config: OpenClawConfig) => {
    if (params.isClosing()) {
      return;
    }
    const enabled = isDiagnosticsEnabled(config);
    setDiagnosticsEnabledForProcess(enabled);
    if (!enabled) {
      stopDiagnosticHeartbeat();
      return;
    }
    // Gateway lifecycle owns both this heartbeat job and the monitor
    // it samples, so startup failure and normal close tear them down together.
    startDiagnosticHeartbeat(undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
      testTimings: resolveQaDiagnosticHeartbeatTimings(process.env),
      sampleLiveness: () => {
        const sample = params.eventLoopHealth.persistentDegradationSnapshot();
        if (!sample || sample.degradedSinceMs == null) {
          return null;
        }
        return {
          reasons: sample.reasons,
          intervalMs: sample.intervalMs,
          degradedSinceMs: sample.degradedSinceMs,
          eventLoopDelayP99Ms: sample.delayP99Ms,
          eventLoopDelayMaxMs: sample.delayMaxMs,
          eventLoopUtilization: sample.utilization,
          cpuCoreRatio: sample.cpuCoreRatio,
        };
      },
    });
  };
  return configureDiagnostics;
}
