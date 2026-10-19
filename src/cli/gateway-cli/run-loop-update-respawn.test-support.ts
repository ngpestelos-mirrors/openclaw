/** Registers update replacement and handoff cases in the run-loop signal fixture. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { getFreePort } from "../../test-utils/ports.js";
import { registerPackageLifecycleStopTests } from "./run-loop-package-lifecycle.test-support.js";
import { registerForegroundUpdateStopTests } from "./run-loop-stop.test-support.js";
import {
  createUpdateRespawnChild,
  expectUncalled,
  type UpdateRespawnFixtures,
} from "./run-loop.test-support.js";

export function registerUpdateRespawnTests(f: UpdateRespawnFixtures): void {
  registerForegroundUpdateStopTests(f);
  registerPackageLifecycleStopTests(f);

  function prepareForegroundHandoff() {
    f.consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: f.managedUpdateSuccessorOwner,
    });
    f.isForegroundUpdateHandoff.mockReturnValue(true);
  }

  function expectNoManagedSettlement() {
    expectUncalled(
      f.cancelManagedServiceUpdateHandoff,
      f.commitManagedServiceUpdateHandoff,
      f.markUpdateRestartSentinelFailure,
    );
  }

  function acquireObservedLock() {
    const release = vi.fn(async () => {});
    f.acquireGatewayLock.mockResolvedValueOnce({ release });
    return release;
  }

  it("joins cancellation before restoring unchanged runtime when foreground provider cleanup fails", async () => {
    const cancellation = createDeferred<"restored-in-process">();
    prepareForegroundHandoff();
    f.hasManagedProviderLocalServices.mockReturnValue(true);
    f.stopManagedProviderLocalServices.mockRejectedValueOnce(new Error("provider cleanup failed"));
    f.cancelManagedServiceUpdateHandoff.mockReturnValueOnce(cancellation.promise);
    const lockRelease = acquireObservedLock();
    await f.withRunningGateway(async ({ captureSignal, start, runtime, exited }) => {
      const stop = captureSignal("SIGINT");
      try {
        captureSignal("SIGUSR2")();
        await f.waitForLoopCondition(
          () => f.cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "failed provider cleanup did not cancel its updater",
        );
        expectUncalled(
          lockRelease,
          f.completeForegroundUpdateHandoffAfterClose,
          f.respawnGatewayProcessForUpdate,
          runtime.exit,
        );
        expect(start).toHaveBeenCalledOnce();
        cancellation.resolve("restored-in-process");
        await f.waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "cancelled update did not restore the unchanged Gateway",
        );
        expect(f.cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          f.managedUpdateSuccessorOwner,
        );
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(f.acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(f.completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        expect(f.markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-local-service-stop-failed",
        );
        stop();
        await expect(exited).resolves.toBe(0);
      } finally {
        cancellation.resolve("restored-in-process");
        await setImmediate();
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it.each(["failed-spawn", "disabled", "unhealthy"] as const)(
    "joins the foreground updater before a fresh successor and never resumes migrated runtime: %s",
    async (outcome) => {
      const updater = createDeferred<{ respawn: boolean }>();
      prepareForegroundHandoff();
      f.completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
      const lockRelease = acquireObservedLock();
      const child = createUpdateRespawnChild();
      const readinessRejected = outcome === "unhealthy";
      const health = f.respawnHealth({
        healthy: false,
        waitOutcome: "stopped-free",
        ...(outcome === "unhealthy" ? { runtime: { status: "stopped" as const } } : {}),
      });
      f.waitForGatewayHealthyRestart.mockResolvedValueOnce(health);
      f.killProcessTree.mockClear();
      f.respawnGatewayProcessForUpdate.mockReturnValueOnce(
        outcome === "failed-spawn"
          ? { mode: "failed", detail: "fixture failure" }
          : outcome === "disabled"
            ? { mode: "disabled" }
            : { mode: "spawned", pid: 7777, child },
      );
      f.hasManagedProviderLocalServices.mockReturnValue(true);
      await f.withRunningGateway(
        async ({ captureSignal, close, start, runtime, exited }) => {
          const stop = captureSignal("SIGINT");
          try {
            captureSignal("SIGUSR2")();
            await f.waitForLoopCondition(
              () => f.completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
              "foreground updater did not receive its closed witness",
            );
            expect(close).toHaveBeenCalledOnce();
            expect(lockRelease).toHaveBeenCalledOnce();
            expect(f.stopManagedProviderLocalServices).toHaveBeenCalledOnce();
            expectUncalled(f.respawnGatewayProcessForUpdate, runtime.exit);
            const consumedIntents = f.consumeGatewayRestartIntentPayload.mock.calls.length;
            captureSignal("SIGUSR2")();
            await setImmediate();
            expect(f.consumeGatewayRestartIntentPayload).toHaveBeenCalledTimes(consumedIntents);
            updater.resolve({ respawn: true });
            if (readinessRejected) {
              await f.waitForLoopCondition(
                () => child.kill.mock.calls.length === 1,
                "rejected foreground successor did not receive termination",
              );
              expect(runtime.exit).not.toHaveBeenCalled();
              child.exitCode = 1;
              child.emit("exit", 1, null);
              await setImmediate();
              expect(runtime.exit).not.toHaveBeenCalled();
              child.emit("close", 1, null);
            }
            await expect(withTimeout(exited, 4_000)).resolves.toBe(1);
            expect(start).toHaveBeenCalledOnce();
            expect(f.acquireGatewayLock).toHaveBeenCalledOnce();
            expect(f.stopManagedProviderLocalServices).toHaveBeenCalledOnce();
            expectNoManagedSettlement();
            expectUncalled(f.writeGatewayRestartHandoff);
            expect(f.respawnGatewayProcessForUpdate).toHaveBeenCalledOnce();
            if (readinessRejected) {
              expect(child.kill).toHaveBeenCalledOnce();
            }
          } finally {
            child.exitCode = 1;
            child.emit("exit", 1, null);
            child.emit("close", 1, null);
            updater.resolve({ respawn: false });
            await setImmediate();
            if (runtime.exit.mock.calls.length === 0) {
              stop();
            }
            await exited;
          }
        },
        false,
        { lockPort: 18789 },
      );
    },
  );

  it("preserves a real foreground successor after shared readiness reports still-starting", async ({
    signal,
  }) => {
    const actualKillTree = await vi.importActual<typeof import("../../process/kill-tree.js")>(
      "../../process/kill-tree.js",
    );
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      [
        "--input-type=commonjs",
        "-e",
        `const net = require("node:net");
process.once("message", () => {
  net.createServer(socket => socket.end()).listen(Number(process.argv[1]), "127.0.0.1", () => {
    process.send("listening");
  });
});
process.send("parked");`,
        String(port),
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const parked = once(child, "message");
    const closed = once(child, "close");
    void closed.catch(() => {});
    f.killProcessTree.mockImplementation(actualKillTree.killProcessTree);
    try {
      const [parkedMessage] = await withinTest(
        awaitGateBeforeSettlement(parked, closed, "foreground successor did not park"),
        signal,
      );
      expect(parkedMessage).toBe("parked");
      prepareForegroundHandoff();
      f.respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: child.pid,
        child,
      });
      const completeBoot = vi.fn();
      await f.withRunningGateway(
        async ({ captureSignal, close, start, exited }) => {
          f.waitForGatewayHealthyRestart.mockImplementationOnce(async (params) => {
            expect(params.child).toBe(child);
            expect(child.exitCode).toBeNull();
            return f.respawnHealth({
              healthy: false,
              waitOutcome: "still-starting",
              runtime: { status: "running", pid: child.pid },
            });
          });
          captureSignal("SIGUSR2")();
          const exitCode = await withTimeout(exited, 20_000);

          expect(exitCode).toBe(0);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
            outcome: "planned_restart",
            reason: "restart (SIGUSR2: update.run)",
          });
          expect(start).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledOnce();
          expect(f.acquireGatewayLock).toHaveBeenCalledOnce();
          expectNoManagedSettlement();
          expectUncalled(f.writeGatewayRestartHandoff);

          const listening = once(child, "message");
          child.send("listen");
          const [listeningMessage] = await withinTest(
            awaitGateBeforeSettlement(listening, closed, "foreground successor did not listen"),
            signal,
          );
          expect(listeningMessage).toBe("listening");
          expect(child.exitCode).toBeNull();
          expect(child.signalCode).toBeNull();
        },
        false,
        { lockPort: port, completeBoot },
      );
    } finally {
      try {
        await stopChildProcess(child, 5_000);
      } finally {
        f.killProcessTree.mockReset();
      }
    }
  });

  it("fails the foreground handoff when its successor exits while exit logs are flushing", async () => {
    const flushEntered = createDeferred();
    const releaseFlush = createDeferred();
    const child = createUpdateRespawnChild();
    prepareForegroundHandoff();
    f.respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: child.pid,
      child,
    });
    f.flushLogger.mockImplementationOnce(async () => {
      flushEntered.resolve();
      await releaseFlush.promise;
    });
    await f.withRunningGateway(
      async ({ captureSignal, start, runtime, exited }) => {
        try {
          captureSignal("SIGUSR2")();
          await withTimeout(flushEntered.promise, 5_000);
          expect(runtime.exit).not.toHaveBeenCalled();
          child.exitCode = 1;
          child.emit("exit", 1, null);
          releaseFlush.resolve();
          await setImmediate();
          expect(runtime.exit).not.toHaveBeenCalled();
          child.emit("close", 1, null);
          await expect(withTimeout(exited, 5_000)).resolves.toBe(1);
          expect(start).toHaveBeenCalledOnce();
          expect(f.acquireGatewayLock).toHaveBeenCalledOnce();
          expectUncalled(child.kill, f.killProcessTree);
          expectNoManagedSettlement();
        } finally {
          releaseFlush.resolve();
          child.emit("close", 1, null);
          await withTimeout(exited, 5_000);
          f.flushLogger.mockReset().mockResolvedValue(undefined);
        }
      },
      false,
      { lockPort: 18789 },
    );
  });

  it.each([
    { name: "a launchd update handoff fails to spawn", launchd: true },
    { name: "an external update restart handoff cannot be persisted", launchd: false },
  ])("falls back in-process when $name", async ({ launchd }) => {
    vi.clearAllMocks();
    f.peekGatewayRestartReason.mockReturnValue("update.run");
    f.restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      ...(launchd ? { handoffSpawned: Promise.resolve(false) } : {}),
    });
    if (!launchd) {
      f.writeGatewayRestartHandoff.mockResolvedValueOnce(null);
    }
    try {
      if (launchd) {
        f.setPlatform("darwin");
        process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      } else {
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
      }
      await f.withRunningGateway(async ({ captureSignal, start, runtime, exited }) => {
        if (launchd) {
          vi.useFakeTimers();
        }
        captureSignal("SIGUSR2")();
        if (launchd) {
          await vi.advanceTimersByTimeAsync(1500);
        } else {
          await f.waitForLoopCondition(
            () => start.mock.calls.length === 2,
            "external update handoff failure did not restart in-process",
          );
        }
        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(f.markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );
        captureSignal("SIGINT")();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      if (f.originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", f.originalPlatformDescriptor);
      }
    }
  });
}
