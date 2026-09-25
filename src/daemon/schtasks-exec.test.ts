// Windows schtasks exec tests cover scheduled task command execution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execSchtasks } from "./schtasks-exec.js";
import { isScheduledTaskInstalled } from "./schtasks-runtime.js";

const runCommandWithTimeout = vi.hoisted(() => vi.fn());

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
      });
    },
  );
});
