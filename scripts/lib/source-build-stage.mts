// Source runners keep the complete compiler/asset/cache graph private. Only the
// joined result reaches the existing guarded runtime publication owner.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../src/infra/path-guards.js";
import type { RuntimeRelocation } from "../../src/infra/update-runtime-relocation.js";
import { listTsdownOutputRoots } from "../tsdown-build.mts";
import { collectSourceCheckoutPluginBuildEntries } from "./bundled-plugin-build-entries.mjs";
import { assertDistArtifactOwnershipSettled } from "./dist-artifact-ownership.mts";
import { hasUnjoinedWork } from "./managed-child-process.mts";
import {
  createRuntimePublication,
  isRuntimePublicationStagingPath,
  runtimeTreesEqual,
} from "./runtime-publication.mts";
import { listGeneratedExtensionAssetSources } from "./static-extension-assets.mts";

export function listSourceBuildOutputs(root: string, env: NodeJS.ProcessEnv = process.env) {
  // Isolated plugin compilers use package-local dist as scratch, then remove it
  // after copying to root dist. Publish that absence too; stale local dist must
  // not survive a successful source build. Asset-owned outputs come from metadata.
  const pluginOutputs = fs.existsSync(path.join(root, "extensions"))
    ? collectSourceCheckoutPluginBuildEntries({ cwd: root, env })
        .filter((entry) => entry.isolated)
        .map((entry) => "extensions/" + entry.id + "/dist")
    : [];
  const outputs = [
    ...new Set([
      ...listTsdownOutputRoots(),
      ...pluginOutputs,
      ...listGeneratedExtensionAssetSources({ rootDir: root }),
    ]),
  ];
  return outputs.filter(
    (entry) => !outputs.some((other) => other !== entry && isPathInside(other, entry)),
  );
}

const copyOptions = {
  recursive: true,
  preserveTimestamps: true,
  verbatimSymlinks: true,
  mode: fs.constants.COPYFILE_FICLONE,
};

