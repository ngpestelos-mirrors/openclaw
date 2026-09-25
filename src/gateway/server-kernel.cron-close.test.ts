import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { abortActiveCronTaskRuns } from "../cron/service/active-run-cancellation.js";
import { createCronServiceState } from "../cron/service/state.js";
import { executeJobCoreWithTimeout } from "../cron/service/timer-job-runner.js";
import { waitForAbortSignal } from "../infra/abort-signal.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import { startHeartbeatRunner, type HeartbeatRunner } from "../infra/heartbeat-runner-scheduler.js";
import { requestHeartbeatAndWait } from "../infra/heartbeat-wake.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import * as kernelModule from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServerCore } from "./server-start.js";

const fixture = vi.hoisted(() => ({
  clock: undefined as GatewaySchedulerClock | undefined,
  runCommand: vi.fn<typeof import("../cron/command-runner.js").runCronCommandJob>(),
}));

vi.mock("../cron/command-runner.js", () => ({ runCronCommandJob: fixture.runCommand }));
vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: fixture.clock ?? options.clock });
      }
    },
  };
});

it("settles heartbeat wakes and cancels scheduled cron before public close joins and retries its drain", async ({
  signal,
}) => {
  const port = await getFreePort();
  const state = await createOpenClawTestState({
    label: "gateway-kernel-cron-close",
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: undefined,
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  const clock = createGatewaySchedulerClock(Date.now());
  fixture.clock = clock.clock;
  const started = createDeferred();
  const cancelled = createDeferred();
  fixture.runCommand.mockImplementation(async ({ abortSignal }) => {
    if (!abortSignal) {
      throw new Error("Expected the real cron execution cancellation signal");
    }
    started.resolve();
    await waitForAbortSignal(abortSignal);
    cancelled.resolve();
    return { status: "error", error: "Cancelled by Gateway shutdown" };
  });
  const captured: {
    kernel?: Awaited<ReturnType<typeof kernelModule.createGatewayKernel>>;
    heartbeatRunner?: HeartbeatRunner;
    heartbeatRun?: ReturnType<typeof executeJobCoreWithTimeout>;
  } = {};
  let emergencyUsed = false;
  const emergencyAbort = () => {
    emergencyUsed = true;
    captured.heartbeatRunner?.stop();
    abortActiveCronTaskRuns("Fixture cleanup after failed shutdown proof");
  };
  signal.addEventListener("abort", emergencyAbort, { once: true });
  let server: GatewayServer | undefined;
  let pendingWake: void | Promise<void> = undefined;
  onTestFinished(async () => {
    captured.heartbeatRunner?.stop();
    abortActiveCronTaskRuns("Fixture cleanup");
    try {
      await captured.heartbeatRun;
      await pendingWake;
      try {
        await (server?.close() ?? captured.kernel?.closeOnStartupFailure());
      } catch (error) {
        await captured.kernel?.closeOnStartupFailure();
        throw error;
      }
    } finally {
      signal.removeEventListener("abort", emergencyAbort);
      fixture.clock = undefined;
      vi.restoreAllMocks();
      await state.cleanup();
    }
  });
  const token = "synthetic-cron-close-token";
  await state.writeConfig({
    gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
    agents: { defaults: { heartbeat: { every: "0m" } } },
    skills: { workshop: { autonomous: { mode: "off" } } },
    plugins: { enabled: false },
    cron: { enabled: true },
  });
  state.applyEnv();
  const createKernel = kernelModule.createGatewayKernel;
  const factory = vi
    .spyOn(kernelModule, "createGatewayKernel")
    .mockImplementation(async (...args) => {
      const kernel = await createKernel(...args);
      captured.kernel = kernel;
      return kernel;
    });
  try {
    server = await startGatewayServerCore(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    await server.startupSettled;
  } finally {
    factory.mockRestore();
  }
  const kernel = captured.kernel;
  if (!kernel) {
    throw new Error("Expected the public server's real Gateway kernel");
  }
  const cron = kernel.runtimeState.cronState.cron;
  await cron.start();
  await cron.add({
    name: "controlled shutdown command",
    enabled: true,
    schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
    payload: { kind: "command", argv: ["synthetic-controlled-command"] },
    sessionTarget: "isolated",
    wakeMode: "now",
    delivery: { mode: "none" },
  });
  pendingWake = clock.advanceBy(1_000);
  await started.promise;
  const heartbeatRunner = startHeartbeatRunner({
    cfg: { agents: { defaults: { heartbeat: { every: "30m" } } } },
    runOnce: async () => ({ status: "skipped", reason: "requests-in-flight" }),
  });
  captured.heartbeatRunner = heartbeatRunner;
  kernel.kernel.swapHeartbeatRunner(heartbeatRunner).stop();
  const heartbeatStop = vi.spyOn(heartbeatRunner, "stop");
  const heartbeatQueued = createDeferred();
  const heartbeatState = createCronServiceState({
    scheduler: kernel.scheduler,
    storePath: "unused-heartbeat-monitor",
    cronEnabled: false,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    requestHeartbeatAndWait: (...args) => {
      const pending = requestHeartbeatAndWait(...args);
      heartbeatQueued.resolve();
      return pending;
    },
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const heartbeatRun = executeJobCoreWithTimeout(heartbeatState, {
    id: "shutdown-heartbeat-monitor",
    agentId: "main",
    name: "heartbeat-main",
    enabled: true,
    createdAtMs: clock.clock.now(),
    updatedAtMs: clock.clock.now(),
    schedule: { kind: "every", everyMs: 1_800_000 },
    payload: { kind: "heartbeat" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    state: {},
  });
  captured.heartbeatRun = heartbeatRun;
  await heartbeatQueued.promise;
  const stopAndDrain = cron.stopAndDrain?.bind(cron);
  if (!stopAndDrain) {
    throw new Error("Expected the Gateway cron drain owner");
  }
  const drainFailure = new Error("Controlled cron drain failure after cancellation");
  const drain = vi.spyOn(cron, "stopAndDrain").mockImplementation(stopAndDrain);
  drain.mockImplementationOnce(async () => {
    await stopAndDrain();
    throw drainFailure;
  });
  const completeClose = vi.spyOn(kernel.shutdownRuntime, "completeGatewayClose");

  const firstClose = server.close();
  void firstClose.catch(() => {});
  expect(heartbeatStop).toHaveBeenCalledOnce();
  await expect(firstClose).rejects.toMatchObject({
    name: "PluginRuntimeCloseRetainedError",
    cause: drainFailure,
  });
  await cancelled.promise;
  await pendingWake;
  await expect(heartbeatRun).resolves.toMatchObject({
    status: "skipped",
    error: "heartbeat skipped: handler-unavailable",
  });
  expect(completeClose).not.toHaveBeenCalled();
  expect(drain).toHaveBeenCalledOnce();

  await server.close();
  expect(completeClose).toHaveBeenCalledOnce();
  expect(drain).toHaveBeenCalledTimes(2);
  expect(fixture.runCommand).toHaveBeenCalledOnce();
  expect(emergencyUsed).toBe(false);
});
