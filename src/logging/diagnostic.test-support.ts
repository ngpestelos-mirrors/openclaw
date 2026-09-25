import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startDiagnosticHeartbeat } from "./diagnostic.js";

export function startDiagnosticHeartbeatForTest(
  config?: Parameters<typeof startDiagnosticHeartbeat>[1],
  opts?: Parameters<typeof startDiagnosticHeartbeat>[2],
) {
  return startDiagnosticHeartbeat(createTestGatewayScheduler("fake-timers"), config, {
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    ...opts,
  });
}

export function startEnabledDiagnosticHeartbeatForTest(
  opts?: Parameters<typeof startDiagnosticHeartbeat>[2],
) {
  return startDiagnosticHeartbeatForTest({ diagnostics: { enabled: true } }, opts);
}

type DiagnosticTestApi = {
  resetDiagnosticStateForTest(): void;
  resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number;
  resolveStuckSessionWarnMs(): number;
};

function getTestApi(): DiagnosticTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.diagnosticTestApi")
  ] as DiagnosticTestApi;
}

export function resetDiagnosticStateForTest(): void {
  getTestApi().resetDiagnosticStateForTest();
}

export function resolveStuckSessionAbortMs(stuckSessionWarnMs: number): number {
  return getTestApi().resolveStuckSessionAbortMs(stuckSessionWarnMs);
}

export function resolveStuckSessionWarnMs(): number {
  return getTestApi().resolveStuckSessionWarnMs();
}
