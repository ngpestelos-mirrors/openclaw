import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import * as ledger from "../../infra/update-run-ledger.js";
import * as stageTiming from "../../shared/stage-timing.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";

type TestUpdateAvailable = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
} | null;
type TestUpdateSentinel = {
  kind: string;
  status: string;
  ts: number;
  stats: Record<string, unknown>;
} | null;
type TestUpdateSchedule =
  | import("../../../packages/gateway-protocol/src/index.js").UpdateScheduleState
  | null;

const available = vi.hoisted(() => vi.fn<() => TestUpdateAvailable>(() => null));
const effectiveChannel = vi.hoisted(() =>
  vi.fn<() => Promise<UpdateChannel>>(async () => "stable"),
);
const schedule = vi.hoisted(() => vi.fn<() => TestUpdateSchedule>(() => null));
const refreshCheckout = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/update-status-schedule.js").refreshGatewayUpdateStatus>(
    async () => {},
  ),
);
const cachedSentinel = vi.hoisted(() => vi.fn<() => TestUpdateSentinel>(() => null));
const refreshSentinel = vi.hoisted(() =>
  vi.fn<() => Promise<TestUpdateSentinel>>(async () => null),
);

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: available,
  getUpdateSchedule: schedule,
}));

vi.mock("../../infra/update-startup.js", () => ({
  getUpdateEffectiveChannel: effectiveChannel,
}));

vi.mock("../../infra/update-status-schedule.js", () => ({
  getGatewayUpdateSchedule: () => schedule(),
  refreshGatewayUpdateStatus: refreshCheckout,
}));

vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  getLatestUpdateRestartSentinel: cachedSentinel,
  prepareLatestUpdateRestartSentinel: refreshSentinel,
}));

vi.mock("./validation.js", () => ({
  assertValidParams: () => true,
}));

let previousDiagnostics: boolean;
let lifecycle: UpdateCheckLifecycle;
afterEach(async () => {
  await lifecycle.stop();
  await lifecycle.scheduler.stop();
  vi.restoreAllMocks();
  setDiagnosticsEnabledForProcess(previousDiagnostics);
});

beforeEach(() => {
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  previousDiagnostics = areDiagnosticsEnabledForProcess();
  available.mockReset().mockReturnValue(null);
  effectiveChannel.mockReset().mockResolvedValue("stable");
  schedule.mockReset().mockReturnValue(null);
  refreshCheckout.mockReset().mockResolvedValue(undefined);
  cachedSentinel.mockReset().mockReturnValue(null);
  refreshSentinel.mockReset().mockResolvedValue(null);
});

function expectStatus(respond: ReturnType<typeof vi.fn>, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(fields));
}

async function status(
  options: {
    params?: Record<string, unknown>;
    context?: Record<string, unknown>;
    respond?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const { updateHandlers } = await import("./update.js");
  const handler = updateHandlers["update.status"];
  if (!handler) {
    throw new Error("update.status handler is unavailable");
  }
  const respond = options.respond ?? vi.fn();
  await handler({ params: {}, ...options, respond } as never);
  return respond;
}

describe("update.status effective channel", () => {
  it("reports the lifecycle-owned channel before the startup schedule is ready", async () => {
    effectiveChannel.mockResolvedValueOnce("extended-stable");
    const respond = await status({
      context: { getRuntimeConfig: () => ({ update: {} }) },
    });

    expectStatus(respond, { effectiveChannel: "extended-stable" });
    expect(refreshCheckout).not.toHaveBeenCalled();
  });

  it("prefers the current config channel over the startup schedule", async () => {
    schedule.mockReturnValue({ channel: "beta", autoEnabled: true });
    const respond = await status({
      context: { getRuntimeConfig: () => ({ update: { channel: "dev" } }) },
    });

    expectStatus(respond, { effectiveChannel: "dev" });
    expect(effectiveChannel).not.toHaveBeenCalled();
  });

  it("awaits the current config's checkout refresh before reporting its schedule", async () => {
    const config = { update: { channel: "dev" as const } };
    const context = { getRuntimeConfig: () => config };
    const refresh = createDeferred();
    refreshCheckout.mockReturnValueOnce(refresh.promise);
    const respond = vi.fn();
    const checking = status({ params: { refreshCheckout: true }, respond, context });
    const updatedSchedule = { channel: "dev" as const, autoEnabled: false };
    try {
      await vi.waitFor(() => expect(refreshCheckout).toHaveBeenCalledOnce());
      expect(refreshCheckout.mock.calls[0]?.[0]).toBe(context.getRuntimeConfig);
      expect(schedule).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      schedule.mockReturnValue(updatedSchedule);
    } finally {
      refresh.resolve();
      await checking;
    }
    expectStatus(respond, { effectiveChannel: "dev", schedule: updatedSchedule });
  });

  it("keeps status available when install identity initialization fails", async () => {
    effectiveChannel.mockRejectedValueOnce(new Error("probe failed"));
    const warn = vi.fn();
    const respond = await status({ context: { logGateway: { warn } } });

    expect(warn).toHaveBeenCalledWith("update.status install identity failed: probe failed");
    expect(respond).toHaveBeenCalledWith(true, { sentinel: null, updateAvailable: null });
  });

  it("does not report cached status as a successful explicit refresh after a fetch error", async () => {
    refreshCheckout.mockRejectedValueOnce(new Error("fetch timed out"));
    const respond = await status({
      params: { refreshCheckout: true },
      context: {
        getRuntimeConfig: () => ({ update: { channel: "dev" } }),
        logGateway: { warn: vi.fn() },
      },
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Could not check the latest update. Try again.",
    });
  });

  it("prepares the latest update sentinel before responding", async () => {
    available.mockReturnValueOnce({
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "latest",
    });
    cachedSentinel.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: { reason: "restart-health-pending" },
    });
    refreshSentinel.mockResolvedValueOnce({
      kind: "update",
      status: "ok",
      ts: 2,
      stats: { after: { version: "2.0.0" } },
    });
    schedule.mockReturnValue({ channel: "beta", autoEnabled: true });
    const respond = await status();

    expect(refreshSentinel).toHaveBeenCalledTimes(1);
    expectStatus(respond, {
      sentinel: expect.objectContaining({ kind: "update", status: "ok" }),
      updateAvailable: expect.objectContaining({ latestVersion: "2.0.0" }),
      schedule: expect.objectContaining({ channel: "beta" }),
    });
    expect(effectiveChannel).not.toHaveBeenCalled();
  });

  it("falls back to the cached update sentinel when refresh fails", async () => {
    refreshSentinel.mockRejectedValueOnce(new Error("read failed"));
    cachedSentinel.mockReturnValueOnce({
      kind: "update",
      status: "skipped",
      ts: 1,
      stats: { reason: "restart-health-pending" },
    });
    const warn = vi.fn();
    const respond = await status({ context: { logGateway: { warn } } });

    expect(warn).toHaveBeenCalledWith("update.status sentinel refresh failed: read failed");
    expectStatus(respond, { sentinel: expect.objectContaining({ status: "skipped" }) });
  });
});

