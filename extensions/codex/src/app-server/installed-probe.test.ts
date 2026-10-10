import type { PathLike } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { probeCodexAppServerHandshake } from "./installed-probe.js";

const fixture = vi.hoisted(() => ({ managedConfig: false }));
const originalPlatform = process.platform;
// mock-isolation: never read or depend on the host's managed Codex configuration.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    access(file: PathLike, mode?: number) {
      if (file === "/etc/codex/managed_config.toml") {
        return fixture.managedConfig
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error("absent fixture"), { code: "ENOENT" }));
      }
      return actual.access(file, mode);
    },
  };
});

beforeEach(() => {
  fixture.managedConfig = false;
  if (originalPlatform === "darwin") {
    Object.defineProperty(process, "platform", { value: "linux" });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.unstubAllEnvs();
});

it.each(["environment", "system configuration"] as const)(
  "isolates Codex SQLite state from %s during the selection handshake",
  async (source) => {
    await withTempDir("openclaw-installed-probe-", async (root) => {
      const existingHome = path.join(root, "existing-codex-state");
      const observedPath = path.join(root, "observed.json");
      const command = path.join(root, "codex-fixture.cjs");
      await mkdir(existingHome);
      await writeFile(
        command,
        `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const home = process.env.CODEX_HOME;
const configured = ${source === "system configuration" ? JSON.stringify(existingHome) : "undefined"};
const overrideIndex = process.argv.indexOf("-c");
const override = overrideIndex < 0 ? undefined : process.argv[overrideIndex + 1];
const sqlite = override?.startsWith("sqlite_home=")
  ? JSON.parse(override.slice("sqlite_home=".length))
  : (configured ?? process.env.CODEX_SQLITE_HOME);
fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({home, sqlite}));
fs.writeFileSync(path.join(sqlite, "opened-database"), "selection probe");
readline.createInterface({input: process.stdin}).once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id: request.id, result: {userAgent: "codex-cli/0.162.1"}}) + "\\n");
});
`,
      );
      vi.stubEnv("CODEX_HOME", existingHome);
      vi.stubEnv("CODEX_SQLITE_HOME", existingHome);

      await expect(probeCodexAppServerHandshake(command)).resolves.toBe("0.162.1");

      const observed = JSON.parse(await readFile(observedPath, "utf8")) as {
        home: string;
        sqlite: string;
      };
      expect(observed.home).not.toBe(existingHome);
      expect(observed.sqlite).toBe(observed.home);
      expect(await readdir(existingHome)).toEqual([]);
      await expect(access(observed.home)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it.skipIf(originalPlatform === "win32")(
  "does not launch a selection probe when legacy managed settings can override its storage",
  async () => {
    fixture.managedConfig = true;
    await expect(probeCodexAppServerHandshake(process.execPath)).rejects.toThrow(
      "managed Codex configuration prevents an isolated selection probe",
    );
  },
);
