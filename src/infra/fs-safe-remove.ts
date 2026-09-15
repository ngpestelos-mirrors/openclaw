// Safe recursive removal without coupling the file-access surface to log redaction.
import "./fs-safe-defaults.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { isMissingPathError } from "./errno.js";
import { retainMutationAuthority } from "./mutation-authority.js";

type PinnedPath = { path: string; stat: BigIntStats };
const RETRYABLE_REMOVE_ERRORS = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

function isNotFoundError(error: unknown): boolean {
  return isMissingPathError(error) || isMissingPathError(findMappedFilesystemCause(error));
}

function findMappedFilesystemCause(error: unknown): NodeJS.ErrnoException | undefined {
  const removalObservation =
    error instanceof FsSafeError &&
    error.details?.operation === "remove" &&
    (error.details.phase === "enumerate" || error.details.phase === "inspect");
  if ((error as NodeJS.ErrnoException | undefined)?.code !== "path-alias" && !removalObservation) {
    return undefined;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeCode = (cause as NodeJS.ErrnoException | undefined)?.code;
  return typeof causeCode === "string" && /^E[A-Z0-9_]+$/u.test(causeCode)
    ? (cause as NodeJS.ErrnoException)
    : undefined;
}

function filesystemCode(error: unknown): string | undefined {
  // SAFETY: This optional code probe classifies errno syntax without replacing the original thrown value.
  const candidate = error as NodeJS.ErrnoException | undefined;
  if (candidate?.code && /^E[A-Z0-9_]+$/u.test(candidate.code)) {
    return candidate.code;
  }
  if (
    candidate?.code === "not-removable" ||
    candidate?.code === "not-empty" ||
    candidate?.code === "path-alias"
  ) {
    // SAFETY: For these fs-safe wrappers, inspect the optional cause code and accept only errno syntax.
    const causeCode = (candidate.cause as NodeJS.ErrnoException | undefined)?.code;
    return causeCode && /^E[A-Z0-9_]+$/u.test(causeCode) ? causeCode : undefined;
  }
  return undefined;
}

/** Cleanup callers may retain ordinary I/O failures, but never a refused path proof. */
export function isRemovalIoError(error: unknown): boolean {
  return filesystemCode(error) !== undefined;
}

function pinPath(filePath: string): PinnedPath {
  return { path: filePath, stat: fsSync.lstatSync(filePath, { bigint: true }) };
}

function assertPinnedPath(pinned: PinnedPath, allowMissing = false): boolean {
  let current: BigIntStats | undefined;
  try {
    current = fsSync.lstatSync(pinned.path, { bigint: true, throwIfNoEntry: false });
  } catch (cause) {
    throw new FsSafeError("path-mismatch", `removal path could not be verified: ${pinned.path}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  if (!current && allowMissing) {
    return false;
  }
  if (
    !current ||
    current.dev !== pinned.stat.dev ||
    current.ino !== pinned.stat.ino ||
    current.isDirectory() !== pinned.stat.isDirectory() ||
    current.isSymbolicLink() !== pinned.stat.isSymbolicLink() ||
    (process.platform === "win32" &&
      (current.dev === 0n ||
        current.ino === 0n ||
        pinned.stat.dev === 0n ||
        pinned.stat.ino === 0n))
  ) {
    throw new FsSafeError("path-mismatch", `removal path changed: ${pinned.path}`);
  }
  return true;
}

function assertPinnedDirectory(pinned: PinnedPath): void {
  if (!pinned.stat.isDirectory() || pinned.stat.isSymbolicLink()) {
    throw new FsSafeError("symlink", `removal parent is not a directory: ${pinned.path}`);
  }
  assertPinnedPath(pinned);
}

export async function removePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  recursive?: boolean;
  force?: boolean;
  assertBeforeMutation?: () => void;
  /** Package trees contain links; unlink their leaves without traversing their targets. */
  symlinks?: "reject" | "unlink";
  maxRetries?: number;
  retryDelay?: number;
}): Promise<void> {
  const assertOwner = retainMutationAuthority(params.assertBeforeMutation ?? (() => {}));
  const assertCurrent = retainMutationAuthority((assertPaths?: () => void) => {
    assertOwner();
    assertPaths?.();
  });
  assertCurrent();
  const root = await fsSafeRoot(params.rootDir);
  assertCurrent();
  const suppressNotFound = params.force !== false;
  const run = async <T>(operation: () => Promise<T>, assertReady: () => void): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      assertReady();
      try {
        const value = await operation();
        assertReady();
        return value;
      } catch (error) {
        // A refused callback may resemble an errno. It must escape before missing
        // paths, retry delays, or a later successful lease read can hide it.
        assertReady();
        if (
          attempt >= (params.maxRetries ?? 0) ||
          !RETRYABLE_REMOVE_ERRORS.has(filesystemCode(error) ?? "")
        ) {
          throw error;
        }
        await delay((attempt + 1) * (params.retryDelay ?? 100));
      }
    }
  };
  // Recursive fs-safe removal inspects sibling names lazily. Pin every sibling
  // before mutation so later visits and retries cannot adopt replacement objects.
  const removeEntry = async (entry: PinnedPath, parents: readonly PinnedPath[]): Promise<void> => {
    const assertParents = () => assertCurrent(() => parents.forEach(assertPinnedDirectory));
    const inspectEntry = () => {
      let present = false;
      assertCurrent(() => {
        parents.forEach(assertPinnedDirectory);
        present = assertPinnedPath(entry, true);
      });
      return present;
    };
    const assertEntry = () => {
      // A peer may already have removed this leaf. Keep that ordinary absence
      // outside the sticky receipt; owner, parent, and replacement refusals stay sticky.
      if (!inspectEntry()) {
        throw new FsSafeError("not-found", "file not found");
      }
    };
    try {
      assertEntry();
      const relativePath = path.relative(root.rootReal, entry.path);
      if (entry.stat.isSymbolicLink() && params.symlinks !== "unlink") {
        throw new FsSafeError("symlink", `symlink not allowed: ${relativePath}`);
      }
      if (params.recursive && entry.stat.isDirectory()) {
        const names = (await run(() => root.list(relativePath), assertEntry)).toSorted();
        // Public directory entries use numeric identities. Capture bigint receipts
        // before awaits, and retain them across retries instead of adopting replacements.
        const children: PinnedPath[] = [];
        for (const name of names) {
          assertEntry();
          try {
            children.push(pinPath(path.join(entry.path, name)));
          } catch (error) {
            assertEntry();
            if (!suppressNotFound || !isNotFoundError(error)) {
              throw error;
            }
          }
        }
        for (const child of children) {
          await removeEntry(child, [...parents, entry]);
        }
        assertEntry();
      }
      await run(async () => {
        try {
          // This walk owns link policy and canonical parent pins. An unset leaf
          // mutation policy permits explicitly admitted links to be unlinked.
          await root.remove(relativePath, { assertBeforeMutation: assertEntry });
        } catch (error) {
          inspectEntry();
          if (
            process.platform !== "win32" ||
            filesystemCode(error) !== "EPERM" ||
            entry.stat.isSymbolicLink()
          ) {
            throw error;
          }
          // Preserve Node's Windows read-only-file repair, fencing chmod as well
          // as unlink. A link must never make its external target writable.
          assertEntry();
          await fs.chmod(entry.path, 0o666);
          assertParents();
          await root.remove(relativePath, { assertBeforeMutation: assertEntry });
        }
      }, assertParents);
    } catch (error) {
      inspectEntry();
      if (!suppressNotFound || !isNotFoundError(error)) {
        throw error;
      }
    }
  };
  try {
    const name = path.basename(params.relativePath);
    if (name === "" || name === "." || name === "..") {
      throw new FsSafeError("invalid-path", "removal requires a path below the root");
    }
    const resolvedParent = await run(
      () => root.resolve(path.dirname(params.relativePath)),
      assertCurrent,
    );
    // An explicitly selected parent may be an in-root alias. Bind its canonical
    // directory once; recursive traversal still never follows symlink children.
    const parent = await run(
      async () => root.resolve(await fs.realpath(resolvedParent)),
      assertCurrent,
    );
    const parents = [pinPath(root.rootReal)];
    let current = root.rootReal;
    for (const component of path.relative(root.rootReal, parent).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      parents.push(pinPath(current));
    }
    assertCurrent(() => parents.forEach(assertPinnedDirectory));
    await removeEntry(pinPath(path.join(parent, name)), parents);
  } catch (error) {
    assertCurrent();
    if (isNotFoundError(error)) {
      if (suppressNotFound) {
        return;
      }
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw findMappedFilesystemCause(error) ?? error;
  }
}
