import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { prepareDirtyGitUpdateRelocation } from "./update-command-git-relocation.js";

const SHA = "a".repeat(40);
const commands = vi.hoisted(() => ({
  dirty: true,
  npmRoot: "/unused/lib/node_modules",
  npmHook: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../process/exec.js", async (load) => ({
  ...(await load<typeof import("../../process/exec.js")>()),
  runCommandWithTimeout: vi.fn(async (argv: string[]) => {
    if (argv.includes("status")) {
      return { code: 0, stdout: commands.dirty ? " M local.txt\n" : "", stderr: "" };
    }
    if (argv.includes("rev-parse")) {
      return { code: 0, stdout: SHA, stderr: "" };
    }
    if (argv[0] === "npm") {
      await commands.npmHook?.();
      return {
        code: 0,
        stdout: argv.includes("--version") ? "12.0.0" : commands.npmRoot,
        stderr: "",
      };
    }
    throw new Error(`Unexpected command: ${argv.join(" ")}`);
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  commands.dirty = true;
  commands.npmHook = undefined;
});

async function fixture(base: string) {
  commands.npmRoot = path.join(base, "prefix/lib/node_modules");
  const root = path.join(base, "original");
  const bin = path.join(base, "prefix", "bin");
  await fs.mkdir(path.join(root, "dist/control-ui/assets"), { recursive: true });
  await fs.mkdir(bin, { recursive: true });
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
    "local.txt": "operator edits\n",
    "dist/entry.js": "export {};\n",
    "dist/build-info.json": JSON.stringify({ commit: SHA, buildId: "previous-build" }),
    "dist/.buildstamp": JSON.stringify({ head: SHA }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: SHA }),
    "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
    "dist/control-ui/assets/startup.js": "export {};\n",
  })) {
    await fs.writeFile(path.join(root, file), value);
  }
  const launcher = path.join(bin, "openclaw");
  const contents = `#!/usr/bin/env bash\nset -euo pipefail\nexec ${process.execPath} ${root}/dist/entry.js "$@"\n`;
  await fs.writeFile(launcher, contents, { mode: 0o755 });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("OPENCLAW_GIT_DIR", path.join(base, "fresh"));
  return { root, launcher, contents, bin };
}

