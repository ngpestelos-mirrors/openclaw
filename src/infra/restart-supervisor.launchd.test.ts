import { afterEach, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { restartGatewayViaSupervisor } from "./restart-supervisor.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
vi.mock("./restart-stale-pids.js", () => ({ cleanStaleGatewayProcessesSync: vi.fn() }));
vi.mock("../daemon/paths.js", async (original) => ({
  ...(await original<typeof import("../daemon/paths.js")>()),
  resolveLaunchAgentHomeDir: () => "/Users/fixture-user",
}));
afterEach(() => {
  vi.restoreAllMocks();
});
it("bootstraps the canonical definition after an external-home job was booted out", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  spawn.mockReset().mockImplementation((_file: string, args: string[]) => ({
    status: args[0] === "kickstart" ? 113 : 0,
    stdout: "",
    stderr: "",
    error: undefined,
  }));
  withEnv(
    {
      HOME: "/Volumes/external-fixture",
      OPENCLAW_PROFILE: "default",
      OPENCLAW_LAUNCHD_LABEL: undefined,
    },
    () => {
      expect(restartGatewayViaSupervisor()).toMatchObject({ ok: true, method: "launchctl" });
    },
  );
  expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/ai.openclaw.gateway`]],
    [
      "launchctl",
      [
        "bootstrap",
        `gui/${process.getuid?.() ?? 501}`,
        "/Users/fixture-user/Library/LaunchAgents/ai.openclaw.gateway.plist",
      ],
    ],
  ]);
});
