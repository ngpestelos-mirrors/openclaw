import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { gatewayWorkAdmissionActual, runLoopFixture } from "./run-loop-mocks.test-support.js";
import {
  createLifecycleGate,
  advanceWithoutCalls,
  expectUncalled,
  createCloseMock,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  systemdReply,
  withLifecycleClock,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const {
  acquireGatewayLock,
  waitForGatewayActiveWork,
  idleActiveWorkSnapshot,
  flushLogger,
  createSignaledLoopHarness,
  withRunningGateway,
  gatewayLog,
  systemctl,
  restartGatewayProcessWithFreshPid,
  waitForActiveCronTaskRuns,
} = runLoopFixture;

export function registerNaturalExitTests(waitForLoopTurn: () => Promise<void>) {
  it("preserves startup and final retirement failures after every cleanup owner settles", async () => {
    const startupFailure = new Error("fixture boot failed");
    const releaseFailure = new Error("fixture lock retirement failed");
    const release = vi.fn(async () => {
      throw releaseFailure;
    });
    const receipt = vi.fn();
    acquireGatewayLock.mockResolvedValueOnce({ release });
    await withIsolatedSignals(async () => {
      const { runGatewayLoop } = await import("./run-loop.js");
      await expect(
        runGatewayLoop({
          ownsProcessLifecycle: true,
          beginBoot: async () => {
            throw startupFailure;
          },
          start: async () => createGatewayServer(createCloseMock()),
          onProcessResourcesSettled: receipt,
        }),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [startupFailure, releaseFailure],
        cause: startupFailure,
      });
      expect(release).toHaveBeenCalledOnce();
      expect(receipt).toHaveBeenCalledExactlyOnceWith("retained");
    });
  });

  it("joins a late startup handle and final cleanup before returning the terminal code", async ({
    signal,
  }) => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const entered = createDeferredCore();
      const started = createDeferredCore<GatewayServer>();
      const draining = createDeferredCore();
      const closeGate = createLifecycleGate();
      const flushGate = createLifecycleGate();
      const order: string[] = [];
      const drained = vi.fn();
      const close = vi.fn(async () => {
        order.push("close");
        await closeGate.wait();
      });
      acquireGatewayLock.mockResolvedValueOnce({
        release: vi.fn(async () => {
          order.push("release");
        }),
      });
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        draining.resolve();
        return { drained: true, snapshot: idleActiveWorkSnapshot };
      });
      flushLogger.mockImplementationOnce(async () => {
        order.push("flush");
        await flushGate.wait();
      });
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      const { runtime } = createRuntimeWithExitSignal();
      const loop = runGatewayLoop({
        runtime,
        onProcessResourcesSettled: drained,
        start: async () => {
          entered.resolve();
          return started.promise;
        },
      });
      let settled = false;
      void loop.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        captureSignal("SIGTERM")();
        await draining.promise;
        await waitForLoopTurn();
        expectUncalled(flushLogger, close);
        started.resolve(createGatewayServer(close));
        await withinTest(closeGate.entered, signal);
        expect(flushLogger).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        closeGate.release();
        await flushGate.entered;
        expect(settled).toBe(false);
        expect(drained).not.toHaveBeenCalled();
        flushGate.release();
        await expect(withinTest(loop, signal)).resolves.toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(order).toEqual(["close", "release", "flush"]);
        expect(drained).toHaveBeenCalledExactlyOnceWith("drained");
      } finally {
        started.resolve(createGatewayServer(close));
        closeGate.release();
        flushGate.release();
      }
    });
  });

  it("owns output failure without a stdin lifeline until Gateway cleanup joins", async () => {
    const previousCode = process.exitCode;
    const { exitAfterSignalExitBarriers, registerSignalExitOwner } =
      await import("../signal-exit-barrier.js");
    const closeGate = createLifecycleGate();
    try {
      await withRunningGateway(async ({ close, runtime, exited }) => {
        close.mockImplementationOnce(closeGate.wait);
        exitAfterSignalExitBarriers(7);
        await closeGate.entered;
        expect(gatewayLog.info).toHaveBeenCalledWith("received process exit; shutting down");
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(previousCode);
        closeGate.release();
        await expect(exited).resolves.toBe(7);
        expect(close).toHaveBeenCalledOnce();
        // The native process owner is released only after the loop actually returns.
        const release = registerSignalExitOwner(() => {});
        release();
      }, true);
    } finally {
      closeGate.release();
      process.exitCode = previousCode;
    }
  });

  it.each(["running", "restarting", "stopping", "updating-close", "updating-handoff"] as const)(
    "records an unhandled rejection stop reason while %s",
    async (phase) => {
      const { exitAfterSignalExitBarriers } = await import("../signal-exit-barrier.js");
      const closeGate = createLifecycleGate();
      const handoffEntered = createDeferredCore();
      const handoffFinished = createDeferredCore<{ respawn: boolean }>();
      const completeBoot = vi.fn();
      const updating = phase === "updating-close" || phase === "updating-handoff";
      if (updating) {
        runLoopFixture.consumeGatewayRestartIntent.mockReturnValueOnce({
          reason: "update.run",
          successorOwner: {
            kind: "managed-update-handoff",
            handoffId: "stop-reason-test",
            installRoot: "/openclaw/install",
          },
        });
        runLoopFixture.isForegroundUpdateHandoff.mockReturnValue(true);
        runLoopFixture.completeForegroundUpdateHandoffAfterClose.mockImplementationOnce(() => {
          handoffEntered.resolve();
          return handoffFinished.promise;
        });
      }
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { exited } = await createSignaledLoopHarness(undefined, true, {
            close: createCloseMock().mockImplementationOnce(closeGate.wait),
            completeBoot,
          });
          if (phase !== "running") {
            captureSignal(phase === "stopping" ? "SIGTERM" : "SIGUSR2")();
            await closeGate.entered;
          }
          if (phase === "updating-handoff") {
            closeGate.release();
            await handoffEntered.promise;
          }
          exitAfterSignalExitBarriers(1, "unhandled rejection");
          await closeGate.entered;
          closeGate.release();
          handoffFinished.resolve({ respawn: true });
          await expect(exited).resolves.toBe(1);
          expect(completeBoot).toHaveBeenCalledWith({
            outcome: "clean_stop",
            reason: "stop (process exit: unhandled rejection)",
          });
          expect(gatewayLog.info).toHaveBeenCalledWith(
            updating
              ? "received SIGTERM; stopping after foreground update settlement"
              : phase !== "running"
                ? "received unhandled rejection during shutdown; finishing shutdown without restart"
                : "received unhandled rejection; shutting down",
          );
        });
      } finally {
        closeGate.release();
        handoffFinished.resolve({ respawn: false });
      }
    },
  );

  it.each([
    { deadline: false, failed: false },
    { deadline: true, failed: false },
    { deadline: false, failed: true },
  ])(
    "joins watchdog retirement before completion (deadline=$deadline, rejected=$failed)",
    async ({ deadline, failed }) => {
      const cancelGate = createLifecycleGate();
      const closeGate = createLifecycleGate();
      const failure = new Error("native watchdog retirement failed");
      const drained = vi.fn();
      const watchdog = runLoopFixture.cancelShutdownHardExitWatchdog;
      if (deadline) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        systemctl.mockResolvedValue(systemdReply());
      } else {
        watchdog.mockImplementationOnce(cancelGate.wait);
      }
      await withRunningGateway(
        async ({ captureSignal, close, runtime, exited, loopPromise }) => {
          if (deadline) {
            close.mockImplementationOnce(closeGate.wait);
          }
          const retire = async () => {
            try {
              captureSignal("SIGTERM")();
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
                await closeGate.entered;
                watchdog.mockClear().mockImplementationOnce(cancelGate.wait);
                await advanceWithoutCalls(25_000, runtime.exit, watchdog);
                closeGate.release();
                await vi.advanceTimersByTimeAsync(0);
                await awaitGateBeforeSettlement(
                  cancelGate.entered,
                  exited,
                  "Gateway returned while its deadline watchdog was still armed",
                );
              } else {
                await cancelGate.entered;
              }
              expect(runtime.exit).not.toHaveBeenCalled();
              if (failed) {
                cancelGate.reject(failure);
              } else {
                cancelGate.release();
              }
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
              }
              await expect(loopPromise).resolves.toBe(failed ? 1 : 0);
              await expect(exited).resolves.toBe(failed ? 1 : 0);
              if (deadline) {
                expect(watchdog).toHaveBeenCalledOnce();
              }
              if (failed) {
                expect(drained).toHaveBeenCalledExactlyOnceWith("retained");
                expect(gatewayLog.error).toHaveBeenCalledWith(
                  "gateway lifecycle completion failed: native watchdog retirement failed",
                );
              }
            } finally {
              closeGate.release();
              cancelGate.release();
              if (deadline) {
                await vi.advanceTimersByTimeAsync(0);
                await exited;
              }
            }
          };
          await (deadline ? withLifecycleClock(retire) : retire());
        },
        true,
        failed ? { onProcessResourcesSettled: drained } : {},
      );
    },
  );

  it.each(["close", "restart-startup"] as const)(
    "does not report success when %s fails after a supervised zero-status deadline",
    async (phase) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      systemctl.mockResolvedValue(systemdReply());
      const failure = new Error("late owned cleanup failed");
      const phaseGate = createLifecycleGate();
      const drained = vi.fn();
      const close = createCloseMock();
      if (phase === "close") {
        close.mockImplementationOnce(async () => {
          await phaseGate.wait();
        });
      }
      const { start, started } = createSignaledStart(close);
      const startedInitial = createDeferredCore();
      if (phase === "restart-startup") {
        start.mockImplementationOnce(async () => {
          startedInitial.resolve();
          return createGatewayServer(close);
        });
        start.mockImplementationOnce(async () => {
          await phaseGate.wait();
          return createGatewayServer(close);
        });
      }
      const { runtime } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const loop = runGatewayLoop({ start, runtime, onProcessResourcesSettled: drained });
        const outcome = loop.then(
          (code) => ({ code }),
          (error: unknown) => ({ error }),
        );
        await waitForStart(phase === "close" ? started : startedInitial.promise);
        if (phase === "restart-startup") {
          captureSignal("SIGUSR2")();
          await phaseGate.entered;
        }
        await withLifecycleClock(async () => {
          try {
            captureSignal("SIGTERM")();
            await advanceWithoutCalls(25_000, runtime.exit);
            phaseGate.reject(failure);
            await vi.advanceTimersByTimeAsync(0);
            await expect(outcome).resolves.toEqual(
              phase === "close" ? { code: 1 } : { error: failure },
            );
            expect(drained).toHaveBeenCalledExactlyOnceWith(
              phase === "close" ? "retained" : "drained",
            );
          } finally {
            phaseGate.release();
            await vi.advanceTimersByTimeAsync(0);
          }
        });
      });
    },
  );

  it.each(["host-retirement", "restart-preparation", "begin-boot"] as const)(
    "does not acquire another generation after a terminal decision during %s",
    async (phase) => {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      systemctl.mockResolvedValue(systemdReply());
      const phaseGate = createLifecycleGate();
      let blockRetirement = false;
      let retirementBlocked = false;
      const hostModule = await import("./host-lifecycle.js");
      const createHost = hostModule.createGatewayHostLifecycle;
      const hostFactory = vi
        .spyOn(hostModule, "createGatewayHostLifecycle")
        .mockImplementation((params) => {
          const owner = createHost(params);
          return {
            ...owner,
            retire: async () => {
              await owner.retire();
              if (phase === "host-retirement" && blockRetirement && !retirementBlocked) {
                retirementBlocked = true;
                await phaseGate.wait();
              }
            },
          };
        });
      if (phase === "host-retirement") {
        restartGatewayProcessWithFreshPid.mockImplementationOnce(() => {
          blockRetirement = true;
          return { mode: "disabled" };
        });
      }
      if (phase === "restart-preparation") {
        waitForActiveCronTaskRuns.mockImplementationOnce(async () => {
          await phaseGate.wait();
          return { drained: true, active: 0 };
        });
      }
      const beginBoot = vi.fn(async () => {
        if (phase === "begin-boot") {
          await phaseGate.wait();
        }
      });
      const { start, started } = createSignaledStart(createCloseMock());
      const { runtime } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const { runGatewayLoop } = await import("./run-loop.test-support.js");
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const loop = runGatewayLoop({ start, runtime, beginBoot, completeBoot });
          if (phase !== "begin-boot") {
            await waitForStart(started);
            captureSignal("SIGUSR2")();
          }
          await phaseGate.entered;
          await withLifecycleClock(async () => {
            try {
              captureSignal("SIGUSR2")();
              await vi.advanceTimersByTimeAsync(25_000);
              expect(completeBoot).toHaveBeenCalledWith(
                expect.objectContaining({ outcome: "forced_stop" }),
              );
              phaseGate.release();
              await vi.advanceTimersByTimeAsync(0);
              await expect(loop).resolves.toBe(1);
              expect(start).toHaveBeenCalledTimes(phase === "begin-boot" ? 0 : 1);
              expect(beginBoot).toHaveBeenCalledOnce();
              expect(hostFactory).toHaveBeenCalledTimes(phase === "restart-preparation" ? 2 : 1);
              expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
            } finally {
              phaseGate.release();
              await vi.advanceTimersByTimeAsync(0);
            }
          });
        });
      } finally {
        phaseGate.release();
        hostFactory.mockRestore();
      }
    },
  );
}
