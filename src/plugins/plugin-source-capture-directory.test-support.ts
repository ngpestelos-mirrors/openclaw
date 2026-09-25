import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { retainPluginSourceCaptureInstance } from "./plugin-source-capture-directory.js";

export async function sweepPluginSourceCapturesForTest(stateDir: string): Promise<void> {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    instance.startMaintenance(scheduler);
    await clock.advanceBy(0);
  } finally {
    try {
      await scheduler.stop();
    } finally {
      await instance.releaseAsync();
    }
  }
}
