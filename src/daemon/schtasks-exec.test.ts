// Windows schtasks exec tests cover scheduled task command execution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveStartupEntryPath } from "./schtasks-layout.js";
import { isRegisteredScheduledTask, isScheduledTaskInstalled } from "./schtasks-runtime.js";
import { readGatewayServiceLoadState } from "./service-load-state.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeout(...args),
}));

beforeEach(() => {
  runCommandWithTimeout.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("execSchtasks", () => {
  it("runs schtasks with bounded timeouts", async () => {
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    runCommandWithTimeout.mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(execSchtasks(["/Query"])).resolves.toEqual({
      stdout: "ok",
      stderr: "",
      code: 0,
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(["schtasks", "/Query"], {
      baseEnv: expect.any(Object),
      timeoutMs: 15_000,
      noOutputTimeoutMs: 30_000,
    });
    expect(runCommandWithTimeout.mock.calls[0]?.[1].baseEnv).not.toHaveProperty(
      "BOUNDARY_PARENT_ONLY",
    );
  });

  it.each([undefined, 200, 10_000])(
    "passes the installed-task query deadline %s to the process runner",
    async (timeoutMs) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout: "registered",
        stderr: "",
        code: 0,
        termination: "exit",
      });

      await expect(
        isScheduledTaskInstalled({
          env: { OPENCLAW_WINDOWS_TASK_NAME: "Deadline Fixture" },
          timeoutMs,
        }),
      ).resolves.toBe(true);
      expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
        ["schtasks", "/Query", "/TN", "Deadline Fixture"],
        expect.objectContaining({ timeoutMs: timeoutMs ?? 15_000, noOutputTimeoutMs: 30_000 }),
      );
    },
  );

  it.each([
    { termination: "timeout", detail: "schtasks timed out after 200ms" },
    { termination: "no-output-timeout", detail: "schtasks produced no output for 30000ms" },
    { termination: "signal", detail: "schtasks command terminated before confirmed completion" },
  ] as const)(
    "reports interrupted registration as unknown ($termination)",
    async ({ termination, detail }) => {
      const env = {
        APPDATA: tempDirs.make("schtasks-load-uncertain-"),
        OPENCLAW_WINDOWS_TASK_NAME: "Load State Fixture",
      };
      const startupPath = resolveStartupEntryPath(env);
      await fs.mkdir(path.dirname(startupPath), { recursive: true });
      await fs.writeFile(startupPath, "@rem synthetic Startup entry; never executed\r\n");
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "untrusted command diagnostic",
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination,
      });

      await expect(
        readGatewayServiceLoadState(
          { isLoaded: isScheduledTaskInstalled },
          { env, timeoutMs: 200 },
        ),
      ).resolves.toEqual({ status: "unknown", detail: `Error: ${detail}` });
      expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
        ["schtasks", "/Query", "/TN", "Load State Fixture"],
        expect.objectContaining({ timeoutMs: 200 }),
      );
    },
  );

  it.each([
    { code: 0, startup: false, expected: "loaded" },
    { code: 1, startup: false, expected: "not-loaded" },
    { code: 1, startup: true, expected: "loaded" },
    { code: 124, startup: false, expected: "not-loaded" },
  ])(
    "preserves completed query $code and Startup=$startup",
    async ({ code, startup, expected }) => {
      const env = { APPDATA: tempDirs.make("schtasks-load-completed-") };
      if (startup) {
        const startupPath = resolveStartupEntryPath(env);
        await fs.mkdir(path.dirname(startupPath), { recursive: true });
        await fs.writeFile(startupPath, "@rem synthetic Startup entry; never executed\r\n");
      }
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "schtasks timed out after 200ms",
        code,
        signal: null,
        killed: false,
        termination: "exit",
      });

      await expect(
        readGatewayServiceLoadState(
          { isLoaded: isScheduledTaskInstalled },
          { env, timeoutMs: 200 },
        ),
      ).resolves.toEqual({ status: expected });
    },
  );

  it("keeps registration failures uncertain without changing the lifecycle adapter", async () => {
    runCommandWithTimeout.mockRejectedValue(new Error("synthetic spawn failure"));
    const env = { APPDATA: tempDirs.make("schtasks-load-failed-") };
    await expect(
      readGatewayServiceLoadState({ isLoaded: isScheduledTaskInstalled }, { env, timeoutMs: 200 }),
    ).resolves.toEqual({ status: "unknown", detail: "Error: synthetic spawn failure" });

    await expect(isRegisteredScheduledTask(env)).resolves.toBe(false);
    expect(runCommandWithTimeout).toHaveBeenLastCalledWith(
      ["schtasks", "/Query", "/TN", "OpenClaw Gateway"],
      expect.objectContaining({ timeoutMs: 15_000, noOutputTimeoutMs: 30_000 }),
    );
  });

  it.each([undefined, 200])(
    "maps deadline %s into a non-zero schtasks result",
    async (timeoutMs) => {
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "timeout",
      });

      await expect(execSchtasks(["/Create"], timeoutMs)).resolves.toEqual({
        stdout: "",
        stderr: `schtasks timed out after ${timeoutMs ?? 15_000}ms`,
        code: 124,
        interruption: {
          termination: "timeout",
          detail: `schtasks timed out after ${timeoutMs ?? 15_000}ms`,
        },
      });
      await expect(isRegisteredScheduledTask({})).resolves.toBe(false);
    },
  );
});
