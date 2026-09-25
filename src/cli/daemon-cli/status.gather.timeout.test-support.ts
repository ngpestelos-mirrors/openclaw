import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import type { ServiceConfigAudit } from "../../daemon/service-audit.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { gatherDaemonStatus } from "./status.gather.js";
import {
  callGatewayStatusProbe,
  capturePrintedDaemonStatus,
} from "./status.gather.probes.test-support.js";
import { printDaemonStatus } from "./status.print.js";

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
  const {
    gatherStatus,
    serviceIsLoaded,
    serviceReadRuntime,
    serviceReadCommand,
    auditGatewayServiceConfig,
  } = params;

  it.each([undefined, "10000", "20000"])(
    "keeps the Windows native budget independent of RPC for timeout %s",
    async (timeout) =>
      withMockedPlatform("win32", async () => {
        const stateDir = params.makeTempDir();
        const nativeSpawn = vi
          .mocked(spawnSync)
          .mockClear()
          .mockImplementation((_file, _args, options) => {
            const expired = typeof options?.timeout === "number" && options.timeout < 12_000;
            return {
              pid: 0,
              output: [null, "", ""],
              stdout: expired ? "" : JSON.stringify({ state: 4, lastRunResult: 0 }),
              stderr: "",
              status: expired ? null : 0,
              signal: null,
              ...(expired
                ? { error: Object.assign(new Error("cold probe timed out"), { code: "ETIMEDOUT" }) }
                : {}),
            };
          });
        serviceReadRuntime.mockImplementationOnce((env, options) =>
          readScheduledTaskRuntime(
            {
              ...env,
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_TASK_SCRIPT: path.join(stateDir, "missing.cmd"),
            },
            options,
          ),
        );
        try {
          const status = await gatherStatus({ rpc: { timeout } });
          expect(status.rpc?.ok).toBe(true);
          expect(callGatewayStatusProbe).toHaveBeenCalledWith(
            expect.objectContaining({
              timeoutMs: timeout === undefined ? 10_000 : Number(timeout),
            }),
          );
          expect(auditGatewayServiceConfig).toHaveBeenCalledWith(
            expect.objectContaining({
              timeoutMs: timeout === undefined ? 10_000 : Number(timeout),
            }),
          );
          if (timeout === "10000") {
            expect(status.service.runtime).toMatchObject({
              status: "unknown",
              inspectionFailure: {
                code: "service-runtime-inspection-failed",
                timeoutMs: 10_000,
                detail: "Scheduled Task probe timed out after 10000 ms (ETIMEDOUT).",
              },
            });
          } else {
            expect(status.service.runtime).toMatchObject({ status: "running", state: "Running" });
            expect(status.service.runtime?.inspectionFailure).toBeUndefined();
          }
          expect(nativeSpawn).toHaveBeenCalledExactlyOnceWith(
            expect.any(String),
            expect.any(Array),
            expect.objectContaining({ timeout: timeout === undefined ? 60_000 : Number(timeout) }),
          );
        } finally {
          nativeSpawn.mockRestore();
        }
      }),
  );

  it.each(["darwin", "linux"] as const)(
    "keeps the omitted native timeout at ten seconds on %s",
    async (platform) =>
      withMockedPlatform(platform, async () => {
        await gatherStatus();
        expect(serviceReadRuntime).toHaveBeenCalledWith(expect.any(Object), { timeoutMs: 10_000 });
        expect(callGatewayStatusProbe).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs: 10_000 }),
        );
      }),
  );

  it.each(["darwin", "linux"] as const)(
    "renders Gateway-specific timeout recovery on %s",
    async (platform) =>
      withMockedPlatform(platform, async () => {
        serviceIsLoaded.mockImplementationOnce(async (args?: { timeoutMs?: number }) => {
          if (args?.timeoutMs === undefined) {
            return await new Promise<boolean>(() => {});
          }
          throw new Error("systemctl is-enabled timed out");
        });
        serviceReadRuntime.mockImplementationOnce(async (_env, opts) => {
          if (opts?.timeoutMs === undefined) {
            return await new Promise<{ status: string }>(() => {});
          }
          throw new Error("錯誤: 系統找不到指定的檔案。");
        });

        const status = await gatherStatus({
          rpc: { timeout: "100", json: true },
          probe: false,
          deep: true,
        });

        expect(serviceIsLoaded).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 100 }));
        expect(serviceReadRuntime).toHaveBeenCalledWith(expect.any(Object), { timeoutMs: 100 });
        expect(auditGatewayServiceConfig).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs: 100 }),
        );
        expect(status.service.loadState).toEqual({
          status: "unknown",
          detail: "Error: systemctl is-enabled timed out",
        });
        expect(status.service.loaded).toBeNull();
        expect(status.service.runtime).toEqual({
          status: "unknown",
          detail: "service runtime inspection failed; retry with openclaw gateway status --deep",
          inspectionFailure: {
            code: "service-runtime-inspection-failed",
            detail: "錯誤: 系統找不到指定的檔案。",
          },
        });

        const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        try {
          printDaemonStatus(status, { json: true, deep: true });
          expect(writeJson).toHaveBeenCalledOnce();
          const serialized = JSON.stringify(writeJson.mock.calls[0]?.[0]);
          if (!serialized) {
            throw new Error("expected terminal JSON output");
          }
          expect(JSON.parse(serialized)).toMatchObject({
            service: {
              loaded: null,
              loadState: {
                status: "unknown",
                detail: "Error: systemctl is-enabled timed out",
              },
              runtime: {
                status: "unknown",
                detail:
                  "service runtime inspection failed; retry with openclaw gateway status --deep",
                inspectionFailure: {
                  code: "service-runtime-inspection-failed",
                  detail: "錯誤: 系統找不到指定的檔案。",
                },
              },
            },
          });
        } finally {
          writeJson.mockRestore();
        }

        const output = capturePrintedDaemonStatus(status, { json: false, deep: true }).logs;
        expect(output).toContain("Service: LaunchAgent (unknown)");
        expect(output).not.toContain("Service: LaunchAgent (not loaded)");
        expect(output).toContain(
          "Runtime: unknown (service runtime inspection failed; retry with openclaw gateway status --deep)",
        );
        expect(output).not.toContain("系統找不到指定的檔案");
      }),
    1_000,
  );

  it.each(["bogus", "0", "-1", "1.5"])(
    "rejects invalid status timeout %s before reading service state",
    async (timeout) => {
      await expect(gatherStatus({ rpc: { timeout } })).rejects.toThrow(
        `Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000. Received: "${timeout}".`,
      );

      expect(serviceReadCommand).not.toHaveBeenCalled();
      expect(serviceIsLoaded).not.toHaveBeenCalled();
      expect(serviceReadRuntime).not.toHaveBeenCalled();
    },
  );
}