it.each([
  { enabled: false, elapsed: 40_000, throws: false },
  { enabled: true, elapsed: 999.9, throws: false },
  { enabled: true, elapsed: 1_000, throws: false },
  { enabled: true, elapsed: 40_000, throws: true },
])("reports slow status phases with %j", async ({ enabled, elapsed, throws }) => {
  const { updateStatusHandlers } = await import("./update-status.js");
  setDiagnosticsEnabledForProcess(enabled);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const createTiming = vi.spyOn(stageTiming, "createStageTimingTracker");
  refreshSentinel.mockImplementationOnce(async () => {
    now += elapsed - 50;
    return null;
  });
  refreshCheckout.mockImplementationOnce(async () => {
    now += 20;
  });
  effectiveChannel.mockImplementationOnce(async () => {
    now += 30;
    return "stable";
  });
  const warn = vi.fn(() => {
    if (throws) {
      throw new Error("logger failed");
    }
  });
  const respond = vi.fn();
  await updateStatusHandlers["update.status"]!({
    params: { refreshCheckout: true },
    respond,
    context: { getRuntimeConfig: () => ({}), logGateway: { warn } },
  } as never);
  expectStatus(respond, { effectiveChannel: "stable" });
  if (enabled && elapsed >= 1_000) {
    expect(warn).toHaveBeenCalledExactlyOnceWith("update.status: slow request", {
      operation: "update.status",
      elapsedMs: elapsed,
      phaseDurationsMs: {
        sentinel: elapsed - 50,
        checkout: 20,
        identity: 30,
        reconciliation: 0,
        history: 0,
        response: 0,
      },
    });
  } else {
    expect(warn).not.toHaveBeenCalled();
    if (!enabled) {
      expect(createTiming).not.toHaveBeenCalled();
    }
  }
});

it("attributes a failed status history read to its phase and preserves the error", async () => {
  const { updateStatusHandlers } = await import("./update-status.js");
  setDiagnosticsEnabledForProcess(true);
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const failure = new Error("history unavailable");
  vi.spyOn(ledger, "getUpdateRunStatusAsync").mockImplementationOnce(async () => {
    now += 40_000;
    throw failure;
  });
  const warn = vi.fn();
  await expect(
    updateStatusHandlers["update.status"]!({
      params: {},
      respond: vi.fn(),
      context: { logGateway: { warn } },
    } as never),
  ).rejects.toBe(failure);
  expect(warn).toHaveBeenCalledExactlyOnceWith("update.status: slow request", {
    operation: "update.status",
    elapsedMs: 40_000,
    phaseDurationsMs: { sentinel: 0, checkout: 0, reconciliation: 0, history: 40_000 },
  });
});
