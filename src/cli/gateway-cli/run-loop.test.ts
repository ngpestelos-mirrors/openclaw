// Gateway run loop tests cover foreground gateway lifecycle and restart behavior.
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServer, GatewayStartupOperation } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { captureEnv } from "../../test-utils/env.js";
import { registerExternalHandoffShutdownTests } from "./run-loop-external-handoff.test-support.js";
import { registerHostedUpdateStopTests } from "./run-loop-hosted-stop.test-support.js";
import { registerGatewayLogSettlementTests } from "./run-loop-log-settlement.test-support.js";
import { gatewayWorkAdmissionActual, runLoopFixture } from "./run-loop-mocks.test-support.js";
import { registerNaturalExitTests } from "./run-loop-natural-exit.test-support.js";
import { registerGatewayRequestTests } from "./run-loop-request.test-support.js";
import { registerGatewayRestartOwnershipTests } from "./run-loop-restart-ownership.test-support.js";
import { registerShutdownBudgetTests } from "./run-loop-shutdown-budget.test-support.js";
import {
  registerGracefulGatewayShutdownTests,
  registerShutdownCompletionTests,
} from "./run-loop-shutdown-completion.test-support.js";
import { registerGatewayStartupFailureTests } from "./run-loop-startup.test-support.js";
import { registerUpdateRespawnTests } from "./run-loop-update-respawn.test-support.js";
import {
  createActiveWorkSnapshot,
  advanceWithoutCalls,
  expectUncalled,
  createCloseMock,
  createLifecycleGate,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  createUpdateRespawnChild,
  expectRestartCloseCall,
  expectStopCloseCall,
  originalPlatformDescriptor,
  registerUpdateRespawnProgressTests,
  setPlatform,
  systemdReply,
  withLifecycleClock,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const mocks = runLoopFixture;

const managedUpdateSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "handoff-under-test",
  installRoot: "/openclaw/install",
} as const;

const fixtures = {
  ...runLoopFixture,
  managedUpdateSuccessorOwner,
  isGatewayWorkAdmissionClosed: () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
  withIsolatedSignals,
  createSignaledStart,
  createRuntimeWithExitSignal,
  waitForStart,
  waitForLoopCondition,
  setPlatform,
  originalPlatformDescriptor,
};

const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;

type GatewayCloseFn = GatewayServer["close"];

