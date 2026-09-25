// Guarded rename publication shared by source-build and runtime-overlay preparation.
import fs from "node:fs";
import path from "node:path";
import { assertRealOutputRoot } from "./output-root-guard.mjs";

export function runtimeTreesEqual(expected: string, actual: string, finalPath = actual): boolean {
  const expectedStat = fs.lstatSync(expected, { throwIfNoEntry: false });
  const actualStat = fs.lstatSync(actual, { throwIfNoEntry: false });
  if (!expectedStat || !actualStat) {
    return expectedStat === actualStat;
  }
  if (expectedStat.isSymbolicLink()) {
    const target = fs.readlinkSync(expected);
    if (actualStat.isSymbolicLink()) {
      return (
        (expectedStat.mode & 0o7777) === (actualStat.mode & 0o7777) &&
        target === fs.readlinkSync(actual)
      );
    }
    // Windows may have materialized this exact canonical link as a copy.
    return (
      process.platform === "win32" &&
      runtimeTreesEqual(fs.realpathSync(path.resolve(path.dirname(finalPath), target)), actual)
    );
  }
  if ((expectedStat.mode & 0o7777) !== (actualStat.mode & 0o7777)) {
    return false;
  }
  if (expectedStat.isFile()) {
    return (
      actualStat.isFile() &&
      expectedStat.size === actualStat.size &&
      fs.readFileSync(expected).equals(fs.readFileSync(actual))
    );
  }
  if (!expectedStat.isDirectory() || !actualStat.isDirectory()) {
    return false;
  }
  const expectedNames = fs.readdirSync(expected).toSorted();
  const actualNames = fs.readdirSync(actual).toSorted();
  return (
    expectedNames.length === actualNames.length &&
    expectedNames.every(
      (name, index) =>
        name === actualNames[index] &&
        runtimeTreesEqual(
          path.join(expected, name),
          path.join(actual, name),
          path.join(finalPath, name),
        ),
    )
  );
}

const RUNTIME_PUBLICATION_PREFIX = ".openclaw-runtime-";

/** Private candidates/backups are never authored source or watcher input. */
export function isRuntimePublicationStagingPath(file: string) {
  return file
    .replaceAll(path.sep, "/")
    .split("/")
    .some((part) => part.startsWith(RUNTIME_PUBLICATION_PREFIX));
}

type PreparedRuntimeRoot = {
  destination: string;
  temporary: string;
  candidate: string;
  previous: string;
  changed: boolean;
  savedOriginal: boolean;
  published: boolean;
  assertUnchanged?: () => void;
};

export function createRuntimePublication() {
  const roots: PreparedRuntimeRoot[] = [];
  let phase: "prepared" | "publishing" | "published" | "failed" | "cleaned" = "prepared";
  const stageRoot = (destination: string, parent: string) => {
    const temporary = fs.mkdtempSync(
      path.join(fs.realpathSync(parent), RUNTIME_PUBLICATION_PREFIX),
    );
    const entry: PreparedRuntimeRoot = {
      destination,
      temporary,
      candidate: path.join(temporary, "candidate"),
      previous: path.join(temporary, "previous"),
      changed: false,
      savedOriginal: false,
      published: false,
    };
    roots.push(entry);
    return entry;
  };
  const cleanupStaging = () => {
    const failures: unknown[] = [];
    for (const entry of roots) {
      if (phase === "failed" && (entry.savedOriginal || entry.published)) {
        continue;
      }
      try {
        fs.rmSync(entry.temporary, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Runtime staging cleanup failed.");
    }
  };
  return {
    stageRoot,
    cleanupStaging,
    finish() {
      return {
        changed: roots.some((entry) => entry.changed),
        async publish(assertCurrent: () => void | Promise<void>, signal?: AbortSignal) {
          if (phase !== "prepared") {
            throw new Error("Prepared runtime publication is no longer available.");
          }
          signal?.throwIfAborted();
          phase = "publishing";
          try {
            for (const entry of roots.filter((root) => root.changed)) {
              await assertCurrent();
              signal?.throwIfAborted();
              assertRealOutputRoot(entry.destination);
              entry.assertUnchanged?.();
              // A root swap stays synchronous so cancellation cannot strand its
              // original between saving it and publishing the replacement.
              if (fs.existsSync(entry.destination)) {
                fs.renameSync(entry.destination, entry.previous);
                entry.savedOriginal = true;
              }
              if (fs.existsSync(entry.candidate)) {
                fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
                fs.renameSync(entry.candidate, entry.destination);
                entry.published = true;
              }
            }
            signal?.throwIfAborted();
            phase = "published";
          } catch (error) {
            phase = "failed";
            const failures: unknown[] = [error];
            for (const entry of roots.toReversed()) {
              if (!entry.savedOriginal && !entry.published) {
                continue;
              }
              try {
                // Cancellation stops forward publication, not safe restoration.
                // Service/path/owner authority still gates every rollback swap.
                await assertCurrent();
                if (entry.published) {
                  fs.rmSync(entry.destination, { recursive: true, force: true });
                  entry.published = false;
                }
                if (entry.savedOriginal) {
                  fs.renameSync(entry.previous, entry.destination);
                  entry.savedOriginal = false;
                }
              } catch (restoreError) {
                failures.push(
                  new Error(`Runtime original retained at ${entry.previous}`, {
                    cause: restoreError,
                  }),
                );
              }
            }
            if (failures.length > 1) {
              throw new AggregateError(failures, "Runtime publication and restoration failed.", {
                cause: error,
              });
            }
            throw error;
          }
        },
        async cleanup() {
          if (phase === "publishing") {
            throw new Error("Cannot clean runtime staging during publication.");
          }
          cleanupStaging();
          if (phase !== "failed") {
            phase = "cleaned";
          }
        },
      };
    },
  };
}
