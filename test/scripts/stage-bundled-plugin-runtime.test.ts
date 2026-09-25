// Stage Bundled Plugin Runtime tests cover stage bundled plugin runtime script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareBundledPluginRuntime,
  stageBundledPluginRuntime,
} from "../../scripts/stage-bundled-plugin-runtime.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-stage-runtime-"));
  try {
    await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

describe("stageBundledPluginRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies files when Windows rejects runtime overlay symlinks", async () => {
    await withTempDir(async (repoRoot) => {
      const sourceFile = path.join(repoRoot, "dist", "extensions", "acpx", "assets", "fixture.txt");
      await fs.promises.mkdir(path.dirname(sourceFile), { recursive: true });
      await fs.promises.writeFile(sourceFile, "asset-body\n", "utf8");

      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const symlinkSpy = vi
        .spyOn(fs, "symlinkSync")
        .mockImplementation((_target, targetPath, type) => {
          if (
            String(targetPath).includes(`${path.sep}dist-runtime${path.sep}`) &&
            type !== "junction"
          ) {
            const error = new Error("no symlink privilege");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
          return undefined;
        });

      stageBundledPluginRuntime({ repoRoot });

      const runtimeFile = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "acpx",
        "assets",
        "fixture.txt",
      );
      expect(await fs.promises.readFile(runtimeFile, "utf8")).toBe("asset-body\n");
      expect(fs.lstatSync(runtimeFile).isSymbolicLink()).toBe(false);
      expect(symlinkSpy).toHaveBeenCalled();
    });
  });

  it("refuses to stage through a symlinked dist root", async () => {
    await withTempDir(async (repoRoot) => {
      const targetDir = path.join(repoRoot, "gateway-dist");
      const pluginFile = path.join(targetDir, "extensions", "acpx", "index.js");
      await fs.promises.mkdir(path.dirname(pluginFile), { recursive: true });
      await fs.promises.writeFile(pluginFile, "export {};\n", "utf8");
      const distLink = path.join(repoRoot, "dist");
      await fs.promises.symlink(targetDir, distLink, "dir");

      expect(() => stageBundledPluginRuntime({ repoRoot })).toThrow(/symbolic link/u);

      expect(await fs.promises.readlink(distLink)).toBe(targetDir);
      expect(await fs.promises.readFile(pluginFile, "utf8")).toBe("export {};\n");
      await expect(fs.promises.stat(path.join(repoRoot, "dist-runtime"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        fs.promises.stat(path.join(targetDir, "extensions", "node_modules")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

function writeRuntimeFixture(repoRoot: string) {
  const files = {
    "package.json": JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/demo": "./dist/plugin-sdk/demo.js" },
    }),
    "dist/plugin-sdk/demo.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/index.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/package.json": '{"name":"demo","type":"module"}\n',
    "dist/extensions/demo/assets/info.txt": "candidate asset\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return {
    runtimeRoot: path.join(repoRoot, "dist-runtime"),
    aliasRoot: path.join(repoRoot, "dist/extensions/node_modules/openclaw"),
  };
}

describe("prepareBundledPluginRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prepares both roots without mutation and publishes imports valid at their final paths", async () => {
    await withTempDir(async (repoRoot) => {
      const { runtimeRoot, aliasRoot } = writeRuntimeFixture(repoRoot);
      const prepared = prepareBundledPluginRuntime({ repoRoot });
      expect(prepared.changed).toBe(true);
      expect(fs.existsSync(runtimeRoot)).toBe(false);
      expect(fs.existsSync(aliasRoot)).toBe(false);
      expect(fs.existsSync(path.dirname(aliasRoot))).toBe(false);
      await prepared.publish(() => undefined);
      await prepared.cleanup();

      const runtime = await import(
        pathToFileURL(path.join(runtimeRoot, "extensions/demo/index.js")).href
      );
      const sdk = await import(pathToFileURL(path.join(aliasRoot, "plugin-sdk/demo.js")).href);
      expect(runtime.generation).toBe("candidate");
      expect(sdk.generation).toBe("candidate");
      expect(
        fs.readFileSync(path.join(runtimeRoot, "extensions/demo/assets/info.txt"), "utf8"),
      ).toBe("candidate asset\n");

      const runtimeBefore = fs.statSync(runtimeRoot);
      const aliasBefore = fs.statSync(aliasRoot);
      const unchanged = prepareBundledPluginRuntime({ repoRoot });
      expect(unchanged.changed).toBe(false);
      await unchanged.publish(() => {
        throw new Error("unchanged artifacts need no publication authority");
      });
      await unchanged.cleanup();
      expect(fs.statSync(runtimeRoot).ino).toBe(runtimeBefore.ino);
      expect(fs.statSync(aliasRoot).ino).toBe(aliasBefore.ino);
    });
  });

  it.each([true, false])(
    "preserves canonical static asset behavior without writing through staging links (copy=%s)",
    async (copyStaticAssets) => {
      vi.stubEnv("OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS", copyStaticAssets ? undefined : "0");
      await withTempDir(async (repoRoot) => {
        const { runtimeRoot, aliasRoot } = writeRuntimeFixture(repoRoot);
        const sourceRoot = path.join(repoRoot, "dist/extensions/demo");
        const staticAssets = ["index.html", "assets/app.js", "assets/app.css"].map((name) => ({
          source: `client/${name}`,
          output: `dist/control-ui/${name}`,
        }));
        fs.writeFileSync(
          path.join(sourceRoot, "package.json"),
          JSON.stringify({ name: "demo", type: "module", openclaw: { build: { staticAssets } } }),
        );
        for (const asset of staticAssets) {
          const output = path.join(sourceRoot, asset.output);
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, `raw ${asset.output}\n`);
        }
        stageBundledPluginRuntime({ repoRoot });
        const aliasBefore = fs.statSync(aliasRoot).ino;
        const liveStatic = path.join(runtimeRoot, "extensions/demo/dist/control-ui");
        const liveBefore = fs.statSync(liveStatic).ino;
        const jsBefore = fs.readFileSync(path.join(liveStatic, "assets/app.js"), "utf8");
        if (copyStaticAssets) {
          fs.rmSync(liveStatic, { recursive: true });
        }
        const sourceBefore = fs.statSync(path.join(sourceRoot, staticAssets[0]!.output));

        const prepared = prepareBundledPluginRuntime({ repoRoot });
        expect(prepared.changed).toBe(copyStaticAssets);
        expect(fs.existsSync(liveStatic)).toBe(!copyStaticAssets);
        expect(fs.statSync(path.join(sourceRoot, staticAssets[0]!.output)).mtimeMs).toBe(
          sourceBefore.mtimeMs,
        );
        await prepared.publish(() => {
          if (!copyStaticAssets) {
            throw new Error("A complete minimal build must not publish runtime changes.");
          }
        });
        await prepared.cleanup();
        expect(fs.statSync(aliasRoot).ino).toBe(aliasBefore);
        if (copyStaticAssets) {
          for (const asset of staticAssets) {
            const output = path.join(runtimeRoot, "extensions/demo", asset.output);
            expect(fs.lstatSync(output).isFile()).toBe(true);
            expect(fs.readFileSync(output, "utf8")).toBe(`raw ${asset.output}\n`);
          }
        } else {
          expect(fs.statSync(liveStatic).ino).toBe(liveBefore);
          expect(fs.readFileSync(path.join(liveStatic, "assets/app.js"), "utf8")).toBe(jsBefore);
        }
        const unchanged = prepareBundledPluginRuntime({ repoRoot });
        expect(unchanged.changed).toBe(false);
        await unchanged.cleanup();
      });
    },
  );

  it.each(["content", "mode", "symlink target"] as const)(
    "detects stale %s even when every required path exists",
    async (difference) => {
      await withTempDir(async (repoRoot) => {
        const { runtimeRoot } = writeRuntimeFixture(repoRoot);
        stageBundledPluginRuntime({ repoRoot });
        const metadata = path.join(runtimeRoot, "extensions/demo/package.json");
        if (difference === "content") {
          fs.writeFileSync(metadata, '{"name":"stale","type":"module"}\n');
        } else if (difference === "mode") {
          fs.chmodSync(metadata, 0o444);
        } else {
          const asset = path.join(runtimeRoot, "extensions/demo/assets/info.txt");
          fs.unlinkSync(asset);
          fs.symlinkSync("../../../../dist/extensions/demo/index.js", asset);
        }
        const prepared = prepareBundledPluginRuntime({ repoRoot });
        expect(prepared.changed).toBe(true);
        await prepared.cleanup();
      });
    },
  );

  it("leaves both live roots intact when preparation fails", async () => {
    await withTempDir(async (repoRoot) => {
      const { runtimeRoot, aliasRoot } = writeRuntimeFixture(repoRoot);
      stageBundledPluginRuntime({ repoRoot });
      const runtimeBefore = fs.statSync(runtimeRoot).ino;
      const aliasBefore = fs.statSync(aliasRoot).ino;
      const originalWrite = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
        if (String(target).includes(".openclaw-runtime-")) {
          throw new Error("staging write failed");
        }
        return originalWrite(target, ...args);
      });
      expect(() => prepareBundledPluginRuntime({ repoRoot })).toThrow("staging write failed");
      expect(fs.statSync(runtimeRoot).ino).toBe(runtimeBefore);
      expect(fs.statSync(aliasRoot).ino).toBe(aliasBefore);
      expect(fs.readdirSync(repoRoot).some((name) => name.startsWith(".openclaw-runtime-"))).toBe(
        false,
      );
      expect(fs.readdirSync(path.dirname(aliasRoot))).toEqual(["openclaw"]);
    });
  });

  it.each([false, true])(
    "restores originals or retains failed restoration (restore fails=%s)",
    async (failRestore) => {
      await withTempDir(async (repoRoot) => {
        const { runtimeRoot, aliasRoot } = writeRuntimeFixture(repoRoot);
        stageBundledPluginRuntime({ repoRoot });
        fs.writeFileSync(path.join(runtimeRoot, "original.txt"), "original runtime");
        fs.writeFileSync(path.join(aliasRoot, "original.txt"), "original alias");
        const prepared = prepareBundledPluginRuntime({ repoRoot });
        const originalRename = fs.renameSync.bind(fs);
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
          if (String(destination) === aliasRoot && path.basename(String(source)) === "candidate") {
            throw new Error("alias publication failed");
          }
          if (
            failRestore &&
            String(destination) === aliasRoot &&
            path.basename(String(source)) === "previous"
          ) {
            throw new Error("alias restoration failed");
          }
          originalRename(source, destination);
        });
        await expect(prepared.publish(() => undefined)).rejects.toThrow(
          failRestore ? "Runtime publication and restoration failed" : "alias publication failed",
        );
        await prepared.cleanup();
        expect(fs.readFileSync(path.join(runtimeRoot, "original.txt"), "utf8")).toBe(
          "original runtime",
        );
        if (failRestore) {
          const retained = fs
            .readdirSync(path.dirname(aliasRoot))
            .find((name) => name.startsWith(".openclaw-runtime-"));
          expect(retained).toBeDefined();
          expect(
            fs.readFileSync(
              path.join(path.dirname(aliasRoot), retained!, "previous/original.txt"),
              "utf8",
            ),
          ).toBe("original alias");
        } else {
          expect(fs.readFileSync(path.join(aliasRoot, "original.txt"), "utf8")).toBe(
            "original alias",
          );
          expect(fs.readdirSync(path.dirname(aliasRoot))).toEqual(["openclaw"]);
        }
      });
    },
  );

  it("keeps live paths present when authority is revoked between root swaps", async () => {
    await withTempDir(async (repoRoot) => {
      const { runtimeRoot, aliasRoot } = writeRuntimeFixture(repoRoot);
      stageBundledPluginRuntime({ repoRoot });
      fs.writeFileSync(path.join(runtimeRoot, "original.txt"), "original runtime");
      fs.writeFileSync(path.join(aliasRoot, "original.txt"), "original alias");
      const aliasBefore = fs.statSync(aliasRoot).ino;
      const prepared = prepareBundledPluginRuntime({ repoRoot });
      let checks = 0;
      await expect(
        prepared.publish(() => {
          expect(
            fs.existsSync(runtimeRoot),
            "authority checks must not expose an absent runtime",
          ).toBe(true);
          expect(fs.existsSync(aliasRoot), "authority checks must not expose an absent alias").toBe(
            true,
          );
          if (++checks > 1) {
            throw new Error("authority revoked");
          }
        }),
      ).rejects.toThrow("Runtime publication and restoration failed");
      await prepared.cleanup();
      expect(fs.existsSync(path.join(runtimeRoot, "extensions/demo/index.js"))).toBe(true);
      expect(fs.statSync(aliasRoot).ino).toBe(aliasBefore);
      const retained = fs
        .readdirSync(repoRoot)
        .find((name) => name.startsWith(".openclaw-runtime-"));
      expect(fs.readFileSync(path.join(repoRoot, retained!, "previous/original.txt"), "utf8")).toBe(
        "original runtime",
      );
    });
  });

  it("keeps supported Windows copy fallbacks unchanged", async () => {
    await withTempDir(async (repoRoot) => {
      const { runtimeRoot } = writeRuntimeFixture(repoRoot);
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const symbolicLink = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
        throw Object.assign(new Error("no symlink privilege"), { code: "EPERM" });
      });
      stageBundledPluginRuntime({ repoRoot });
      const copied = prepareBundledPluginRuntime({ repoRoot });
      expect(copied.changed).toBe(false);
      await copied.cleanup();
      symbolicLink.mockRestore();
      const prepared = prepareBundledPluginRuntime({ repoRoot });
      expect(prepared.changed).toBe(false);
      await prepared.cleanup();
      expect(fs.lstatSync(path.join(runtimeRoot, "extensions/demo/assets/info.txt")).isFile()).toBe(
        true,
      );
    });
  });
});

