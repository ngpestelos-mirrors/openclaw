/** Native cleanup routing without touching the host launchd domain or filesystem. */
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupLegacyLaunchdService } from "./doctor-launchd-cleanup.js";

// This macOS-only owner always receives POSIX paths, including on Windows test hosts.
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.posix };
});

const execLaunchctl = vi.hoisted(() => vi.fn());
vi.mock("../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/launchd-exec.js")>()),
  execLaunchctl,
}));

describe("legacy LaunchAgent Trash routing", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["/Volumes/Data/Library/LaunchAgents/legacy.plist", "/Volumes/Data/.Trash"],
    ["/Library/LaunchAgents/legacy.plist", "/Users/account/.Trash"],
  ])("retires %s on its owning filesystem", async (plistPath, trashDir) => {
    execLaunchctl.mockReset().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "Could not find service",
      termination: "exit",
    });
    vi.spyOn(os, "homedir").mockReturnValue("/Users/account");
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    vi.spyOn(fs, "access").mockResolvedValue(undefined);

    const result = await cleanupLegacyLaunchdService({ label: "legacy", plistPath });

    expect(result).toEqual({ status: "removed", destination: `${trashDir}/legacy-1234.plist` });
    expect(mkdir).toHaveBeenCalledWith(trashDir, { recursive: true });
    expect(rename).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith(plistPath, `${trashDir}/legacy-1234.plist`);
    expect(execLaunchctl.mock.calls.map(([args]) => args[0])).toEqual([
      "bootout",
      "unload",
      "print",
    ]);
  });
});
