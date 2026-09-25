import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startChannelHealthMonitor } from "./channel-health-monitor.js";
import { createSnapshotManager } from "./channel-health-monitor.test-support.js";

const STARTED_AT = 1_000_000;
const CHECK_INTERVAL_MS = 1_000;

function createChannelManager(running: boolean) {
  const account: ChannelAccountSnapshot = {
    accountId: "default",
    running,
    connected: running,
    enabled: true,
    configured: true,
  };
  const manager = createSnapshotManager({ discord: { default: account } });
  return { account, manager };
}

describe("channel-health-monitor clock rollback", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;
  beforeEach(() => {
    clock = createGatewaySchedulerClock(STARTED_AT);
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  it("does not trap an existing monitor in startup grace after clock rollback", async () => {
    const { manager } = createChannelManager(false);
    const monitor = startChannelHealthMonitor({
      scheduler,
      channelManager: manager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      timing: { monitorStartupGraceMs: CHECK_INTERVAL_MS },
    });

    clock.setTime(STARTED_AT - 60_000 + CHECK_INTERVAL_MS);
    await clock.wake();

    expect(manager.startChannel).toHaveBeenCalledWith("discord", "default");
    monitor.stop();
  });

  it.each([
    { name: "restart cooldown", maxRestartsPerHour: 10 },
    { name: "hourly restart budget", maxRestartsPerHour: 1 },
  ])("discards future $name from an existing monitor", async ({ maxRestartsPerHour }) => {
    const { account, manager } = createChannelManager(true);
    const monitor = startChannelHealthMonitor({
      scheduler,
      channelManager: manager,
      checkIntervalMs: CHECK_INTERVAL_MS,
      cooldownCycles: 0,
      maxRestartsPerHour,
      timing: { monitorStartupGraceMs: 0 },
    });

    await clock.advanceBy(5 * CHECK_INTERVAL_MS);
    account.running = false;
    account.connected = false;
    await clock.advanceBy(CHECK_INTERVAL_MS);
    expect(manager.startChannel).toHaveBeenCalledTimes(1);

    clock.setTime(STARTED_AT + 4 * CHECK_INTERVAL_MS);
    await clock.wake();

    expect(manager.startChannel).toHaveBeenCalledTimes(2);
    monitor.stop();
  });
});