describe("private source-build publication", () => {
  it("prepares from native Node outside the source tsconfig", async () => {
    await withTempDir(async (root) => {
      fs.mkdirSync(path.join(root, ".git"));
      fs.writeFileSync(path.join(root, "input.txt"), "source input");
      const result = execFileSync(
        resolveTestNodeExecPath(),
        [
          "--input-type=module",
          "--eval",
          `import fs from "node:fs";
          import path from "node:path";
          import { prepareSourceBuild } from ${JSON.stringify(new URL("../../scripts/lib/source-build-stage.mts", import.meta.url).href)};
          const staged = await prepareSourceBuild(process.cwd(), process.env);
          try {
            console.log(JSON.stringify({
              input: fs.readFileSync(path.join(staged.cwd, "input.txt"), "utf8"),
              private: staged.cwd !== process.cwd(),
            }));
          } finally { await staged.cleanup(); }`,
        ],
        {
          cwd: root,
          env: { ...process.env, NODE_OPTIONS: undefined, TSX_TSCONFIG_PATH: undefined },
          encoding: "utf8",
        },
      );
      expect(JSON.parse(result)).toEqual({ input: "source input", private: true });
      expect(fs.readdirSync(path.join(root, ".artifacts"))).toEqual([]);
    });
  });

  it("rebinds copied relative directory links for Windows asset dependencies", async () => {
    const { prepareSourceBuild } = await import("../../scripts/lib/source-build-stage.mts");
    await withTempDir(async (root) => {
      fs.mkdirSync(path.join(root, ".git"));
      const packageDir = "node_modules/.pnpm/asset-package/node_modules/asset-package";
      const alias = "extensions/demo/node_modules/asset-package";
      fs.mkdirSync(path.join(root, packageDir), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(root, alias)), { recursive: true });
      fs.writeFileSync(
        path.join(root, packageDir, "package.json"),
        JSON.stringify({ name: "asset-package", main: "index.js" }),
      );
      fs.writeFileSync(path.join(root, packageDir, "index.js"), "original dependency");
      const relative = path.relative(
        path.dirname(path.join(root, alias)),
        path.join(root, packageDir),
      );
      fs.symlinkSync(relative, path.join(root, alias), "dir");
      // Node 24's fs.cp can infer a file symlink before its directory target is
      // copied. The unchanged relative target must still be rebound by type.
      // On POSIX this checks the Windows API contract, not native Windows traversal.
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const symlink = vi.spyOn(fs.promises, "symlink");
      try {
        const staged = await prepareSourceBuild(root, {});
        try {
          expect(symlink).toHaveBeenCalledWith(
            path.join(staged.cwd, packageDir),
            path.join(staged.cwd, alias),
            "junction",
          );
          const require = createRequire(path.join(staged.cwd, "extensions/demo/build.mjs"));
          const resolved = require.resolve("asset-package");
          expect(resolved).toBe(path.join(staged.cwd, packageDir, "index.js"));
          fs.writeFileSync(resolved, "private dependency write");
          expect(fs.readFileSync(path.join(root, packageDir, "index.js"), "utf8")).toBe(
            "original dependency",
          );
          expect(fs.readlinkSync(path.join(root, alias))).toBe(relative);
        } finally {
          await staged.cleanup();
        }
      } finally {
        symlink.mockRestore();
        platform.mockRestore();
      }
    });
  });

  it.each([false, true])(
    "isolates dependency caches and preserves source edits (drift=%s)",
    async (drift) => {
      const { prepareSourceBuild } = await import("../../scripts/lib/source-build-stage.mts");
      await withTempDir(async (parent) => {
        const root = path.join(parent, "checkout");
        const modules = path.join(parent, "external-modules");
        fs.mkdirSync(path.join(root, ".git"), { recursive: true });
        fs.mkdirSync(path.join(modules, "dependency"), { recursive: true });
        fs.writeFileSync(path.join(modules, "dependency", "index.js"), "dependency");
        fs.symlinkSync(modules, path.join(root, "node_modules"), "junction");
        const files = {
          "dist/entry.js": "original runtime",
          "extensions/demo/dist/control-ui/index.js": "original UI",
          "packages/ai/dist/index.js": "original package",
          "extensions/demo/package.json": JSON.stringify({
            openclaw: {
              assetScripts: {
                build: "fixture",
                buildOutputs: ["dist/control-ui", "generated.txt"],
              },
            },
          }),
          "extensions/demo/generated.txt": "original generated",
        };
        for (const [relative, content] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
          fs.writeFileSync(path.join(root, relative), content);
        }
        const staged = await prepareSourceBuild(root, {});
        try {
          expect(fs.realpathSync(path.join(staged.cwd, "node_modules"))).not.toBe(modules);
          fs.writeFileSync(
            path.join(staged.cwd, "node_modules/dependency/index.js"),
            "private cache write",
          );
          expect(fs.readFileSync(path.join(modules, "dependency/index.js"), "utf8")).toBe(
            "dependency",
          );
          for (const relative of [
            "dist/entry.js",
            "packages/ai/dist/index.js",
            "extensions/demo/dist/control-ui/index.js",
            "extensions/demo/generated.txt",
          ]) {
            fs.writeFileSync(path.join(staged.cwd, relative), "candidate");
          }
          if (drift) {
            fs.writeFileSync(path.join(root, "extensions/demo/generated.txt"), "operator edit");
          }
          const publish = staged.publish(async () => {});
          if (drift) {
            await expect(publish).rejects.toThrow("Generated source input changed");
          } else {
            await publish;
          }
          expect(
            fs.readFileSync(path.join(root, "extensions/demo/dist/control-ui/index.js"), "utf8"),
          ).toBe(drift ? "original UI" : "candidate");
          expect(fs.readFileSync(path.join(root, "dist/entry.js"), "utf8")).toBe(
            drift ? "original runtime" : "candidate",
          );
          expect(fs.readFileSync(path.join(root, "packages/ai/dist/index.js"), "utf8")).toBe(
            drift ? "original package" : "candidate",
          );
          expect(fs.readFileSync(path.join(root, "extensions/demo/generated.txt"), "utf8")).toBe(
            drift ? "operator edit" : "candidate",
          );
        } finally {
          await staged.cleanup();
        }
        expect(fs.existsSync(staged.cwd)).toBe(false);
        await expect(staged.publish(async () => {})).rejects.toThrow("no longer available");
      });
    },
  );
});
