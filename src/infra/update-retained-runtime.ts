import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import { isPathInside } from "./path-guards.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import {
  maintainRetainedUpdateRuntimes,
  registerRetainedUpdateRuntime,
  removeTemporaryArtifacts,
  reportRetainedUpdateRuntime,
} from "./temp-artifact-cleanup.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";
import { relocateRuntimePath } from "./update-runtime-relocation.js";

type RetainedUpdateRuntimeMetrics = {
  inventoryMs: number;
  materializationMs: number;
  entries: number;
  /** Allocated footprint estimate, including directories and aliases; not copied bytes. */
  estimatedBytes: number;
  linked: number;
  copied: number;
};

export type RetainUpdateRuntime = (params: {
  mutationRoots: readonly string[];
  timeoutMs: number;
  assertCurrent: () => void;
}) => Promise<RetainedUpdateRuntimeMetrics | void>;

/** The command retains its own workers through reporting, rollback, and native settlement. */
export async function withRetainedUpdateRuntime<T>(
  moduleUrl: string,
  operation: (retain: RetainUpdateRuntime) => Promise<T>,
): Promise<T> {
  let directory: string | undefined;
  let prepared = false;
  let closing = false;
  let preparation: ReturnType<RetainUpdateRuntime> | undefined;
  let unregister: (() => void) | undefined;
  return await withRuntimeWorkerGeneration(
    async (bind) =>
      await operation((params) => {
        preparation = (async () => {
          const { mutationRoots, timeoutMs } = params;
          const assertCurrent = () => {
            if (closing) {
              throw new Error("The updater's retained runtime is closing");
            }
            params.assertCurrent();
          };
          assertCurrent();
          if (prepared) {
            return undefined;
          }
          const root = await resolveOpenClawPackageRoot({ moduleUrl });
          if (!root) {
            throw new Error("Cannot retain the running updater's package root");
          }
          const sourceRoot = await fs.realpath(root);
          assertCurrent();
          if (
            !mutationRoots.some((entry) => {
              const mutation = resolvePathViaExistingAncestorSync(path.resolve(entry));
              return isPathInside(mutation, sourceRoot) || isPathInside(sourceRoot, mutation);
            })
          ) {
            return undefined;
          }
          await maintainRetainedUpdateRuntimes({
            packageRoots: [sourceRoot],
            repair: true,
            assertCurrent,
          });
          assertCurrent();
          directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-runtime-"));
          unregister = registerRetainedUpdateRuntime(directory);
          const privateRoot = await fs.realpath(directory);
          assertCurrent();
          const project = (source: string) => {
            const base = path.parse(source).root;
            return path.join(
              privateRoot,
              "tree",
              Buffer.from(base).toString("hex"),
              path.relative(base, source),
            );
          };
          const candidateRoot = project(sourceRoot);
          const roots = new Map<string, string>();
          for (const name of ["package.json", "dist", "node_modules"]) {
            const entry = path.join(sourceRoot, name);
            const present = await fs.lstat(entry).catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return undefined;
              }
              throw error;
            });
            assertCurrent();
            if (present) {
              roots.set(entry, project(entry));
            }
          }
          const inventoryStartedAt = performance.now();
          const plan = await prepareUpdateCandidatePluginTrees({
            roots,
            project,
            targetStateDir: privateRoot,
            candidateRoot,
            retainedHostRoot: sourceRoot,
            onProgress: assertCurrent,
          });
          const inventoryMs = Math.round(performance.now() - inventoryStartedAt);
          const materializationStartedAt = performance.now();
          const counts = await withUpdateCandidateIoBudget(
            { directory: privateRoot, bytes: plan.bytes, timeoutMs },
            async (signal) =>
              await linkUpdateCandidatePluginTrees(plan, {
                targetStateDir: privateRoot,
                candidateRoot,
                onProgress: () => {
                  signal.throwIfAborted();
                  assertCurrent();
                },
              }),
          );
          assertCurrent();
          const materializationMs = Math.round(performance.now() - materializationStartedAt);
          const relocations = [
            ...plan.relocations,
            ...(root === sourceRoot ? [] : [{ sourceRoot: root, destinationRoot: candidateRoot }]),
          ].map((entry) => Object.freeze({ ...entry }));
          const resolve = (url: URL) =>
            pathToFileURL(relocateRuntimePath(fileURLToPath(url), relocations));
          bind(resolve);
          prepared = true;
          return {
            inventoryMs,
            materializationMs,
            entries: plan.entries.length,
            estimatedBytes: plan.bytes,
            ...counts,
          };
        })();
        return preparation;
      }),
    async (signal) => {
      closing = true;
      // Signals stop projection and join its last filesystem write before cleanup.
      await preparation?.catch(() => undefined);
      if (signal.aborted) {
        return;
      }
      const retained = directory;
      if (retained) {
        await removeTemporaryArtifacts(retained, "Updater runtime", (error) => {
          reportRetainedUpdateRuntime(retained, "cleanup failed: " + formatErrorMessage(error));
        });
      }
      unregister?.();
    },
    (reason, immediate) => {
      if (directory) {
        reportRetainedUpdateRuntime(directory, reason, immediate);
      }
      return directory;
    },
  );
}
