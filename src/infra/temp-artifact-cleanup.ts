import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { removeTemporaryArtifacts } from "./temp-artifact-removal.js";

const log = createSubsystemLogger("infra:temp-artifacts");
const retainedRuntimes = resolveGlobalSingleton(
  Symbol.for("openclaw.retainedUpdateRuntimes"),
  () => new Set<string>(),
);

/** Registration lasts through worker settlement, including failed update reporting. */
export function registerRetainedUpdateRuntime(directory: string): () => void {
  retainedRuntimes.add(directory);
  return () => void retainedRuntimes.delete(directory);
}

export function reportRetainedUpdateRuntime(directory: string, reason: string): string {
  const message = `Runtime retained at ${directory}: ${reason}`;
  try {
    log.warn(message);
  } catch {
    // The caller still records the warning.
  }
  return message;
}

/** Marked updater projections are disposable; live owners and maintenance fence reclamation. */
export async function maintainRetainedUpdateRuntimes(params: {
  packageRoots: readonly string[];
  temporaryDirectories?: readonly string[];
  repair: boolean;
  assertCurrent: () => void;
}): Promise<string[]> {
  const messages: string[] = [];
  const packages = params.packageRoots.map(resolveRealpathOrAbsolute);
  const roots = new Set(
    [
      os.tmpdir(),
      ...(params.temporaryDirectories ?? []),
      ...packages.map((root) => path.dirname(root)),
    ].map(resolveRealpathOrAbsolute),
  );
  for (const parent of roots) {
    try {
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!/^openclaw-update-runtime-[A-Za-z0-9]{6}$/u.test(entry.name)) {
          continue;
        }
        const directory = path.join(parent, entry.name);
        try {
          const before = await fs.lstat(directory);
          if (!before.isDirectory() || (process.getuid && before.uid !== process.getuid())) {
            throw new Error("directory ownership is unknown; inspect it before manual cleanup");
          }
          if (retainedRuntimes.has(directory)) {
            throw new Error("the creating update still owns this runtime");
          }
          let marked = false;
          for (const packageRoot of packages) {
            const base = path.parse(packageRoot).root;
            const tree = path.join(directory, "tree", Buffer.from(base).toString("hex"));
            const marker = path.join(tree, path.relative(base, packageRoot), "package.json");
            if ((await fs.realpath(marker).catch(() => undefined)) !== marker) {
              continue;
            }
            const value: unknown = JSON.parse(await fs.readFile(marker, "utf8"));
            if (isRecord(value) && value.name === "openclaw") {
              marked = true;
              break;
            }
          }
          if (!marked) {
            throw new Error("no recognized runtime marker; inspect it before manual cleanup");
          }
          if (!params.repair) {
            messages.push(
              `Runtime retained at ${directory}: run \`openclaw doctor --fix\` after its workers stop`,
            );
            continue;
          }
          const { inspectOtherOpenClawProcesses } = await import("./openclaw-process-census.js");
          const current = await fs.lstat(directory);
          if (
            current.dev !== before.dev ||
            current.ino !== before.ino ||
            current.ctimeMs !== before.ctimeMs ||
            retainedRuntimes.has(directory)
          ) {
            throw new Error("directory identity or custody changed");
          }
          params.assertCurrent();
          const census = inspectOtherOpenClawProcesses();
          if ("error" in census) {
            throw new Error(census.error);
          }
          if (census.pids.length) {
            throw new Error(
              `other OpenClaw processes are still running (PIDs: ${census.pids.join(", ")})`,
            );
          }
          params.assertCurrent();
          let failure: string | undefined;
          await removeTemporaryArtifacts(directory, "Updater runtime", (error) => {
            failure = `cleanup failed: ${formatErrorMessage(error)}`;
          });
          messages.push(
            failure
              ? reportRetainedUpdateRuntime(directory, failure)
              : `Removed abandoned updater runtime: ${directory}`,
          );
        } catch (error) {
          if (!hasErrnoCode(error, "ENOENT")) {
            messages.push(reportRetainedUpdateRuntime(directory, formatErrorMessage(error)));
          }
        }
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        messages.push(`Cannot inspect updater runtimes in ${parent}: ${formatErrorMessage(error)}`);
      }
    }
  }
  return messages;
}
