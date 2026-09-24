import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
): Promise<void> {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

describe("gateway tool-event recipient maintenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prunes idle tool-event recipients while preserving grace and registered run state", async () => {
    const clock = createGatewaySchedulerClock(Date.parse("2026-03-22T00:00:00Z"));
    vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
    const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
    const deps = {
      ...createGatewayMaintenanceStateForTest(),
      scheduler: new GatewayScheduler({ clock: clock.clock }),
      logHealth: { info: vi.fn(), error: vi.fn() },
      runWorktreeGc: async () => undefined,
      runDeliveryQueueMediaGc: async () => undefined,
      runManagedOutgoingMediaGc: async () => undefined,
    };
    const { toolEventRecipients, registry, runs } = deps.chatRunState;
    toolEventRecipients.add("active-expired", "conn-active");
    toolEventRecipients.add("registered-expired", "conn-registered");
    registry.add("registered-expired", { sessionKey: "session-1", clientRunId: "client-1" });

    await clock.advanceBy(9 * 60_000 + 2_000);
    const timers = startGatewayMaintenanceTimers(deps);
    try {
      await clock.advanceBy(29_000);
      toolEventRecipients.add("finalized-expired", "conn-final");
      toolEventRecipients.markFinal("finalized-expired");
      toolEventRecipients.add("recent", "conn-recent");
      await clock.advanceBy(2_000);
      toolEventRecipients.add("finalized-grace", "conn-grace");
      toolEventRecipients.markFinal("finalized-grace");

      // The first maintenance tick is the first operation after either expiry.
      await clock.advanceBy(29_000);
      expect(runs.has("active-expired")).toBe(false);
      expect(runs.has("finalized-expired")).toBe(false);
      expect(runs.get("registered-expired")?.toolRecipient).toBeUndefined();
      expect(registry.peek("registered-expired")?.clientRunId).toBe("client-1");
      expect(toolEventRecipients.get("finalized-grace")).toEqual(new Set(["conn-grace"]));
      expect(toolEventRecipients.get("recent")).toEqual(new Set(["conn-recent"]));

      await clock.advanceBy(60_000);
      expect(runs.has("finalized-grace")).toBe(false);
      expect(runs.has("recent")).toBe(true);
    } finally {
      await stopMaintenanceTimers(timers);
    }
  });
});