function waitForLoopTurn() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("runGatewayLoop", () => {
  registerNaturalExitTests(waitForLoopTurn);
  registerGatewayRequestTests(fixtures);

  registerExternalHandoffShutdownTests(fixtures);

  it("does not grant process control to a nonexclusive embedded host", async () => {
    await mocks.withRunningGateway(async ({ captureSignal, start, close, exited, runtime }) => {
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      await expect(host!.request("start", () => {})).resolves.toMatchObject({
        ok: true,
        value: { outcome: "already-running" },
      });
      for (const action of ["stop", "restart"] as const) {
        await expect(host!.request(action, () => {})).resolves.toMatchObject({
          ok: false,
          error: expect.stringContaining("does not own the process lifecycle"),
        });
      }
      expectUncalled(close, runtime.exit, mocks.hostedStopExecute);
      captureSignal("SIGINT")();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("retains the initiating root through response submission and joins before native stop", async () => {
    await mocks.withRunningGateway(async ({ close, start, exited }) => {
      const startOptions = start.mock.calls[0]?.[0];
      const host = startOptions?.hostLifecycle;
      expect(host).toBeDefined();
      const requestFinished = createDeferredCore();
      const joined = createDeferredCore();
      close.mockImplementationOnce(() => joined.promise);
      mocks.waitForGatewayActiveWork.mockImplementationOnce(async () => {
        // excludeCurrent must not hide the original RPC when shutdown begins.
        expect(
          gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount({ excludeCurrent: true }),
        ).toBe(1);
        await requestFinished.promise;
        expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(0);
        return { drained: true, snapshot: mocks.idleActiveWorkSnapshot };
      });
      try {
        await gatewayWorkAdmissionActual.runWithGatewayIndependentRootWorkAdmission(async () => {
          await expect(host!.request("stop", () => {})).resolves.toEqual({
            ok: true,
            value: { outcome: "scheduled" },
          });
          // Audit/history/response work remains in the admitted handler after acceptance.
          await Promise.resolve();
          expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(1);
          expectUncalled(close, mocks.hostedStopExecute);
        }, "rpc:system-agent.chat");
        requestFinished.resolve();
        await waitForLoopCondition(
          () => close.mock.calls.length === 1,
          "hosted stop did not reach teardown",
        );
        expect(mocks.hostedStopExecute).not.toHaveBeenCalled();
        joined.resolve();
        await expect(exited).resolves.toBe(0);
        expect(mocks.waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, {
          onSnapshot: expect.any(Function),
        });
        expect(mocks.hostedStopExecute).toHaveBeenCalledOnce();
        await expect(host!.request("start", () => {})).resolves.toMatchObject({ ok: false });
      } finally {
        requestFinished.resolve();
        joined.resolve();
      }
    }, true);
  });

  registerHostedUpdateStopTests(fixtures);

  it.each([
    { outcome: "refused", detail: "same native generation; stop denied" },
    { outcome: "uncertain", detail: "native acknowledgement lost" },
  ] as const)("recovers only after a definitive native stop refusal ($outcome)", async (result) => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      mocks.hostedStopExecute.mockResolvedValueOnce(result);
      const disposed = createDeferredCore();
      mocks.hostedStopDispose.mockImplementationOnce(() => disposed.promise);
      const { start, exited, runtime } = await mocks.createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]![0]!.hostLifecycle!;
      try {
        await host.request("stop", () => {});
        await waitForLoopCondition(
          () => mocks.hostedStopDispose.mock.calls.length === 1,
          "executor cleanup did not start",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(runtime.exit).not.toHaveBeenCalled();
        disposed.resolve();
        if (result.outcome === "refused") {
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "native refusal left a closed Gateway instead of restarting in process",
          );
          expect(runtime.exit).not.toHaveBeenCalled();
          await expect(host.request("restart", () => {})).resolves.toMatchObject({ ok: false });
          captureSignal("SIGINT")();
        }
        await expect(exited).resolves.toBe(result.outcome === "refused" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(result.outcome === "refused" ? 2 : 1);
        expect(mocks.gatewayLog.error).toHaveBeenCalledWith(expect.stringContaining(result.detail));
      } finally {
        disposed.resolve();
      }
    });
  });

  it("rejects an unclean replacement acquisition before admitting another lifecycle", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      const startupError = new Error("replacement listener failed");
      const cleanupError = new Error("replacement required cleanup failed");
      const failure = new GatewayStartupCleanupError(startupError, cleanupError);
      let lockCallsAtFailure = 0;
      let cancellationsAtFailure = 0;
      let commitsAtFailure = 0;
      const start = vi
        .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockImplementationOnce(async () => {
          lockCallsAtFailure = mocks.acquireGatewayLock.mock.calls.length;
          cancellationsAtFailure = mocks.cancelManagedServiceUpdateHandoff.mock.calls.length;
          commitsAtFailure = mocks.commitManagedServiceUpdateHandoff.mock.calls.length;
          throw failure;
        });
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const onRestartStartupFailure = vi.fn();
      const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
      const rejected = vi.fn<(error: unknown) => void>();
      const settled = loop.catch(rejected);
      let stop: (() => void) | undefined;
      try {
        await waitForLoopCondition(() => start.mock.calls.length === 1, "expected first startup");
        // The first generation has completed startup before its restart is requested.
        await waitForLoopTurn();
        stop = captureSignal("SIGTERM");
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () =>
            rejected.mock.calls.length > 0 ||
            mocks.gatewayLog.error.mock.calls.some(([message]) =>
              String(message).startsWith("gateway startup failed:"),
            ),
          "expected replacement acquisition failure",
        );
        expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
        await expect(loop).rejects.toBe(failure);
        expect(start).toHaveBeenCalledTimes(2);
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(lockCallsAtFailure);
        expect(mocks.cancelManagedServiceUpdateHandoff).toHaveBeenCalledTimes(
          cancellationsAtFailure,
        );
        expect(mocks.commitManagedServiceUpdateHandoff).toHaveBeenCalledTimes(commitsAtFailure);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason: expect.stringContaining(startupError.message),
        });
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        if (rejected.mock.calls.length === 0 && stop) {
          stop();
          await exited;
        }
        if (rejected.mock.calls.length > 0) {
          await settled;
        }
      }
    });
  });

  it("cancels and joins triage before stopping a failed in-process restart", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const startedTriage = createDeferred();
      const cleanup = createDeferred();
      let triageSignal: AbortSignal | undefined;
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockRejectedValueOnce(new Error("replacement startup failed"));
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      void runGatewayLoop({
        start,
        runtime,
        onRestartStartupFailure: async (_error, signal) => {
          triageSignal = signal;
          startedTriage.resolve();
          await cleanup.promise;
        },
      });
      await waitForLoopCondition(() => start.mock.calls.length === 1, "expected initial Gateway");
      captureSignal("SIGUSR2")();
      await startedTriage.promise;
      captureSignal("SIGINT")();
      try {
        expect(triageSignal?.aborted).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
      }
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  registerGatewayStartupFailureTests(mocks.gatewayLog, fixtures);

  registerGracefulGatewayShutdownTests(fixtures);

  it.each(["close", "native stop"])(
    "records the thrown %s error during a hosted stop",
    async (step) => {
      await withIsolatedSignals(async () => {
        const error = new TypeError("fixture hosted stop failed");
        const { close, start, exited } = await mocks.createSignaledLoopHarness(undefined, true);
        if (step === "close") {
          close.mockRejectedValueOnce(error);
        } else {
          mocks.hostedStopExecute.mockRejectedValueOnce(error);
        }
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        expect(host).toBeDefined();
        await expect(host?.request("stop", () => {})).resolves.toMatchObject({ ok: true });
        await expect(exited).resolves.toBe(1);
        expect(mocks.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          step === "close" ? "gateway.stop_close_failed" : "gateway.stop_native_unconfirmed",
          error,
          { shutdownStep: step === "close" ? "gateway-server-close" : "hosted-gateway-stop" },
        );
      });
    },
  );

  registerGatewayLogSettlementTests(fixtures);

  it("exits instead of reusing a failed lifecycle after managed restoration", async () => {
    mocks.consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    mocks.cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restart-after-exit")
      .mockResolvedValueOnce("restored-in-process");
    mocks.commitManagedServiceUpdateHandoff.mockResolvedValueOnce(false);
    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn<GatewayCloseFn>(async () => {
        throw new TypeError("close owner failed");
      });
      const { start, runtime, exited } = await mocks.createSignaledLoopHarness(undefined, false, {
        close,
      });
      const stop = captureSignal("SIGINT");
      try {
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
          "expected restart close failure to exit or start a new lifecycle",
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
        await expect(exited).resolves.toBe(1);
        expect(start).toHaveBeenCalledOnce();
        expect(mocks.gatewayLog.error).toHaveBeenCalledWith(
          "shutdown step failed (gateway server close): close owner failed",
        );
      } finally {
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it("reports only category counts while direct SIGTERM stop is pending with tracing", async () => {
    const signal = "SIGTERM";
    const traceEnv = captureEnv(["OPENCLAW_GATEWAY_RESTART_TRACE"]);
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
    try {
      await mocks.withRunningGateway(async ({ captureSignal, close, runtime, exited }) => {
        const cleanupSignal = gatewayWorkAdmissionActual.getGatewayShutdownCleanupSignal();
        close.mockImplementationOnce(async () => {
          expect(cleanupSignal.aborted).toBe(true);
        });
        const { startGatewayRestartTrace } = await import("../../gateway/restart-trace.js");
        startGatewayRestartTrace("prior.sequence");
        const pendingDrain = createDeferredCore();
        const enteredDrain = createDeferredCore();
        const activeSnapshot = createActiveWorkSnapshot(
          {
            queueSize: 1,
            pendingReplies: 2,
            embeddedRuns: 3,
            backgroundExecSessions: 4,
            cronRuns: 5,
            agentRuns: 6,
            acpRuns: 0,
            mediaRuns: 0,
            rootRequests: 7,
            sessionAdmissions: 8,
            sessionMutations: 9,
            chatRuns: 10,
            queuedTurns: 11,
            terminalPersistence: 12,
            terminalSessions: 13,
          },
          [
            { kind: "root-request", count: 7, message: "private-root-holder-origin" },
            {
              kind: "agent-run",
              count: 6,
              message: "private-task-message",
            },
          ],
        );
        const counts =
          "queueSize=1 pendingReplies=2 embeddedRuns=3 backgroundExecSessions=4 cronRuns=5 agentRuns=6 rootRequests=7 sessionAdmissions=8 sessionMutations=9 chatRuns=10 queuedTurns=11 terminalPersistence=12 terminalSessions=13";
        mocks.waitForGatewayActiveWork.mockImplementationOnce(async (_timeoutMs, options) => {
          options?.onSnapshot?.(activeSnapshot);
          enteredDrain.resolve();
          await pendingDrain.promise;
          return { drained: true, snapshot: mocks.idleActiveWorkSnapshot };
        });
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
          captureSignal(signal)();
          await enteredDrain.promise;
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          expect(mocks.waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, {
            onSnapshot: expect.any(Function),
          });
          expectUncalled(mocks.createGatewayActiveWorkSnapshot, close);
          expect(cleanupSignal.aborted).toBe(false);
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(mocks.gatewayLog.info).toHaveBeenCalledWith(
            `draining active work before stop with timeout 20000ms: ${counts}`,
          );
          captureSignal(signal)();
          expect(mocks.waitForGatewayActiveWork).toHaveBeenCalledOnce();
          const onSnapshot = mocks.waitForGatewayActiveWork.mock.calls[0]?.[1]?.onSnapshot;
          now += 29_999;
          onSnapshot?.(activeSnapshot);
          expect(mocks.gatewayLog.warn).not.toHaveBeenCalled();
          now += 1;
          onSnapshot?.(activeSnapshot);
          onSnapshot?.(activeSnapshot);
          expect(mocks.gatewayLog.warn).toHaveBeenCalledExactlyOnceWith(
            `still draining active work before stop: ${counts}`,
          );
          clock.mockRestore();
          pendingDrain.resolve();
          await expect(exited).resolves.toBe(0);
          expect(mocks.abortEmbeddedAgentRun).not.toHaveBeenCalled();
          expect(mocks.gatewayLog.info).toHaveBeenCalledWith(
            "active-work drain settled; beginning server close",
          );
          const output = [...mocks.gatewayLog.info.mock.calls, ...mocks.gatewayLog.warn.mock.calls]
            .flat()
            .join("\n");
          expect(output).not.toContain("private-");
          expect(output).not.toContain("totalActive");
          expect(output).toContain("restart trace:");
          const starts = mocks.gatewayLog.info.mock.calls
            .flat()
            .filter((line) => String(line).includes("stop.signal.received "));
          expect(starts).toEqual([
            `restart trace: stop.signal.received 0.0ms total=0.0ms signal=${signal}`,
          ]);
          expectStopCloseCall(close);
        } finally {
          clock.mockRestore();
          pendingDrain.resolve();
          await exited;
        }
      });
    } finally {
      traceEnv.restore();
    }
  });

  registerShutdownBudgetTests(fixtures);

  registerShutdownCompletionTests(fixtures);

  registerGatewayRestartOwnershipTests(fixtures);

  it("restarts after SIGUSR2 even when drain times out, and resets runtime state for the new iteration", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.markUpdateRestartSentinelFailure.mockClear();
    const firstCronDrain = createDeferredCore<{ drained: boolean; active: number }>();
    mocks.waitForActiveCronTaskRuns.mockImplementationOnce(() => firstCronDrain.promise);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ agentRuns: 2, embeddedRuns: 1 }, [
        { kind: "agent-run", count: 2, message: "2 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]);
      mocks.createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(timedOutSnapshot)
        .mockReturnValue(mocks.idleActiveWorkSnapshot);
      mocks.waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });

      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      const lifecycleSlot = resolveGlobalMap<string, number>(
        Symbol("run-loop-lifecycle-slot"),
        (state) => state.clear(),
      );
      const agentEventsActual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      const firstAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();

      const { start, started: startedFirst } = createSignaledStart(closeFirst);
      const startedSecond = createDeferredCore();
      const startedThird = createDeferredCore();
      // Only the first start uses createSignaledStart's default implementation.
      start.mockImplementationOnce(start.getMockImplementation()!);
      let secondAgentEventGeneration: string | undefined;
      let secondRestartDrainSignal: AbortSignal | undefined;
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        secondAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
        secondRestartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        expect(secondRestartDrainSignal.aborted).toBe(false);
        lifecycleSlot.set("second", 2);
        startedSecond.resolve();
        return createGatewayServer(closeSecond);
      });

      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        startedThird.resolve();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      void runGatewayLoop({ start, runtime });

      await startedFirst;
      lifecycleSlot.set("first", 1);
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await waitForLoopTurn();

      restartSignal();

      await waitForLoopCondition(
        () => mocks.waitForActiveCronTaskRuns.mock.calls.length === 1,
        "expected first restart to reach cron task drain",
      );
      restartSignal();
      firstCronDrain.resolve({ drained: true, active: 0 });
      await startedSecond.promise;
      expect(secondAgentEventGeneration).not.toBe(firstAgentEventGeneration);

      expect(mocks.waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(mocks.gatewayLog.warn).toHaveBeenCalledWith(
        "restart drain budget 300000ms exhausted; cutting short embeddedRuns=1 agentRuns=2",
      );
      expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      await startedThird.promise;
      expect(secondRestartDrainSignal?.aborted).toBe(true);
      const thirdAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
      expect(thirdAgentEventGeneration).not.toBe(secondAgentEventGeneration);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      await waitForLoopTurn();
      expectRestartCloseCall(closeSecond, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(mocks.markGatewayRestartHandled).toHaveBeenCalledTimes(2);
      expect(mocks.waitForActiveCronTaskRuns).toHaveBeenCalledTimes(2);
      expect(mocks.waitForActiveCronJobs).toHaveBeenCalledTimes(2);
      expect(mocks.advanceCronActiveJobGeneration).toHaveBeenCalledTimes(2);
      expect(mocks.retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(2);
      expect(mocks.resetCronActiveJobs).toHaveBeenCalledTimes(2);
      expect(mocks.clearRuntimeConfigSnapshot).toHaveBeenCalledTimes(2);
      expect(mocks.resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
      expect(mocks.resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
      expect(mocks.abortActiveCronTaskRuns).toHaveBeenCalledTimes(3);
      expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(3);
      expect(
        mocks.advanceCronActiveJobGeneration.mock.invocationCallOrder[0] ?? Infinity,
      ).toBeLessThan(mocks.abortActiveCronTaskRuns.mock.invocationCallOrder[1] ?? Infinity);
      expect(mocks.abortActiveCronTaskRuns.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        closeFirst.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(mocks.waitForActiveCronJobs.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        mocks.retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(
        mocks.retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity,
      ).toBeLessThan(mocks.resetCronActiveJobs.mock.invocationCallOrder[0] ?? Infinity);

      sigterm();
      await expect(exited).resolves.toBe(0);
      expectStopCloseCall(closeThird);
    }).finally(() => clock.mockRestore());
  });

  it("advances stale cron active markers after bounded restart cron-run drain", async () => {
    mocks.waitForActiveCronJobs.mockResolvedValueOnce({ drained: false, active: 1 });

    await mocks.withRunningGateway(async ({ captureSignal, start, exited }) => {
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length >= 2,
        "expected SIGUSR2 to trigger restart",
      );

      expect(mocks.abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
      expect(mocks.waitForActiveCronTaskRuns).toHaveBeenCalledWith(1_000);
      expect(mocks.waitForActiveCronJobs).toHaveBeenCalledWith(1_000);
      expect(mocks.advanceCronActiveJobGeneration).toHaveBeenCalledTimes(1);
      expect(mocks.retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(1);
      expect(mocks.resetCronActiveJobs).toHaveBeenCalledTimes(1);
      expect(mocks.gatewayLog.warn).toHaveBeenCalledWith(
        "cron run drain timed out during restart lifecycle reset after retiring old cron admission; 0 task handle(s) and 1 active marker(s) remain after aborting old cron runs",
      );

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it.each([false, true])(
    "processes SIGUSR2 queued before startup returns a server (startup fails: %s)",
    async (fails) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const firstClose = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const enterStartup = createDeferredCore();
        const startedReplacement = createDeferredCore();
        const start =
          vi.fn<Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"]>();
        if (fails) {
          start.mockResolvedValueOnce(createGatewayServer(firstClose));
        }
        start.mockImplementationOnce(async () => {
          await enterStartup.promise;
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => mocks.markGatewayRestartHandled.mock.calls.length === (fails ? 2 : 1),
            "expected queued SIGUSR2 before startup settled",
          );
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          if (fails) {
            throw new Error("restart startup failed");
          }
          return createGatewayServer(firstClose);
        });
        start.mockImplementationOnce(async () => {
          startedReplacement.resolve();
          return createGatewayServer(createCloseMock());
        });
        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        void runGatewayLoop({ start, runtime });
        await waitForLoopTurn();
        const sigterm = captureSignal("SIGTERM");
        try {
          if (fails) {
            captureSignal("SIGUSR2")();
          }
          enterStartup.resolve();
          await startedReplacement.promise;
          expect(start).toHaveBeenCalledTimes(fails ? 3 : 2);
          expectRestartCloseCall(firstClose, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
          expect(mocks.markGatewayRestartHandled).toHaveBeenCalledTimes(fails ? 2 : 1);
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
          expect(mocks.resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(
            fails ? 2 : 1,
          );
          expect(mocks.resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(
            fails ? 2 : 1,
          );
          expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(fails ? 3 : 2);
          if (fails) {
            expect(mocks.gatewayLog.error).toHaveBeenCalledWith(
              expect.stringContaining("gateway startup failed: restart startup failed."),
            );
          }
        } finally {
          enterStartup.resolve();
          sigterm();
          await expect(exited).resolves.toBe(0);
        }
      });
    },
  );

  it("expires a queued startup restart using the refreshed budget after an update upgrade", async () => {
    mocks.peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
    setPlatform("linux");
    mocks.systemctl.mockResolvedValue(systemdReply());
    await withLifecycleClock(async () => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const startupMayReturn = createDeferredCore();
        const startupEntered = createDeferredCore();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const start = vi.fn(async () => {
          startupEntered.resolve();
          await startupMayReturn.promise;
          return createGatewayServer(close);
        });

        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        void runGatewayLoop({
          start,
          runtime,
          completeBoot,
        });
        await vi.advanceTimersByTimeAsync(0);
        await startupEntered.promise;
        const restartSignal = captureSignal("SIGUSR2");

        const refreshed = systemdReply("330s");
        mocks.systemctl.mockResolvedValue(refreshed);
        const query = createDeferredCore<typeof refreshed>();
        mocks.systemctl.mockImplementationOnce(() => query.promise);
        restartSignal();
        await vi.advanceTimersByTimeAsync(0);
        mocks.peekGatewayRestartReason.mockReturnValue("update.run");
        mocks.consumeGatewayRestartIntent.mockReturnValueOnce({
          reason: "update.run",
          force: true,
        });
        restartSignal();
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.gatewayLog.info).toHaveBeenCalledWith(
          "received SIGUSR2 during shutdown; upgrading to update.run",
        );
        query.resolve(refreshed);
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.markGatewayRestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();

        await advanceWithoutCalls(324_999, runtime.exit);
        await vi.advanceTimersByTimeAsync(1);

        expect(runtime.exit).not.toHaveBeenCalled();
        startupMayReturn.resolve();
        await expect(exited).resolves.toBe(1);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "forced_stop",
          reason: "gateway.restart_startup_request_timeout",
        });
        expect(close).toHaveBeenCalledExactlyOnceWith({
          retainSharedState: true,
          reason: "gateway stopping",
        });
        expect(start).toHaveBeenCalledTimes(1);
        expect(mocks.gatewayLog.error).toHaveBeenCalledWith(
          "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
        );
      });
    });
  });

  it.each(["restart-then-stop", "cleanup-failure", "repaired-systemd"] as const)(
    "joins admitted startup cleanup for %s before exiting",
    async (scenario) => {
      if (scenario === "repaired-systemd") {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        mocks.systemctl.mockResolvedValue(systemdReply());
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore<AbortSignal>();
        const cleanup = createDeferredCore();
        const activeDrain = createDeferredCore();
        mocks.waitForGatewayActiveWork.mockImplementationOnce(async () => {
          await activeDrain.promise;
          return { drained: true, snapshot: mocks.idleActiveWorkSnapshot };
        });
        const cleanupFailure = new Error("startup snapshot cleanup failed");
        const completeBoot = vi.fn();
        const close = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
          await options!.startupOperation!(async (signal) => {
            entered.resolve(signal);
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await cleanup.promise;
            throw scenario === "cleanup-failure" ? cleanupFailure : signal.reason;
          });
          return createGatewayServer(close);
        };
        const loop = runGatewayLoop({ start, runtime, completeBoot });
        const settled = Promise.allSettled([loop]);
        let loopFinished = false;
        void settled.then(() => {
          loopFinished = true;
        });
        const signal = await entered.promise;
        const stopSignal = scenario === "repaired-systemd" ? "SIGTERM" : "SIGINT";
        if (scenario === "repaired-systemd") {
          mocks.systemctl.mockResolvedValue(systemdReply("330s"));
          vi.useFakeTimers();
        }
        const flush = async () => {
          if (scenario === "repaired-systemd") {
            await vi.advanceTimersByTimeAsync(0);
          } else {
            await waitForLoopTurn();
          }
        };
        try {
          if (scenario === "restart-then-stop") {
            captureSignal("SIGUSR2")();
            await waitForLoopCondition(
              () => mocks.markGatewayRestartHandled.mock.calls.length > 0,
              "expected queued startup restart",
            );
            expect(signal.aborted).toBe(false);
          }
          captureSignal(stopSignal)();
          await flush();
          expect(signal.aborted).toBe(true);
          // A duplicate signal cannot bypass the already admitted cleanup join.
          captureSignal(stopSignal)();
          if (scenario === "repaired-systemd") {
            await vi.advanceTimersByTimeAsync(60_000);
          }
          await flush();
          expectUncalled(runtime.exit, completeBoot);
          cleanup.resolve();
          await flush();
          expect(loopFinished).toBe(false);
          expectUncalled(runtime.exit, completeBoot);
          activeDrain.resolve();
          await flush();
          if (scenario === "cleanup-failure") {
            expect(await settled).toEqual([{ status: "rejected", reason: cleanupFailure }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "forced_stop",
              reason: "gateway.stop_close_failed",
            });
          } else {
            await expect(exited).resolves.toBe(0);
            expect(await settled).toEqual([{ status: "fulfilled", value: 0 }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "clean_stop",
              reason: `stop (${stopSignal})`,
            });
          }
          expect(close).not.toHaveBeenCalled();
        } finally {
          if (!signal.aborted) {
            captureSignal("SIGINT")();
          }
          cleanup.resolve();
          activeDrain.resolve();
          await flush();
          await settled;
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    { signal: "SIGTERM", cleanStop: true },
    { signal: "SIGKILL", cleanStop: false },
  ] as const)(
    "joins an accepted stop before classifying an independent startup worker: $signal",
    async ({ signal, cleanStop }) => {
      const { SqliteIntegrityWorkerInterruptedError } =
        await import("../../infra/sqlite-integrity-worker-error.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore();
        const inspection = createDeferredCore();
        const drainEntered = createDeferredCore();
        const drain = createDeferredCore();
        mocks.waitForGatewayActiveWork.mockImplementationOnce(async () => {
          drainEntered.resolve();
          await drain.promise;
          return { drained: true, snapshot: mocks.idleActiveWorkSnapshot };
        });
        const failure = new SqliteIntegrityWorkerInterruptedError(signal, "starting");
        const completeBoot = vi.fn();
        const close = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        const loop = runGatewayLoop({
          start: async () => {
            entered.resolve();
            await inspection.promise;
            return createGatewayServer(close);
          },
          runtime,
          completeBoot,
        });
        const settled = Promise.allSettled([loop]);
        try {
          await entered.promise;
          captureSignal("SIGTERM")();
          await drainEntered.promise;
          inspection.reject(failure);
          await waitForLoopTurn();
          expect(runtime.exit).not.toHaveBeenCalled();
          if (cleanStop) {
            expect(completeBoot).not.toHaveBeenCalled();
          }
          drain.resolve();
          if (cleanStop) {
            await expect(exited).resolves.toBe(0);
            expect(await settled).toEqual([{ status: "fulfilled", value: 0 }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "clean_stop",
              reason: "stop (SIGTERM)",
            });
          } else {
            expect(await settled).toEqual([{ status: "rejected", reason: failure }]);
            expect(completeBoot).toHaveBeenCalledWith({
              outcome: "startup_failed",
              reason: failure.message,
            });
          }
          expect(close).not.toHaveBeenCalled();
        } finally {
          inspection.reject(failure);
          drain.resolve();
          await settled;
          if (cleanStop) {
            await exited;
          }
        }
      });
    },
  );

  it.each(["stopped", "started"] as const)(
    "refuses retained startup work after %s",
    async (phase) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore<GatewayStartupOperation>();
        const resumeStartup = createDeferredCore();
        const close = createCloseMock();
        const acquireResource = vi.fn(async () => {});
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.test-support.js");
        const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
          entered.resolve(options!.startupOperation!);
          if (phase === "stopped") {
            await resumeStartup.promise;
            await options!.startupOperation!(acquireResource);
          }
          return createGatewayServer(close);
        };
        const loop = runGatewayLoop({ start, runtime });
        const observed = loop.catch(() => {});
        const startupOperation = await entered.promise;
        try {
          if (phase === "stopped") {
            captureSignal("SIGINT")();
            await waitForLoopTurn();
            expect(runtime.exit).not.toHaveBeenCalled();
          } else {
            await waitForLoopTurn();
          }
          await expect(startupOperation(acquireResource)).rejects.toMatchObject({
            name: "AbortError",
          });
          expect(acquireResource).not.toHaveBeenCalled();
        } finally {
          resumeStartup.resolve();
          if (phase === "started") {
            captureSignal("SIGINT")();
            await exited;
          } else {
            await observed;
          }
        }
      });
    },
  );

  it.each([true, false])(
    "clears the SIGUSR2 token before applying external restart policy (allowed: %s)",
    async (allowed) => {
      mocks.consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
      mocks.isGatewayRestartExternallyAllowed.mockReturnValueOnce(allowed);
      await mocks.withRunningGateway(async ({ captureSignal, close, start }) => {
        const restartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        captureSignal("SIGUSR2")();
        await waitForLoopTurn();
        expect(mocks.markGatewayRestartHandled).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        if (allowed) {
          expect(mocks.scheduleGatewayRestart).toHaveBeenCalledWith({
            delayMs: 0,
            reason: "SIGUSR2",
          });
          expect(mocks.markGatewayRestartHandled.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.scheduleGatewayRestart.mock.invocationCallOrder[0] ?? 0,
          );
        } else {
          expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
          expect(restartDrainSignal.aborted).toBe(false);
          expect(gatewayWorkAdmissionActual.isGatewayRestartDraining()).toBe(false);
          expect(mocks.gatewayLog.warn.mock.calls).toEqual([
            ["SIGUSR2 restart ignored (not authorized; commands.restart=false)."],
            [
              "An unauthorized SIGUSR2 restart signal was received and ignored. " +
                "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
                "or restart the gateway through your service manager.",
            ],
          ]);
        }
      });
    },
  );

  it.each([true, false])(
    "consumes file-intent SIGUSR2 and cancels pending reloads (authorized=%s)",
    async (authorized) => {
      mocks.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({
        force: true,
        reason: "file-intent restart",
      });
      mocks.consumeGatewayRestartAuthorization.mockReturnValueOnce(authorized);
      mocks.createGatewayActiveWorkSnapshot.mockReturnValue(
        createActiveWorkSnapshot({ embeddedRuns: 1 }, [
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]),
      );

      await mocks.withRunningGateway(async ({ captureSignal, start, exited }) => {
        captureSignal("SIGUSR2")();
        await waitForLoopTurn();
        await waitForLoopTurn();

        expect(mocks.abortPendingChannelReloads).toHaveBeenCalledOnce();
        expect(mocks.consumeGatewayRestartAuthorization).toHaveBeenCalledOnce();
        expect(mocks.markGatewayRestartHandled).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledTimes(2);

        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    },
  );

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    mocks.peekGatewayRestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      mocks.acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(
          new Error("failed to acquire gateway state ownership", {
            cause: new Error("owner lease inspection failed", {
              cause: new Error("fixture native read failed"),
            }),
          }),
        );

      mocks.restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await mocks.createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      restartSignal();

      await expect(exited).resolves.toBe(1);
      expect(mocks.acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(mocks.gatewayLog.error).toHaveBeenCalledWith(
        "failed to reacquire gateway lock for in-process restart: failed to acquire gateway state ownership | owner lease inspection failed | fixture native read failed",
      );
    });
  });

  registerUpdateRespawnProgressTests(fixtures);

  registerUpdateRespawnTests(fixtures);

  it("keeps SIGTERM restart ownership when an update arrives during shutdown", async () => {
    mocks.consumeGatewayRestartIntentPayload.mockResolvedValueOnce({ reason: "gateway.restart" });
    mocks.peekGatewayRestartReason.mockReturnValueOnce("update.run");
    const closing = createDeferred();
    const close = vi.fn<GatewayCloseFn>(() => closing.promise);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const completeBoot = vi.fn();
      const { start, runtime, exited } = await mocks.createSignaledLoopHarness(undefined, false, {
        close,
        completeBoot,
      });
      try {
        captureSignal("SIGTERM")();
        await waitForLoopCondition(() => close.mock.calls.length === 1, "close did not start");
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => mocks.markGatewayRestartHandled.mock.calls.length === 1,
          "update signal was not handled",
        );
        closing.resolve();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
          "SIGTERM restart did not finish",
        );
        expect(start).toHaveBeenCalledOnce();
        await expect(exited).resolves.toBe(0);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "planned_restart",
          reason: "restart (SIGTERM: gateway.restart)",
        });
        expectUncalled(
          mocks.restartGatewayProcessWithFreshPid,
          mocks.respawnGatewayProcessForUpdate,
        );
      } finally {
        closing.resolve();
      }
    });
  });

  it.each(["close", "lock release"] as const)(
    "upgrades an accepted restart when an update arrives during %s",
    async (phase) => {
      mocks.peekGatewayRestartReason
        .mockReturnValueOnce("config.patch")
        .mockReturnValueOnce("update.auto");
      mocks.restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });
      const gate = createLifecycleGate();
      if (phase === "close") {
        setPlatform("freebsd");
      } else {
        mocks.acquireGatewayLock.mockResolvedValueOnce({ release: vi.fn(gate.wait) });
      }
      process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      try {
        await mocks.withRunningGateway(async ({ captureSignal, close, exited }) => {
          if (phase === "close") {
            close.mockImplementationOnce(gate.wait);
          }
          captureSignal("SIGUSR2")();
          await gate.entered;
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => mocks.markGatewayRestartHandled.mock.calls.length === 2,
            "second restart signal was not handled",
          );
          gate.release();
          await expect(exited).resolves.toBe(0);
          expect(mocks.restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
          mocks.expectRestartHandoffCall({
            restartKind: "update-process",
            reason: "update.auto",
            supervisorMode: "external",
          });
        }, phase === "close");
      } finally {
        gate.release();
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
      }
    },
  );

  it.each(["replacement owner", "broken control pipe"] as const)(
    "reopens admission only after exact helper cancellation for %s",
    async (scenario) => {
      const replacement = scenario === "replacement owner";
      const replacementOwner = { ...managedUpdateSuccessorOwner, handoffId: "replacement-handoff" };
      mocks.consumeGatewayRestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      const helper = createLifecycleGate();
      if (replacement) {
        mocks.consumeGatewayRestartIntent.mockReturnValueOnce({
          reason: "update.auto",
          successorOwner: replacementOwner,
        });
        mocks.cancelManagedServiceUpdateHandoff
          .mockResolvedValueOnce("restored-in-process")
          .mockResolvedValueOnce("restored-in-process");
        mocks.commitManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
          await helper.wait();
          return true;
        });
      } else {
        mocks.requestManagedServiceUpdateHandoffPark.mockResolvedValueOnce(false);
        mocks.cancelManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
          await helper.wait();
          return "restored-in-process";
        });
      }
      setPlatform("linux");
      process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      process.env.OPENCLAW_SERVICE_KIND = "gateway";
      try {
        await mocks.withRunningGateway(async ({ captureSignal, start, runtime, exited }) => {
          const restartSignal = captureSignal("SIGUSR2");
          restartSignal();
          await helper.entered;
          if (replacement) {
            expect(mocks.commitManagedServiceUpdateHandoff).toHaveBeenCalledOnce();
            restartSignal();
            await waitForLoopCondition(
              () => mocks.consumeGatewayRestartIntent.mock.calls.length === 2,
              "replacement owner was not admitted before exit",
            );
          } else {
            expect(mocks.cancelManagedServiceUpdateHandoff).toHaveBeenCalledOnce();
            expect(start).toHaveBeenCalledOnce();
            expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          }
          helper.release();
          await waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "helper cancellation did not reopen gateway admission",
          );
          if (replacement) {
            expect(mocks.requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(mocks.commitManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
              "update",
            );
            expect(mocks.cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(
              1,
              managedUpdateSuccessorOwner,
            );
            expect(mocks.cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(
              2,
              replacementOwner,
            );
          } else {
            expect(mocks.cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(mocks.commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          }
          expect(runtime.exit).not.toHaveBeenCalled();
          if (replacement) {
            expect(start).toHaveBeenCalledTimes(2);
          }
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
          captureSignal("SIGINT")();
          await expect(exited).resolves.toBe(0);
        });
      } finally {
        helper.release();
      }
    },
  );

  it("recovers a dead update child when readiness reports it stopped", async () => {
    mocks.peekGatewayRestartReason.mockReturnValue("update.run");
    const kill = vi.fn();
    mocks.respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 8888,
      child: Object.assign(createUpdateRespawnChild(8888), { kill, exitCode: 1 }),
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      mocks.waitForGatewayHealthyRestart.mockResolvedValueOnce(
        mocks.respawnHealth({
          healthy: false,
          waitOutcome: "stopped-free",
          runtime: { status: "stopped" },
        }),
      );
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { start, started } = createSignaledStart(closeFirst);

      await mocks.runLoopWithStart({ start, runtime, lockPort: 18789, healthHost: "10.0.0.25" });
      await waitForStart(started);
      start.mockResolvedValue(createGatewayServer(closeSecond));
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopTurn();

      expect(mocks.waitForGatewayHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({ port: 18789, probeHosts: ["10.0.0.25"] }),
      );
      expect(kill).toHaveBeenCalledTimes(1);
      expect(mocks.markUpdateRestartSentinelFailure).toHaveBeenCalledWith("restart-unhealthy");
      expect(start).toHaveBeenCalledTimes(2);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("catches SIGTERM handler errors, logs them, and falls back to stop (#83131)", async () => {
    mocks.consumeGatewayRestartIntentPayload.mockRejectedValueOnce(
      new Error("dynamic import failed"),
    );

    await mocks.withRunningGateway(async ({ captureSignal, close, runtime, exited }) => {
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(mocks.gatewayLog.error).toHaveBeenCalledWith(
        "failed to handle SIGTERM: Error: dynamic import failed",
      );
      expectStopCloseCall(close);
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("recloses restart admission after a failed SIGUSR2 handler rolls it back", async () => {
    mocks.markGatewayRestartHandled.mockImplementationOnce(() => {
      throw new Error("restart token cleanup failed");
    });

    await mocks.withRunningGateway(async ({ captureSignal, close, start, exited }) => {
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopCondition(
        () => mocks.rollbackGatewayRestartSignalAdmission.mock.calls.length === 1,
        "failed SIGUSR2 handler did not roll back restart admission",
      );

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "second SIGUSR2 did not start a restart",
      );

      expect(close).toHaveBeenCalledTimes(1);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });
  it("waits for the launchd restart throttle before settling a successful handoff", async () => {
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    mocks.restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(true),
    });
    await mocks.withRunningGateway(async ({ captureSignal, runtime, exited }) => {
      vi.useFakeTimers();
      captureSignal("SIGUSR2")();
      await advanceWithoutCalls(1499, runtime.exit);
      await vi.advanceTimersByTimeAsync(1);
      await expect(exited).resolves.toBe(0);
      expect(runtime.exit).toHaveBeenCalledWith(0);
      mocks.expectRestartHandoffCall({
        restartKind: "full-process",
        reason: undefined,
        supervisorMode: "launchd",
      });
    });
  });

  it("bounds a launchd-supervised stop on the deadline the printed job reports", async () => {
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    mocks.readLaunchdStopTimeout.mockResolvedValue({
      stop: { timeoutMs: 30_000, source: "launchd system/ai.openclaw.gateway exit timeout" },
    });
    mocks.hasManagedProviderLocalServices.mockReturnValue(true);
    const providerCleanup = createDeferredCore();
    mocks.stopManagedProviderLocalServices.mockReturnValue(providerCleanup.promise);
    await mocks.withRunningGateway(async ({ captureSignal, close, runtime }) => {
      await withLifecycleClock(async () => {
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(24_999);
          expect(close).toHaveBeenCalledOnce();
          expect(mocks.stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
          // launchd owns the status, not permission to abandon accepted cleanup.
          expect(runtime.exit).not.toHaveBeenCalled();
          providerCleanup.resolve();
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
          expect(mocks.writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
            "gateway.stop_shutdown_timeout",
            undefined,
          );
          expect(mocks.gatewayLog.info).toHaveBeenCalledWith(
            "shutdown budget at shutdown: drain=15000ms shutdown=25000ms reserve=10000ms exitMargin=5000ms; source=launchd system/ai.openclaw.gateway exit timeout=30000ms",
          );
        } finally {
          vi.clearAllTimers();
        }
      });
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
