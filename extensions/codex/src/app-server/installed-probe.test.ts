import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { probeCodexAppServerHandshake } from "./installed-probe.js";

afterEach(() => vi.unstubAllEnvs());

it("isolates inherited Codex SQLite state during the selection handshake", async () => {
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
const sqlite = process.env.CODEX_SQLITE_HOME;
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
});
