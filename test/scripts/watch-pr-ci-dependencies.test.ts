import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { watchPrCiDependencyOptions } from "../../scripts/lib/watch-pr-ci-dependencies.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writePackage(root: string, name: string, value: string) {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./index.mjs" }),
  );
  writeFileSync(join(directory, "index.mjs"), `export default ${JSON.stringify(value)};\n`);
}

it.each(["env", "config", "canonical", "installed", "configured", "missing"])(
  "selects the %s dependency context without changing the checkout",
  (source) => {
    const root = tempDirs.make("openclaw-watch-root-");
    const canonical = join(root, "canonical");
    const checkout = join(root, "checkout");
    const tooling = join(root, "tooling #root");
    mkdirSync(join(canonical, "node_modules"), { recursive: true });
    mkdirSync(join(tooling, "node_modules"), { recursive: true });
    mkdirSync(checkout);
    symlinkSync(
      canonical,
      join(canonical, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const git = vi.mocked(spawnSync).mockImplementation((_command, args) => {
      const common = args?.includes("rev-parse");
      expect(args?.slice(0, 2)).toEqual(["-C", common ? checkout : canonical]);
      return {
        status: !common && source === "canonical" ? 1 : 0,
        stdout: common
          ? join(canonical, ".git")
          : source === "canonical"
            ? ""
            : "../tooling #root\n",
        stderr: "",
        pid: 0,
        output: [],
        signal: null,
      };
    });
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv(
      "OPENCLAW_PR_TOOLING_ROOT",
      source === "env" ? "alias" : source === "missing" || source === "installed" ? root : "",
    );
    try {
      if (source === "installed" || source === "configured") {
        if (source === "installed") {
          mkdirSync(join(checkout, "node_modules"));
        } else {
          vi.stubEnv("PNPM_CONFIG_MODULES_DIR", join(tooling, "node_modules"));
        }
        expect(watchPrCiDependencyOptions(checkout)).toEqual({});
        expect(notice).not.toHaveBeenCalled();
      } else if (source === "missing") {
        expect(() => watchPrCiDependencyOptions(checkout)).toThrow(
          `Cannot resolve tooling dependencies at ${root}. Install dependencies in this checkout or set OPENCLAW_PR_TOOLING_ROOT to an installed checkout of this repository.`,
        );
        expect(notice).not.toHaveBeenCalled();
      } else {
        watchPrCiDependencyOptions(checkout);
        expect(notice.mock.calls).toEqual([
          [
            `[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${source === "config" ? tooling : canonical}`,
          ],
        ]);
      }
      expect(existsSync(join(checkout, "node_modules"))).toBe(source === "installed");
    } finally {
      git.mockRestore();
    }
  },
);

it("resolves missing bare packages through the watcher child while keeping local resolution and errors", () => {
  const root = tempDirs.make("openclaw-watch-dependencies-");
  const checkout = join(root, "checkout");
  const tooling = join(root, "tooling #root");
  const lib = join(checkout, "scripts", "lib");
  mkdirSync(lib, { recursive: true });
  const initialized = spawnSync("git", ["init", "--quiet", checkout], { encoding: "utf8" });
  expect(initialized.status, initialized.stderr).toBe(0);
  for (const file of [
    "tsx-cli-shim.mjs",
    "local-check-runtime.mts",
    "watch-pr-ci-dependencies.mjs",
  ]) {
    copyFileSync(resolve("scripts/lib", file), join(lib, file));
  }
  copyFileSync(resolve("scripts/watch-pr-ci.mjs"), join(checkout, "scripts/watch-pr-ci.mjs"));
  writePackage(tooling, "fixture-pkg", "tooling");
  writePackage(tooling, "local-pkg", "fallback");
  writeFileSync(
    join(tooling, "node_modules/local-pkg/package.json"),
    JSON.stringify({ type: "module", exports: { ".": "./index.mjs", "./private": "./index.mjs" } }),
  );
  writePackage(join(checkout, "scripts"), "local-pkg", "local");
  writeFileSync(join(tooling, "relative.mjs"), 'export default "wrong";\n');
  writeFileSync(
    join(checkout, "scripts/watch-pr-ci.mts"),
    `import assert from "node:assert/strict";
import missing from "fixture-pkg";
import local from "local-pkg";
assert.equal(missing, "tooling");
assert.equal(local, "local");
for (const specifier of ["./relative.mjs", new URL("./relative.mjs", import.meta.url).href]) {
  await assert.rejects(import(specifier), { code: "ERR_MODULE_NOT_FOUND" });
}
await assert.rejects(import("local-pkg/private"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
console.log("fallback and local resolution OK");
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: "",
    OPENCLAW_PR_TOOLING_ROOT: tooling,
    OPENCLAW_PR_LOCK_NOTIFY_FD: "",
  };
  // A configured modules directory selects the shim's link path instead of the fallback.
  for (const name of [
    "PNPM_CONFIG_MODULES_DIR",
    "pnpm_config_modules_dir",
    "npm_config_modules_dir",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [join(checkout, "scripts/watch-pr-ci.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("fallback and local resolution OK\n");
  expect(result.stderr).toBe(
    `[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${tooling}\n`,
  );
  expect(existsSync(join(checkout, "node_modules"))).toBe(false);
});
