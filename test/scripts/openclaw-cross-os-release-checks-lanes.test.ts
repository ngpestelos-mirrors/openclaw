import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneState } from "../../scripts/lib/cross-os-release-checks/config.ts";

const mocks = vi.hoisted(() => ({
  runInstalledCli: vi.fn(),
  runOpenClaw: vi.fn(),
}));

vi.mock("../../scripts/lib/cross-os-release-checks/installed.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/installed.ts")
  >()),
  runInstalledCli: mocks.runInstalledCli,
}));

vi.mock("../../scripts/lib/cross-os-release-checks/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/cross-os-release-checks/runtime.ts")
  >()),
  runOpenClaw: mocks.runOpenClaw,
}));

import { installLaneCompanions } from "../../scripts/lib/cross-os-release-checks/lane-companions.ts";

const lane: LaneState = {
  name: "fresh",
  rootDir: "/tmp/openclaw-release",
  prefixDir: "/tmp/openclaw-release/prefix",
  homeDir: "/tmp/openclaw-release/home",
  stateDir: "/tmp/openclaw-release/state",
  appDataDir: "/tmp/openclaw-release/app-data",
  gatewayPort: 18789,
  phaseTimings: [],
};
const companions = [
  { name: "@openclaw/codex", tarballPath: "/tmp/openclaw-codex.tgz" },
  { name: "@openclaw/discord", tarballPath: "/tmp/openclaw-discord.tgz" },
];
const env = { HOME: lane.homeDir };
function install(cliPath?: string) {
  return installLaneCompanions({
    companions,
    logsDir: "/tmp/openclaw-release/logs",
    lane: { ...lane, phaseTimings: [] },
    env,
    ...(cliPath ? { cliPath } : {}),
  });
}

describe("cross-OS release companion installation", () => {
  afterEach(() => {
    mocks.runInstalledCli.mockReset();
    mocks.runOpenClaw.mockReset();
  });

  it.each([
    { cliPath: undefined, runner: "packaged", supported: true },
    { cliPath: "/tmp/openclaw", runner: "installed", supported: false },
  ] as const)(
    "probes capability consent once through the $runner runner (supported=$supported)",
    async ({ cliPath, supported }) => {
      const runner = cliPath ? mocks.runInstalledCli : mocks.runOpenClaw;
      const unusedRunner = cliPath ? mocks.runOpenClaw : mocks.runInstalledCli;
      runner
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: supported ? "  --accept-capabilities  Accept declared capabilities\n" : "Usage\n",
          stderr: "",
        })
        .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await install(cliPath);
      expect(runner.mock.calls).toEqual([
        [expect.objectContaining({ args: ["plugins", "install", "--help"], env })],
        ...companions.map(({ tarballPath }) => [
          expect.objectContaining({
            args: [
              "plugins",
              "install",
              `npm-pack:${tarballPath}`,
              "--force",
              ...(supported ? ["--accept-capabilities"] : []),
            ],
            env,
          }),
        ]),
      ]);
      expect(unusedRunner).not.toHaveBeenCalled();
    },
  );

  it("fails the lane when the help probe fails", async () => {
    mocks.runOpenClaw.mockRejectedValueOnce(new Error("help probe failed"));

    await expect(install()).rejects.toThrow("help probe failed");
    expect(mocks.runOpenClaw).toHaveBeenCalledTimes(1);
  });
});
