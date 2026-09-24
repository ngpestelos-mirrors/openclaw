import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { GatewayScheduler } from "./gateway-scheduler.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "./update-check-lifecycle.js";

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: GatewayScheduler;
let lifecycle: UpdateCheckLifecycle;

beforeEach(() => {
  clock = createGatewaySchedulerClock(1_000);
  scheduler = new GatewayScheduler({ clock: clock.clock });
  lifecycle = createGatewayUpdateLifecycle(scheduler);
});

afterEach(async () => {
  await lifecycle.stop();
  await scheduler.stop();
});

it("checks once after sleep and uses the next delay returned by discovery", async () => {
  const check = vi.fn().mockResolvedValueOnce(100).mockResolvedValue(500);
  lifecycle.schedule("update.check", check);
  await clock.advanceBy(0);
  expect(check).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBe(1_100);

  await clock.advanceBy(10_000);
  expect(check).toHaveBeenCalledTimes(2);
  expect(scheduler.nextWakeAtMs).toBe(11_500);
  await clock.advanceBy(499);
  expect(check).toHaveBeenCalledTimes(2);
  await clock.advanceBy(1);
  expect(check).toHaveBeenCalledTimes(3);

  await lifecycle.stop();
  await clock.advanceBy(10_000);
  expect(check).toHaveBeenCalledTimes(3);
  expect(scheduler.nextWakeAtMs).toBeNull();
});

it("keeps discovery on its elapsed cadence when wall time moves backward", async () => {
  const check = vi.fn(async () => 100);
  lifecycle.schedule("update.check", check);
  await clock.advanceBy(0);
  expect(check).toHaveBeenCalledOnce();

  clock.setTime(-10_000);
  await clock.wake();
  expect(check).toHaveBeenCalledTimes(2);
  expect(scheduler.nextWakeAtMs).toBe(-9_900);
  await clock.advanceBy(100);
  expect(check).toHaveBeenCalledTimes(3);
});

it("joins discovery cleanup before a replacement lifecycle starts work", async () => {
  const cleanup = createDeferredCore();
  const started = createDeferredCore();
  lifecycle.schedule("update.check", async () => {
    void trackAsyncWork(() => cleanup.promise);
    started.resolve();
    return 100;
  });
  const previousWake = clock.wake();
  await started.promise;
  const previous = lifecycle;
  lifecycle = createGatewayUpdateLifecycle(scheduler);
  const check = vi.fn(async () => 500);
  lifecycle.schedule("update.check", check);
  const replacementWake = clock.advanceBy(0);
  try {
    await Promise.resolve();
    expect(previous.signal.aborted).toBe(true);
    expect(check).not.toHaveBeenCalled();
  } finally {
    cleanup.resolve();
    await Promise.all([previous.stop(), previousWake, replacementWake]);
  }
  expect(check).toHaveBeenCalledOnce();
  expect(scheduler.nextWakeAtMs).toBe(1_500);
});
