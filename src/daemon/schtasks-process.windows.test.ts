import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findInstalledProcessPid, readWindowsProcessSnapshot } from "./schtasks-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "win32")(
  "matches a live process with Unicode paths and arguments through hidden PowerShell",
  async () => {
    const directory = tempDirs.make("openclaw-cim-réseau-网卡-🚀-%%-^!-");
    const script = path.join(directory, "gateway-é.mjs");
    await fs.writeFile(script, 'process.send("ready"); process.on("message", () => {});\n');
    const programArguments = [
      process.execPath,
      script,
      "gateway",
      "--port",
      "18789",
      "--fixture-name",
      "réseau 网卡 🚀 e\u0301",
    ];
    const child = spawn(process.execPath, programArguments.slice(1), {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    try {
      const [ready] = await once(child, "message");
      expect(ready).toBe("ready");
      const snapshot = readWindowsProcessSnapshot();
      expect(snapshot).not.toBeNull();
      if (!snapshot || child.pid === undefined) {
        throw new Error("Expected the live Unicode fixture and its native process snapshot");
      }
      expect(snapshot.find((entry) => entry.ProcessId === child.pid)?.CommandLine).toContain(
        script,
      );
      expect(findInstalledProcessPid(snapshot, 18789, programArguments, () => true)).toBe(
        child.pid,
      );
    } finally {
      await stopChildProcess(child, 5_000);
      await closed;
    }
  },
  30_000,
);
