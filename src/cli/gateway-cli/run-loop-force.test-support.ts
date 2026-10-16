import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createActiveWorkSnapshot,
  expectRestartCloseCall,
  systemdReply,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerGatewayForcedRestartTests({
  createSignaledLoopHarness,
  createGatewayActiveWorkSnapshot,
  abortActiveCronTaskRuns,
  waitForGatewayActiveWork,
  consumeGatewayRestartIntent,
  readCgroup,
  systemctl,
}: UpdateRespawnFixtures): void {
  const idleActiveWorkSnapshot = createActiveWorkSnapshot();
  it("preserves the native drain and hard deadline after deferral expires", async () => {
    readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
    systemctl.mockResolvedValue(systemdReply("90s"));
    const active = createActiveWorkSnapshot({ agentRuns: 1, embeddedRuns: 1, cronRuns: 1 });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
    const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
    waitForGatewayActiveWork.mockImplementationOnce(() => drain.promise);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const restart =
        await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js");
      const closing = createDeferredCore();
      close.mockImplementationOnce(() => closing.promise);
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      const deferral = restart.deferGatewayRestartUntilIdle({
        getPendingCount: () => 1,
        maxWaitMs: 300_000,
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        emitHooks: {
          emitRestart: (_reason, intent) => {
            consumeGatewayRestartIntent.mockReturnValueOnce(intent ?? null);
            restartSignal();
            return { status: "emitted" };
          },
        },
      });
      try {
        await vi.advanceTimersByTimeAsync(300_000);
        expect(waitForGatewayActiveWork).toHaveBeenCalledExactlyOnceWith(
          75_000,
          expect.any(Object),
        );
        expect(close).not.toHaveBeenCalled();
        expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        captureSignal("SIGINT")();
        expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(75_000);
        expect(close).not.toHaveBeenCalled();
        expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
        drain.resolve({ drained: false, snapshot: active });
        await vi.advanceTimersByTimeAsync(0);
        expectRestartCloseCall(close, 0);
        expect(abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).not.toHaveBeenCalled();
        closing.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(start).toHaveBeenCalledOnce();
      } finally {
        deferral.cancel();
        restart.resetGatewayRestartStateForInProcessRestart();
        drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
        closing.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (runtime.exit.mock.calls.length === 0) {
          captureSignal("SIGINT")();
          await vi.advanceTimersByTimeAsync(0);
        }
        await exited;
        clock.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("records cut work only when the forced caller drain budget expires", async () => {
    const budget = 45_000;
    const refreshMs = 10_000;
    const active = createActiveWorkSnapshot({ agentRuns: 1, cronRuns: 1 });
    const drain = createDeferredCore<{ drained: boolean; snapshot: typeof active }>();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const nativeReply = systemdReply("330s");
    readCgroup.mockResolvedValue("0::/system.slice/openclaw-gateway.service\n");
    systemctl.mockResolvedValue(nativeReply);
    consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(active);
    waitForGatewayActiveWork.mockImplementationOnce((timeoutMs) => {
      if (timeoutMs !== undefined) {
        deadline = setTimeout(() => drain.resolve({ drained: false, snapshot: active }), timeoutMs);
      }
      return drain.promise;
    });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const closing = createDeferredCore();
      const completeBoot = vi.fn();
      const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, false, {
        completeBoot,
      });
      close.mockImplementationOnce(() => closing.promise);
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
      systemctl.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(nativeReply), refreshMs);
          }),
      );
      try {
        captureSignal("SIGUSR2")();
        await vi.advanceTimersByTimeAsync(budget - 1);
        expect(close).not.toHaveBeenCalled();
        expect(abortActiveCronTaskRuns).not.toHaveBeenCalled();
        expect(completeBoot).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(abortActiveCronTaskRuns).toHaveBeenCalledWith(undefined);
        expectRestartCloseCall(close, 0);
        const warning = `restart drain budget ${budget - refreshMs}ms exhausted; cutting short cronRuns=1 agentRuns=1`;
        expect(start).toHaveBeenCalledOnce();
        expect(completeBoot).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(completeBoot).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(runtime.exit).not.toHaveBeenCalled();
        closing.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
        expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
          outcome: "forced_stop",
          reason: `${warning}; gateway.restart_shutdown_timeout`,
        });
        expect(start).toHaveBeenCalledOnce();
      } finally {
        clearTimeout(deadline);
        drain.resolve({ drained: true, snapshot: idleActiveWorkSnapshot });
        closing.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (runtime.exit.mock.calls.length === 0) {
          captureSignal("SIGINT")();
          await vi.advanceTimersByTimeAsync(0);
        }
        await exited;
        clock.mockRestore();
        vi.useRealTimers();
      }
    });
  });
}
