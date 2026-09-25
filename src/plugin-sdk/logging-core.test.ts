import { expect, it, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  onDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "./logging-core.js";

it("uses the bound Gateway clock and stops only diagnostic work", async () => {
  const previouslyEnabled = areDiagnosticsEnabledForProcess();
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(scheduler);
  const peer = vi.fn();
  const heartbeats: string[] = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    if (event.type === "diagnostic.heartbeat") {
      heartbeats.push(event.type);
    }
  });
  try {
    setDiagnosticsEnabledForProcess(true);
    scheduler.schedule({ id: "peer", delayMs: 30_000, everyMs: 30_000, run: peer });
    host.run(() => startDiagnosticHeartbeat({}, { sampleLiveness: () => null }));
    logWebhookReceived({ channel: "test" });
    await clock.advanceBy(30_000);
    await waitForDiagnosticEventsDrained();
    expect(heartbeats).toHaveLength(1);
    expect(peer).toHaveBeenCalledOnce();

    host.run(stopDiagnosticHeartbeat);
    await clock.advanceBy(30_000);
    await waitForDiagnosticEventsDrained();
    expect(heartbeats).toHaveLength(1);
    expect(peer).toHaveBeenCalledTimes(2);
  } finally {
    stopDiagnosticHeartbeat();
    unsubscribe();
    await host.close();
    await scheduler.stop();
    setDiagnosticsEnabledForProcess(previouslyEnabled);
  }
});
