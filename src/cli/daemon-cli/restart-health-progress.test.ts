import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

describe("restart startup progress", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each([null, 1])("observes delayed child readiness with exitCode=%s", async (exitCode) => {
    const child = { pid: process.pid, exitCode, signalCode: null };
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: monotonicClock.nowMs < 12_500 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 12_500 ? [] : [{ pid: child.pid }],
      hints: [],
    }));
    callGateway.mockImplementation(async (opts) => {
      if (monotonicClock.nowMs < 20_000) {
        throw new Error("Gateway is still starting");
      }
      return gatewayHealthResponse({ server: { version: "2026.9.4", bootId: "child-boot" } })(opts);
    });
    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const health = await waitForGatewayHealthyRestart({
      child,
      port: 18789,
      requireRunningService: true,
      requirePluginHealth: false,
      expectedVersion: "2026.9.4",
    });
    if (exitCode === null) {
      expect(health).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 20_000 });
    } else {
      expect(health.runtime.status).toBe("stopped");
      expect(health.waitOutcome).not.toBe("healthy");
    }
  });

  it("waits through advancing service, listener, and hello phases until health at 180s", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      monotonicClock.nowMs < 45_000 ? { status: "unknown" } : { status: "running", pid: 8000 },
    );
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: monotonicClock.nowMs < 95_000 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 95_000 ? [] : [{ pid: 8000 }],
      hints: [],
    }));
    callGateway.mockImplementation(async (opts) => {
      if (monotonicClock.nowMs >= 145_000) {
        await gatewayHealthResponse({ server: { bootId: "stable-boot" } })(opts);
      }
      if (monotonicClock.nowMs < 180_000) {
        throw new Error("Gateway health is not ready");
      }
      return {};
    });
    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const health = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      requirePluginHealth: false,
    });
    expect(health).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 180_000 });
  });

  it.each([
    { name: "renewing migration", renew: true, expected: "still-starting", elapsedMs: 300_000 },
    {
      name: "renewing migration during update verification",
      renew: true,
      timeoutMs: 300_000,
      expected: "still-starting",
      elapsedMs: 300_000,
    },
    {
      name: "renewing migration under a published updater",
      renew: true,
      updateInProgress: true,
      expected: "still-starting",
      elapsedMs: 300_000,
    },
    {
      name: "migration that stops making progress during update verification",
      renew: true,
      stallAtMs: 30_000,
      timeoutMs: 300_000,
      expected: "timeout",
      elapsedMs: 300_000,
    },
    { name: "stalled migration", renew: false, expected: "timeout", elapsedMs: 60_000 },
    {
      name: "replaced process",
      renew: true,
      replace: true,
      expected: "generation-changed",
      elapsedMs: 60_000,
    },
    {
      name: "replaced boot under the same PID",
      renew: true,
      replaceBoot: true,
      expected: "generation-changed",
      elapsedMs: 60_000,
    },
    {
      name: "unrelated migration",
      renew: true,
      foreign: true,
      expected: "timeout",
      elapsedMs: 60_000,
    },
  ])(
    "bounds a $name",
    async ({
      renew,
      replace,
      replaceBoot,
      foreign,
      expected,
      elapsedMs,
      timeoutMs,
      updateInProgress,
      stallAtMs,
    }) => {
      const service = makeGatewayService({ status: "running", pid: 8000 });
      if (replace) {
        vi.mocked(service.readRuntime).mockImplementation(async () => ({
          status: "running",
          pid: monotonicClock.nowMs < 30_000 ? 8000 : 9000,
        }));
      }
      if (replaceBoot) {
        inspectPortUsage.mockResolvedValue({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 8000 }],
          hints: [],
        });
        callGateway.mockImplementation((opts) =>
          gatewayHealthResponse({
            server: { bootId: monotonicClock.nowMs < 30_000 ? "boot-a" : "boot-b" },
            error: new Error("Gateway health is not ready"),
          })(opts),
        );
      }
      const isStartupMigrationActive = ({
        onActivity,
      }: {
        env?: NodeJS.ProcessEnv;
        onActivity?: (activity: {
          owner: string;
          pid?: number;
          heartbeatAt: number | null;
        }) => void;
      } = {}) => {
        onActivity?.({
          owner: "migration-owner",
          pid: foreign ? 9000 : 8000,
          heartbeatAt: renew ? Math.min(monotonicClock.nowMs, stallAtMs ?? Infinity) : 0,
        });
        return true;
      };
      const { waitForGatewayHealthyRestart, formatGatewayRestartFailure } =
        await import("./restart-health.js");
      const health = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        isStartupMigrationActive,
        requirePluginHealth: false,
        timeoutMs,
        env: updateInProgress ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {},
      });
      expect(health).toMatchObject({ healthy: false, waitOutcome: expected, elapsedMs });
      const message = formatGatewayRestartFailure({
        health,
        port: 18789,
        defaultTimeoutSeconds: 60,
      });
      if (expected === "still-starting") {
        expect(message.failMessage).toContain("still starting after 300s");
        expect(message.failMessage).toContain("startup migration");
        expect(message.failMessage).toContain("openclaw gateway status --deep");
      } else if (expected === "timeout") {
        expect(message.failMessage).toBe(
          `Gateway restart timed out after ${elapsedMs / 1000}s waiting for health checks.`,
        );
      }
    },
  );

  it.each([
    { listenerPid: 8000, elapsedMs: 90_000 },
    { listenerPid: 9000, elapsedMs: 60_000 },
  ])(
    "only credits new listener progress owned by the service (pid=$listenerPid)",
    async ({ listenerPid, elapsedMs }) => {
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: Math.floor(monotonicClock.nowMs / 30_000) % 2 === 0 ? "free" : "busy",
        listeners:
          Math.floor(monotonicClock.nowMs / 30_000) % 2 === 0 ? [] : [{ pid: listenerPid }],
        hints: [],
      }));
      const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
      const health = await waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "running", pid: 8000 }),
        port: 18789,
        requirePluginHealth: false,
      });
      expect(health).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs });
    },
  );
});
