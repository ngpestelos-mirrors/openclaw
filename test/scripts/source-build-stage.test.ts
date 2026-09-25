import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  writeBuildStamp,
  writeRuntimePostBuildStamp,
} from "../../scripts/lib/local-build-metadata.mts";
import { prepareSourceBuild } from "../../scripts/lib/source-build-stage.mts";
import { resolveBuildRequirement } from "../../scripts/run-node.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  createBuildRequirementDeps,
  createExitedProcess,
  runNodeCommand,
  writeRuntimePostBuildScaffold,
} from "./run-node.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["standalone", "linked"])(
  "keeps clean prebuild evidence and rejects changed inputs in a %s checkout",
  async (layout) => {
    const parent = tempDirs.make("source-build-git-");
    const main = path.join(parent, "main");
    fs.mkdirSync(main);
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(parent, "absent-global"),
      GIT_OPTIONAL_LOCKS: "0",
    };
    const gitAt = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trimEnd();
    gitAt(main, "init", "--quiet", "--template=");
    gitAt(main, "config", "core.autocrlf", "true");
    gitAt(main, "config", "core.filemode", "false");
    gitAt(main, "config", "core.symlinks", "false");
    fs.mkdirSync(path.join(main, "src"));
    const original = "export const value = 1;\n";
    fs.writeFileSync(path.join(main, "src/index.ts"), original);
    fs.writeFileSync(path.join(main, "src/crlf.ts"), "export {};\r\n");
    // A checkout with core.symlinks=false stores tracked links as ordinary files.
    fs.writeFileSync(path.join(main, "src/CLAUDE.md"), "../AGENTS.md");
    fs.writeFileSync(path.join(main, "package.json"), '{"name":"fixture","type":"module"}\n');
    fs.writeFileSync(path.join(main, "tsconfig.json"), "{}\n");
    fs.writeFileSync(path.join(main, ".gitignore"), ".artifacts/\ndist/\ndist-runtime/\n");
    gitAt(main, "add", ".");
    gitAt(main, "update-index", "--chmod=+x", "src/index.ts");
    const linkBlob = gitAt(main, "hash-object", "-w", "src/CLAUDE.md");
    gitAt(main, "update-index", "--cacheinfo", "120000", linkBlob, "src/CLAUDE.md");
    gitAt(
      main,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Synthetic source",
    );
    let root = main;
    if (layout === "linked") {
      root = path.join(parent, "linked");
      gitAt(main, "worktree", "add", "--quiet", "--detach", root, "HEAD");
      gitAt(main, "config", "extensions.worktreeConfig", "true");
      // Effective per-worktree values win over the common repository config.
      gitAt(main, "config", "core.filemode", "true");
      gitAt(main, "config", "core.symlinks", "true");
      gitAt(root, "config", "--worktree", "core.filemode", "false");
      gitAt(root, "config", "--worktree", "core.symlinks", "false");
    }
    gitAt(root, "config", "remote.origin.url", "https://example.invalid/source.git");
    gitAt(root, "config", "core.hooksPath", path.join(parent, "no-hooks"));
    // Real Git, with explicit Windows checkout semantics on every test host.
    // No process.platform mock: a Linux pass is not a native Windows claim.
    fs.chmodSync(path.join(root, "src/index.ts"), 0o644);
    expect(gitAt(root, "status", "--porcelain")).toBe("");
    const checkedOutInput = fs.readFileSync(path.join(root, "src/index.ts"));
    const gitSpawn = (
      command: string,
      args: string[],
      options: SpawnSyncOptionsWithStringEncoding,
    ) => spawnSync(command, args, { ...options, env });
    const deps = { ...createBuildRequirementDeps(root), env, spawnSync: gitSpawn };
    const build = async () => {
      const staged = await prepareSourceBuild(root, env);
      try {
        await writeRuntimePostBuildScaffold(staged.cwd);
        fs.writeFileSync(path.join(staged.cwd, "dist/entry.js"), "export {};\n");
        const stamp = JSON.parse(
          fs.readFileSync(
            writeBuildStamp({
              cwd: staged.cwd,
              env: staged.env,
              spawnSync: gitSpawn,
            }),
            "utf8",
          ),
        );
        writeRuntimePostBuildStamp({ cwd: staged.cwd, env: staged.env, spawnSync: gitSpawn });
        const privateConfig = fs.existsSync(path.join(staged.cwd, ".git/config"))
          ? gitAt(staged.cwd, "config", "--local", "--name-only", "--list")
          : "";
        expect(privateConfig).not.toMatch(/remote\.|hookspath|worktree/);
        staged.assertWritersJoined();
        await staged.publish(async () => {});
        return stamp;
      } finally {
        await staged.cleanup();
      }
    };
    const clean = await build();
    expect(clean).toMatchObject({ head: gitAt(root, "rev-parse", "HEAD"), inputsClean: true });
    expect(resolveBuildRequirement(deps)).toEqual({ shouldBuild: false, reason: "clean" });
    const compile = vi.fn(async () => {
      throw new Error("Unnecessary second build");
    });
    const postbuild = vi.fn(async () => {
      throw new Error("Unnecessary second postbuild");
    });
    const cli = vi.fn(() => createExitedProcess(0, null));
    expect(
      await runNodeCommand(root, {
        args: ["--version"],
        env,
        spawnSync: gitSpawn,
        spawn: cli,
        runBuild: compile,
        runRuntimePostBuild: postbuild,
      }),
    ).toBe(0);
    expect(compile).not.toHaveBeenCalled();
    expect(postbuild).not.toHaveBeenCalled();
    expect(cli).toHaveBeenCalledOnce();
    expect(cli.mock.calls[0]).toEqual(
      expect.arrayContaining([expect.any(String), ["openclaw.mjs", "--version"]]),
    );

    fs.writeFileSync(path.join(root, "src/index.ts"), "export const value = 2;\n");
    expect(resolveBuildRequirement(deps)).toEqual({
      shouldBuild: true,
      reason: "dirty_watched_tree",
    });
    expect(await build()).toMatchObject({ inputsClean: false });
    fs.writeFileSync(path.join(root, "src/index.ts"), checkedOutInput);
    expect(gitAt(root, "status", "--porcelain")).toBe("");
    expect(resolveBuildRequirement(deps)).toEqual({
      shouldBuild: true,
      reason: "build_inputs_unverified",
    });

    // Preserve stricter source settings too: never make every snapshot ignore
    // mode/type changes just because the failing platform normally ignores them.
    const scope = layout === "linked" ? ["--worktree"] : [];
    gitAt(root, "config", ...scope, "core.filemode", "true");
    gitAt(root, "config", ...scope, "core.symlinks", "true");
    expect(gitAt(root, "status", "--porcelain")).toContain("src/index.ts");
    expect(await build()).toMatchObject({ inputsClean: false });
  },
);
