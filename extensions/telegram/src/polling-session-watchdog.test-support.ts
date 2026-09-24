import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { vi } from "vitest";

const POLLING_TEST_WATCHDOG_INTERVAL_MS = 30_000;

export function installPollingStallWatchdogHarness(dateNowSequence: readonly number[] = [0, 0]) {
  let monotonicNow = dateNowSequence[0] ?? 0;
  let watchdog: (() => void) | undefined;
  let resolveWatchdog: ((fn: () => void) => void) | undefined;
  const watchdogReady = new Promise<() => void>((resolve) => {
    resolveWatchdog = resolve;
  });
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const watchdogs: Array<() => void> = [];
  const watchdogWaiters: Array<{
    count: number;
    resolve: (fn: () => void) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof realSetTimeout>;
  }> = [];
  const setIntervalSpy = vi
    .spyOn(globalThis, "setInterval")
    .mockImplementation((fn, delay, ...args) => {
      if (delay !== POLLING_TEST_WATCHDOG_INTERVAL_MS) {
        return realSetInterval(fn, delay, ...args);
      }
      watchdog = fn as () => void;
      watchdogs.push(watchdog);
      resolveWatchdog?.(watchdog);
      for (let index = watchdogWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = expectDefined(watchdogWaiters[index], `watchdog waiter ${index}`);
        if (watchdogs.length < waiter.count) {
          continue;
        }
        realClearTimeout(waiter.timeout);
        watchdogWaiters.splice(index, 1);
        waiter.resolve(
          expectDefined(watchdogs[waiter.count - 1], `watchdog callback ${waiter.count}`),
        );
      }
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
  const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation((timer) => {
    if (timer !== 1) {
      realClearInterval(timer);
    }
  });
  // Accelerate polling stop grace only; worker admission and execution keep real deadlines.
  const setTimeoutSpy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((fn, delay, ...args) =>
      realSetTimeout(fn, delay === 15_000 ? 0 : delay, ...args),
    );
  const dateNowSpy = vi.spyOn(Date, "now");
  const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  for (const value of dateNowSequence) {
    dateNowSpy.mockImplementationOnce(() => value);
  }
  dateNowSpy.mockImplementation(() => 0);

  return {
    async waitForWatchdog() {
      if (watchdog) {
        return watchdog;
      }
      return await new Promise<() => void>((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          reject(new Error("Timed out waiting for polling watchdog interval registration"));
        }, 5_000);
        watchdogReady.then(
          (fn) => {
            realClearTimeout(timeout);
            resolve(fn);
          },
          (error: unknown) => {
            realClearTimeout(timeout);
            reject(toLintErrorObject(error, "Non-Error rejection"));
          },
        );
      });
    },
    async waitForWatchdogRegistration(count: number) {
      const registered = watchdogs[count - 1];
      if (registered) {
        return registered;
      }
      return await new Promise<() => void>((resolve, reject) => {
        const timeout = realSetTimeout(() => {
          reject(new Error(`Timed out waiting for polling watchdog registration ${count}`));
        }, 5_000);
        watchdogWaiters.push({ count, resolve, reject, timeout });
      });
    },
    setNow(now: number) {
      monotonicNow = now;
      dateNowSpy.mockReset();
      dateNowSpy.mockImplementation(() => now);
    },
    restore() {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      dateNowSpy.mockRestore();
      performanceNowSpy.mockRestore();
    },
  };
}