describe.skipIf(process.platform === "win32")("dirty dev installation relocation", () => {
  it.each(["installer", "npm"])(
    "pins the %s launcher prefix and preserves the original checkout",
    async (owner) => {
      await withTestDir({ prefix: "dirty-dev-" }, async (base) => {
        const { root, launcher, contents } = await fixture(base);
        if (owner === "npm") {
          await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n", { mode: 0o755 });
          await fs.mkdir(commands.npmRoot, { recursive: true });
          await fs.symlink(root, path.join(commands.npmRoot, "openclaw"));
          await fs.unlink(launcher);
          await fs.symlink(path.join(root, "openclaw.mjs"), launcher);
        }
        const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
        expect(plan?.directory).toBe(path.join(base, "fresh"));
        expect(plan?.installTarget.packageRoot).toBe(
          path.join(base, "prefix/lib/node_modules/openclaw"),
        );
        await expect(plan?.assertCurrent()).resolves.toBeUndefined();
        expect(await fs.readFile(launcher, "utf8")).toBe(
          owner === "npm" ? "export {};\n" : contents,
        );
        expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator edits\n");
        await expect(fs.stat(path.join(base, "fresh"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
  it.each([
    "custom launcher",
    "custom executable",
    "custom symlink",
    "outside npm prefix",
    "other package",
    "inside source",
    "changed launcher",
    "changed Node executable",
  ])("refuses %s without touching source", async (kind) => {
    await withTestDir({ prefix: "dirty-dev-refusal-" }, async (base) => {
      const { root, launcher } = await fixture(base);
      if (kind === "custom launcher") {
        await fs.writeFile(launcher, "#!/bin/sh\necho custom\n");
      }
      if (kind === "custom executable") {
        const executable = path.join(base, "custom-program");
        await fs.writeFile(executable, "#!/bin/sh\necho custom\n", { mode: 0o755 });
        await fs.writeFile(
          launcher,
          `#!/usr/bin/env bash\nset -euo pipefail\nexec ${executable} ${root}/dist/entry.js "$@"\n`,
        );
      }
      if (kind === "custom symlink") {
        await fs.writeFile(path.join(root, "custom.js"), "export {};\n", { mode: 0o755 });
        await fs.mkdir(commands.npmRoot, { recursive: true });
        await fs.symlink(root, path.join(commands.npmRoot, "openclaw"));
        await fs.unlink(launcher);
        await fs.symlink(path.join(root, "custom.js"), launcher);
      }
      if (kind === "outside npm prefix") {
        await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n", { mode: 0o755 });
        await fs.mkdir(commands.npmRoot, { recursive: true });
        await fs.symlink(root, path.join(commands.npmRoot, "openclaw"));
        const aliasBin = path.join(base, "custom-bin");
        await fs.mkdir(aliasBin);
        await fs.symlink(path.join(root, "openclaw.mjs"), path.join(aliasBin, "openclaw"));
        vi.stubEnv("PATH", aliasBin);
      }
      if (kind === "other package") {
        await fs.mkdir(path.join(base, "prefix/lib/node_modules/openclaw"), { recursive: true });
      }
      if (kind === "inside source") {
        vi.stubEnv("OPENCLAW_GIT_DIR", path.join(root, "nested"));
      }
      if (kind === "changed Node executable") {
        const nodeAlias = path.join(base, "node");
        const replacement = path.join(base, "replacement-node");
        await fs.writeFile(replacement, "#!/bin/sh\necho custom\n", { mode: 0o755 });
        await fs.symlink(process.execPath, nodeAlias);
        await fs.writeFile(
          launcher,
          `#!/usr/bin/env bash\nset -euo pipefail\nexec ${nodeAlias} ${root}/dist/entry.js "$@"\n`,
        );
        commands.npmHook = async () => {
          await fs.unlink(nodeAlias);
          await fs.symlink(replacement, nodeAlias);
        };
      }
      if (kind === "changed launcher") {
        commands.npmHook = () => fs.writeFile(launcher, "#!/bin/sh\necho replacement\n");
      }
      await expect(prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 })).rejects.toThrow(
        kind === "changed Node executable"
          ? "active launcher changed"
          : "The original checkout was not changed",
      );
      expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator edits\n");
    });
  });
  it("invalidates a plan when the global package symlink acquires another owner", async () => {
    await withTestDir({ prefix: "dirty-dev-owner-" }, async (base) => {
      const { root } = await fixture(base);
      const target = path.join(base, "prefix/lib/node_modules/openclaw");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(root, target);
      const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
      await fs.unlink(target);
      await fs.symlink(base, target);
      await expect(plan?.assertCurrent()).rejects.toThrow("installation path changed");
    });
  });
  it("refuses to recover a different build of the same source commit", async () => {
    await withTestDir({ prefix: "dirty-dev-build-owner-" }, async (base) => {
      const { root } = await fixture(base);
      const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
      await fs.writeFile(
        path.join(root, "dist/build-info.json"),
        JSON.stringify({ commit: SHA, buildId: "replacement-build" }),
      );
      await expect(plan?.assertCurrent()).rejects.toThrow("previous built runtime changed");
    });
  });
  it.each(["appeared", "populated", "replaced"])(
    "refuses a fresh destination that was %s after planning",
    async (change) => {
      await withTestDir({ prefix: "dirty-dev-destination-" }, async (base) => {
        const { root } = await fixture(base);
        const destination = path.join(base, "fresh");
        if (change !== "appeared") {
          await fs.mkdir(destination);
        }
        const plan = await prepareDirtyGitUpdateRelocation({ root, timeoutMs: 1000 });
        if (change === "replaced") {
          await fs.rename(destination, path.join(base, "old-empty"));
        }
        if (change !== "populated") {
          await fs.mkdir(destination);
        }
        if (change === "populated") {
          await fs.writeFile(path.join(destination, "other-owner.txt"), "keep\n");
        }
        await expect(plan?.assertCurrent({ requireFreshDestination: true })).rejects.toThrow(
          "destination changed",
        );
      });
    },
  );
  it("leaves a clean checkout on its existing update route", async () => {
    commands.dirty = false;
    await expect(
      prepareDirtyGitUpdateRelocation({ root: "/unused", timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });
});
