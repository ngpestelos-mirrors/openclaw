import { spawnSync } from "node:child_process";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import { callGatewayStatusProbe } from "./status.gather.probes.test-support.js";

export function registerStatusTimeoutTests(params: {
  gatherStatus: (
    overrides?: Partial<Parameters<typeof gatherDaemonStatus>[0]>,
  ) => ReturnType<typeof gatherDaemonStatus>;
  serviceIsLoaded: Mock<
    (opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<boolean>
  >;
  serviceReadRuntime: Mock<
    (env?: NodeJS.ProcessEnv, opts?: { timeoutMs?: number }) => Promise<GatewayServiceRuntime>
  >;
  serviceReadCommand: { mock: { calls: unknown[][] } };
  auditGatewayServiceConfig: Mock<(opts?: unknown) => Promise<ServiceConfigAudit>>;
  makeTempDir: () => string;
}): void {
  const { gatherStatus, serviceReadRuntime } = params;

  it.each([undefined, "10000"])(
    "keeps the Windows native budget independent of RPC for timeout %s",
    async (timeout) =>
      withMockedPlatform("win32", async () => {
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        onTestFinished(() => clock.mockRestore());
        const stateDir = params.makeTempDir();
        const nativeSpawn = vi
          .mocked(spawnSync)
          .mockClear()
          .mockImplementation((_file, _args, options) => {
            const expired = typeof options?.timeout === "number" && options.timeout < 12_000;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: expired
                ? ""
                : JSON.stringify({
                    taskPath: "\\OpenClaw Gateway",
                    state: 4,
                    lastRunResult: 0,
                    actions: [
                      {
                        type: 0,
                        path: "C:\\Fixture\\openclaw.exe",
                        arguments: "gateway",
                        workingDirectory: "",
                      },
                    ],
                  }),
              stderr: "",
              status: expired ? null : 0,
              signal: null,
              ...(expired
                ? { error: Object.assign(new Error("cold probe timed out"), { code: "ETIMEDOUT" }) }
                : {}),
            };
          });
        serviceReadRuntime.mockImplementationOnce((env, options) =>
          readScheduledTaskRuntime({ ...env, OPENCLAW_STATE_DIR: stateDir }, options),
        );
        try {
          const status = await gatherStatus({ rpc: { timeout } });
          expect(status.rpc?.ok).toBe(true);
          const rpcBudget = expect.objectContaining({ timeoutMs: 10_000 });
          expect(callGatewayStatusProbe).toHaveBeenCalledWith(rpcBudget);
          expect(params.auditGatewayServiceConfig).toHaveBeenCalledWith(rpcBudget);
          if (timeout === "10000") {
            expect(status.service.runtime).toMatchObject({
              status: "unknown",
              inspectionFailure: {
                code: "service-runtime-inspection-failed",
                timeoutMs: 10_000,
                detail: "Scheduled Task check timed out after 10000 ms (ETIMEDOUT).",
              },
            });
          } else {
            expect(status.service.runtime).toMatchObject({ status: "unknown", state: "Running" });
            expect(status.service.runtime?.inspectionFailure).toBeUndefined();
          }
          expect(nativeSpawn).toHaveBeenCalled();
          for (const call of nativeSpawn.mock.calls) {
            expect(call[2]?.timeout).toBe(timeout === undefined ? 60_000 : Number(timeout));
          }
        } finally {
          nativeSpawn.mockRestore();
        }
      }),
  );

  it("rejects invalid status timeout before reading service state", async () => {
    await expect(gatherStatus({ rpc: { timeout: "bogus" } })).rejects.toThrow(
      'Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "bogus".',
    );
    expect(params.serviceReadCommand).not.toHaveBeenCalled();
    expect(params.serviceIsLoaded).not.toHaveBeenCalled();
    expect(serviceReadRuntime).not.toHaveBeenCalled();
  });
}
