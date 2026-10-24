import { expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../config/io.runtime.js";
import {
  commitDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "../../daemon/runtime-pin-state.js";
import * as runtimePins from "../../daemon/runtime-pin-state.js";
import type { UpdateCommandOptions } from "./shared.js";
import * as convergence from "./update-command-convergence.js";
import { finishParams } from "./update-command-maintenance-fixtures.test-support.js";
import type { OriginalServiceFixture } from "./update-command-original-service-fixture.test-support.js";
import { observeOriginalManagedServiceRuntime } from "./update-command-original-service.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as serviceCommand from "./update-command-service-command.js";
import * as service from "./update-command-service.js";
import { maybeRestartService } from "./update-command-service.js";

export function registerRuntimePinPreservationTest(
  fixture: () => OriginalServiceFixture,
  admitted: (
    operation: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>,
  ) => Promise<void>,
) {
  it.each(["success", "cleanup failure"] as const)(
    "preserves the observed runtime while pin migration is pending: %s",
    async (outcome) => {
      const { state, rootA, rootB, before, serviceNodeRunner, serviceState, mocks } = fixture();
      const reader = vi.spyOn(serviceCommand, "prepareUpdatedInstallGatewayReadiness");
      const scope = { kind: "gateway" as const, env: state.env };
      const pin = { runtime: "node" as const, path: serviceNodeRunner };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePinForInstall(scope, serviceState.command, true), pin },
        serviceState.command,
      );
      const pending = vi
        .spyOn(runtimePins, "readDaemonRuntimePinMigrationPending")
        .mockReturnValue(true);
      const read = vi.spyOn(runtimePins, "readDaemonRuntimePin").mockImplementation(() => {
        throw new Error("pending pins must not be read");
      });
      await admitted(async (run) => {
        const original = await observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run } },
          before,
        );
        if (!original) {
          throw new Error("missing original observation");
        }
        mocks.restart.mockResolvedValue("accepted");
        const result = {
          status: "ok" as const,
          mode: "npm" as const,
          root: rootB,
          before: { version: "2026.9.4" },
          after: { version: "2026.9.5" },
          steps: [],
          durationMs: 1,
        };
        if (outcome === "success") {
          expect(
            await maybeRestartService({
              originalManagedServiceRuntime: original,
              shouldRestart: true,
              result,
              opts: { json: true, run },
              refreshServiceEnv: true,
              serviceInstallEnv: state.env,
              serviceEnv: state.env,
              serviceUpdateVerdict: before.serviceUpdateVerdict,
              gatewayPort: 18789,
              timeoutMs: 30_000,
            }),
          ).toBe("ok");
        } else {
          vi.spyOn(convergence, "convergeUpdatePlugins").mockImplementation(async ({ result }) => ({
            resultWithPostUpdate: result,
          }));
          vi.spyOn(service, "tryInstallShellCompletion").mockResolvedValue(undefined);
          let observationsBeforeCleanup = 0;
          const complete = vi.fn(
            async (_outcome: { activationVerified: boolean }, assertCurrent: () => void) => {
              assertCurrent();
              expect(mocks.restart).toHaveBeenCalledOnce();
              observationsBeforeCleanup = mocks.health.mock.calls.length;
              throw new Error("retained backup cleanup refused");
            },
          );
          const rollback = vi.fn(async () => {
            throw new Error("healthy retained A must not roll back");
          });
          const failure = await finishUpdate(
            finishParams({
              result,
              root: rootB,
              configSnapshot: await readConfigFileSnapshot({ observe: false }),
              originalManagedServiceRuntime: original,
              preManagedServiceStop: before,
              ownedManagedUpdateEnv: state.env,
              opts: { json: true, run },
              packageTransaction: { backupRoot: state.path("retained-backup"), complete, rollback },
            }),
          ).catch((error: unknown) => error);
          expect(failure).toMatchObject({
            result: {
              status: "error",
              reason: "package-backup-retention-failed",
              verification: { readyz: true, runningVersion: original.version },
            },
          });
          expect(complete).toHaveBeenCalledOnce();
          expect(mocks.health.mock.calls.length).toBeGreaterThan(observationsBeforeCleanup);
          expect(rollback).not.toHaveBeenCalled();
          expect(mocks.health.mock.calls.at(-1)?.[0]).toMatchObject({
            expectedVersion: original.version,
            expectedBuildId: original.buildId,
          });
          expect(mocks.restart).toHaveBeenCalledOnce();
        }
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({
            nodeRunner: serviceNodeRunner,
            refreshServiceEnv: false,
            serviceUpdateVerdict: expect.objectContaining({
              root: rootA,
              refreshDefinition: false,
              requiresInstallRootRefresh: false,
            }),
            expectedGatewayIdentity: { version: original.version, buildId: original.buildId },
          }),
          "restart",
        );
        expect(mocks.nativeInstall).not.toHaveBeenCalled();
        pending.mockRestore();
        read.mockRestore();
        const next = await observeOriginalManagedServiceRuntime(
          { root: rootB, opts: { run } },
          before,
        );
        expect(next?.definition.runtimePin?.pin).toEqual(pin);
        expect(reader).not.toHaveBeenCalled();
      });
    },
  );
}