/** The caller retains checkout ownership until every writer has joined. */
export async function prepareSourceBuild(
  rootDir: string,
  inputEnv: NodeJS.ProcessEnv,
  outputs = listSourceBuildOutputs(rootDir, inputEnv),
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { relocateRuntimeTree } = await import("../../src/infra/update-runtime-relocation.js");
  signal?.throwIfAborted();
  const root = fs.realpathSync(rootDir);
  const artifacts = path.join(root, ".artifacts");
  await fs.promises.mkdir(artifacts, { recursive: true });
  const temporary = await fs.promises.mkdtemp(
    path.join(await fs.promises.realpath(artifacts), "source-build-"),
  );
  const cwd = path.join(temporary, "checkout");
  const relocations: RuntimeRelocation[] = [
    { sourceRoot: root, destinationRoot: cwd, sourceAliases: [rootDir] },
  ];
  const publication = createRuntimePublication();
  let retained = false;
  let cleaned = false;
  const cleanup = async () => {
    if (retained) {
      return;
    }
    cleaned = true;
    await publication.finish().cleanup();
    await fs.promises.rm(temporary, { recursive: true, force: true });
  };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...inputEnv, GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.status === 0 ? result.stdout.trimEnd() : undefined;
  };
  const head = git("rev-parse", "HEAD");
  const generated = outputs.filter((output) => !listTsdownOutputRoots().includes(output));
  const originals = path.join(temporary, "original-source-outputs");
  try {
    signal?.throwIfAborted();
    // Exclude ownership/state, not source edits. The private dependency copy is
    // deliberate: symlinking node_modules would expose Jiti/Vite/tool caches.
    const excluded = new Set([".git", ".artifacts", ".openclaw", ".local", ".worktrees"]);
    await fs.promises.mkdir(cwd);
    for (const name of await fs.promises.readdir(root)) {
      signal?.throwIfAborted();
      if (excluded.has(name) || isRuntimePublicationStagingPath(name)) {
        continue;
      }
      await fs.promises.cp(path.join(root, name), path.join(cwd, name), {
        ...copyOptions,
        filter: (source) => !isRuntimePublicationStagingPath(path.relative(root, source)),
      });
    }
    for (const relative of generated) {
      signal?.throwIfAborted();
      const source = path.join(cwd, relative);
      if (fs.existsSync(source)) {
        await fs.promises.cp(source, path.join(originals, relative), copyOptions);
      }
    }
    // External virtual stores and linked dependencies are private too. Register
    // each mapping before traversing it so cyclic package links do not recurse.
    for (const mapping of relocations) {
      const pending = [mapping.destinationRoot];
      while (pending.length) {
        signal?.throwIfAborted();
        const directory = pending.pop()!;
        for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(file);
          } else if (entry.isSymbolicLink()) {
            const source = path.join(
              mapping.sourceRoot,
              path.relative(mapping.destinationRoot, file),
            );
            const target = path.resolve(path.dirname(source), await fs.promises.readlink(file));
            if (relocations.some((owner) => isPathInside(owner.sourceRoot, target))) {
              continue;
            }
            const destination = path.join(temporary, "dependencies", String(relocations.length));
            const stat = await fs.promises.stat(source);
            if (!stat.isDirectory()) {
              // A file link has no package-relative namespace to relocate.
              await fs.promises.unlink(file);
              await fs.promises.copyFile(source, file, fs.constants.COPYFILE_FICLONE);
              continue;
            }
            const real = await fs.promises.realpath(source);
            const known = relocations.find((owner) => owner.sourceRoot === real);
            if (known) {
              known.sourceAliases = [...(known.sourceAliases ?? []), target];
              continue;
            }
            relocations.push({
              sourceRoot: real,
              sourceAliases: [target],
              destinationRoot: destination,
            });
            await fs.promises.cp(real, destination, copyOptions);
          }
        }
      }
    }
    const ordered = relocations.toSorted((a, b) => b.sourceRoot.length - a.sourceRoot.length);
    for (const mapping of relocations) {
      signal?.throwIfAborted();
      await relocateRuntimeTree(
        mapping.destinationRoot,
        mapping.sourceRoot,
        mapping.destinationRoot,
        ordered,
      );
    }
    // Git is read-only build input. Pin HEAD and the index, never hand a child
    // the serving checkout's Git directory or let it discover an ancestor repo.
    const gitDir = path.join(cwd, ".git");
    await fs.promises.mkdir(gitDir);
    const objects = git("rev-parse", "--path-format=absolute", "--git-path", "objects");
    const index = git("rev-parse", "--path-format=absolute", "--git-path", "index");
    if (head && objects && index) {
      await fs.promises.writeFile(path.join(gitDir, "HEAD"), head + "\n");
      await fs.promises.mkdir(path.join(gitDir, "refs"));
      await fs.promises.symlink(objects, path.join(gitDir, "objects"), "junction");
      if (fs.existsSync(index)) {
        await fs.promises.copyFile(index, path.join(gitDir, "index"));
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...inputEnv,
      OPENCLAW_DEV_SOURCE_ROOT: cwd,
      OPENCLAW_BUILD_ALL_NO_PNPM: "1",
      BUILD_ALL_CACHE_ROOT: path.join(cwd, ".artifacts", "build-all-cache"),
      GIT_OPTIONAL_LOCKS: "0",
      TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fs.existsSync(path.join(cwd, "tsconfig.json"))
        ? path.join(cwd, "tsconfig.json")
        : undefined,
      NODE_COMPILE_CACHE: path.join(temporary, "compile-cache"),
      TMPDIR: path.join(temporary, "tmp"),
      TMP: path.join(temporary, "tmp"),
      TEMP: path.join(temporary, "tmp"),
    };
    await fs.promises.mkdir(env.TMPDIR!);
    // Inherited pnpm layout selectors must not reconnect the private copy to
    // the original checkout/store. No install or dependency reconciliation runs.
    for (const name of Object.keys(env)) {
      if (
        /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE)$/u.test(name) ||
        /^(?:pnpm_config|npm_config|PNPM_CONFIG|NPM_CONFIG)_(?:modules_dir|MODULES_DIR|virtual_store_dir|VIRTUAL_STORE_DIR|workspace_dir|WORKSPACE_DIR|lockfile_dir|LOCKFILE_DIR)$/u.test(
          name,
        )
      ) {
        delete env[name];
      }
    }
    signal?.throwIfAborted();
    return {
      cwd,
      env,
      assertWritersJoined: () => assertDistArtifactOwnershipSettled(cwd),
      async publish(assertCurrent: () => Promise<void>) {
        signal?.throwIfAborted();
        if (cleaned || retained) {
          throw new Error("Private source build publication is no longer available.");
        }
        if (git("rev-parse", "HEAD") !== head) {
          throw new Error(
            "Source checkout HEAD changed during the build; retry the original command.",
          );
        }

        // Copy/relocation is preparation, never publication. All compiler/cache
        // writers have joined before these candidate trees are inspected.
        const inverse = relocations.map(({ sourceRoot, destinationRoot }) => ({
          sourceRoot: destinationRoot,
          destinationRoot: sourceRoot,
        }));
        for (const relative of outputs) {
          const source = path.join(cwd, relative);
          const destination = path.join(root, relative);
          if (!fs.existsSync(source) && !fs.existsSync(destination)) {
            continue;
          }
          await assertCurrent();
          signal?.throwIfAborted();
          let parent = path.dirname(destination);
          while (!fs.existsSync(parent)) {
            parent = path.dirname(parent);
          }
          const entry = publication.stageRoot(destination, parent);
          if (generated.includes(relative)) {
            entry.assertUnchanged = () => {
              if (!runtimeTreesEqual(path.join(originals, relative), destination, destination)) {
                throw new Error("Generated source input changed during the build: " + relative);
              }
            };
          }
          if (fs.existsSync(source)) {
            await fs.promises.cp(source, entry.candidate, copyOptions);
            if ((await fs.promises.lstat(entry.candidate)).isDirectory()) {
              await relocateRuntimeTree(entry.candidate, source, destination, inverse);
            }
          }
          entry.changed =
            !generated.includes(relative) ||
            !runtimeTreesEqual(entry.candidate, destination, destination);
        }
        await publication.finish().publish(assertCurrent, signal);
      },
      retainIfUnjoined(error: unknown) {
        if (hasUnjoinedWork(error)) {
          retained = true;
          console.error("Source build writers have not settled; retained " + temporary);
        }
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
