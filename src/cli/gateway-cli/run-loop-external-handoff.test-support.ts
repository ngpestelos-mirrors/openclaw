import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createLifecycleGate,
  expectRestartCloseCall,
  expectStopCloseCall,
  expectUncalled,
  waitForLoopCondition,
  withIsolatedSignals,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerExternalHandoffShutdownTests({
  consumeGatewaySuspendHandoff,
  consumeGatewayRestartIntentPayload,
  acquireGatewayLock,
  createSignaledLoopHarness,
  waitForGatewayActiveWork,
  restartGatewayProcessWithFreshPid,
  respawnGatewayProcessForUpdate,
  writeGatewayRestartHandoff,
  cancelShutdownHardExitWatchdog,
  gatewayLog,
  isGatewayWorkAdmissionClosed,
}: UpdateRespawnFixtures): void {
  const holdHandoff = () => {
    const gate = createLifecycleGate();
    const write = writeGatewayRestartHandoff.getMockImplementation()!;
    writeGatewayRestartHandoff.mockImplementationOnce(async (...args) => {
      await gate.wait();
      return write(...args);
    });
    return gate;
  };
  const supervise = (
    marker = "OPENCLAW_SUPERVISOR_MODE",
    value = "external",
    exitCode?: number,
  ) => {
    process.env[marker] = value;
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised", exitCode });
  };
  it.each([
    { fails: true, trigger: "signal" },
    { fails: false, trigger: "commit" },
    { fails: false, trigger: "persisted-intent" },
  ])(
    "joins external restart cleanup without a successor ($trigger, close failure: $fails)",
    async ({ fails, trigger }) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const cleanup = createLifecycleGate();
        close.mockImplementationOnce(cleanup.wait);
        consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
          expect(owner).toBe(host?.externalRestart);
          expect(owner?.isCurrent()).toBe(true);
          expect(isGatewayWorkAdmissionClosed()).toBe(false);
          return { ok: true, value: true };
        });
        try {
          const sigterm = captureSignal("SIGTERM");
          if (trigger === "persisted-intent") {
            consumeGatewayRestartIntentPayload.mockResolvedValueOnce({
              reason: "gateway.restart",
              force: true,
              waitMs: 30_000,
            });
          }
          if (trigger === "commit") {
            if (!host?.externalRestart?.commitStop) {
              throw new Error("Missing committed stop capability");
            }
            host.externalRestart.commitStop();
            expect(isGatewayWorkAdmissionClosed()).toBe(true);
          } else {
            sigterm();
          }
          await cleanup.entered;
          expect(close).toHaveBeenCalledOnce();
          sigterm();
          expect(host?.externalRestart?.isCurrent()).toBe(false);
          expectRestartCloseCall(close, 0);
          expectUncalled(waitForGatewayActiveWork, runtime.exit, cancelShutdownHardExitWatchdog);
        } finally {
          if (fails) {
            cleanup.reject(new Error("external cleanup failed"));
          } else {
            cleanup.release();
          }
        }
        await expect(exited).resolves.toBe(fails ? 1 : 0);
        expect(consumeGatewaySuspendHandoff).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expectUncalled(
          restartGatewayProcessWithFreshPid,
          respawnGatewayProcessForUpdate,
          writeGatewayRestartHandoff,
        );
        expect(cancelShutdownHardExitWatchdog).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([
    { marker: "OPENCLAW_SUPERVISOR_MODE", value: "external", exitCode: undefined },
    { marker: "OPENCLAW_WINDOWS_TASK_NAME", value: "OpenClaw Gateway", exitCode: 75 },
  ])(
    "releases the lock before supervised restart exit $exitCode",
    async ({ marker, value, exitCode }) => {
      supervise(marker, value, exitCode);
      await withEnvAsync({ OPENCLAW_GATEWAY_RESTART_TRACE: "1" }, async () => {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const exitCallOrder: string[] = [];
          const lockRelease = vi.fn(async () => {
            exitCallOrder.push("lockRelease");
          });
          acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
          const handoffGate = holdHandoff();
          const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
          captureSignal("SIGUSR2")();
          await handoffGate.entered;
          try {
            expect(runtime.exit).not.toHaveBeenCalled();
          } finally {
            handoffGate.release();
          }
          await expect(exited).resolves.toBe(exitCode ?? 0);
          expect(runtime.exit).toHaveBeenCalledWith(exitCode ?? 0);
          expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
          const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
          expect(respawnOpts?.env).toMatchObject({
            OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS: expect.stringMatching(/^\d/u),
            OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS: expect.stringMatching(/^\d/u),
          });
          expect(writeGatewayRestartHandoff).toHaveBeenCalledOnce();
        });
      });
    },
  );

  it("falls back in-process when an external restart handoff cannot be persisted", async () => {
    writeGatewayRestartHandoff.mockResolvedValueOnce(null);
    supervise();
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, runtime, exited } = await createSignaledLoopHarness();
      const sigint = captureSignal("SIGINT");
      captureSignal("SIGUSR2")();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "external handoff failure did not restart in-process",
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "external supervisor restart handoff could not be persisted; falling back to in-process restart",
      );
      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("publishes the handoff after server close and before shared-state cleanup", async () => {
    const closeGate = createLifecycleGate();
    const handoffGate = holdHandoff();
    const sharedState = resolveGlobalMap<string, boolean>(
      Symbol("restart-handoff-shared-state"),
      "shared-state",
    );
    sharedState.set("live", true);
    supervise();
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited, loopPromise } = await createSignaledLoopHarness();
      close.mockImplementationOnce(closeGate.wait);
      captureSignal("SIGUSR2")();
      try {
        await awaitGateBeforeSettlement(
          closeGate.entered,
          loopPromise,
          "Gateway exited before server close",
        );
        expect(close).toHaveBeenCalledWith(expect.objectContaining({ retainSharedState: true }));
        expect(writeGatewayRestartHandoff).not.toHaveBeenCalled();
        closeGate.release();
        await awaitGateBeforeSettlement(
          handoffGate.entered,
          loopPromise,
          "Gateway exited before publishing its restart handoff",
        );
        expect(sharedState.get("live")).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        closeGate.release();
        handoffGate.release();
        await Promise.allSettled([loopPromise]);
      }
      await loopPromise;
      await expect(exited).resolves.toBe(0);
      expect(sharedState.size).toBe(0);
    });
  });

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, exited } = await createSignaledLoopHarness(undefined, true);
      consumeGatewaySuspendHandoff.mockReturnValueOnce({
        ok: false,
        error: "gateway terminal persistence is still pending",
      });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(20_000, expect.any(Object));
      expectStopCloseCall(close);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "external restart handoff refused: gateway terminal persistence is still pending",
      );
    });
  });
}
