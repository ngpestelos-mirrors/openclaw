import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { assertDirectoryIdentitySync, createDirectorySync } from "@openclaw/fs-safe/advanced";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { pinDirectory, requireDirectorySync } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import {
  copyFileHandle,
  hashFileDescriptorSync,
  sameFileMutationFingerprint,
} from "./file-descriptor.js";

export type LegacyMigrationSourceCopy = {
  verify(): Promise<void>;
  removeSource(removeSource?: (sourcePath: string) => Promise<void> | void): Promise<void>;
  discard(): Promise<void>;
};

function mismatch(message: string): never {
  throw new FsSafeError("path-mismatch", `legacy migration source copy ${message}`);
}

function assertAbsent(filePath: string): void {
  if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
    mismatch(`conflicts with an existing path: ${filePath}`);
  }
}

function assertFile(filePath: string, expected: fs.BigIntStats): void {
  const current = fs.lstatSync(filePath, { bigint: true });
  if (
    !current.isFile() ||
    current.nlink !== 1n ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    mismatch(`file ownership changed: ${filePath}`);
  }
}

/** Read only a retained regular-file generation, without following a replaced leaf. */
function hashGeneration(filePath: string, expected: fs.BigIntStats, maxBytes: number): string {
  assertFile(filePath, expected);
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!sameFileMutationFingerprint(before, expected) || before.nlink !== 1n) {
      mismatch(`generation changed: ${filePath}`);
    }
    const content = hashFileDescriptorSync(fd, maxBytes);
    const after = fs.fstatSync(fd, { bigint: true });
    assertFile(filePath, expected);
    if (
      !sameFileMutationFingerprint(before, after) ||
      after.nlink !== 1n ||
      content.sizeBytes !== maxBytes
    ) {
      mismatch(`changed while hashing: ${filePath}`);
    }
    return content.sha256;
  } finally {
    fs.closeSync(fd);
  }
}

function legacyMigrationCopySourceName(sourcePath: string): string {
  return Buffer.from(path.basename(sourcePath)).toString("base64url");
}

function sourceNameFromCopy(name: string): string | null {
  const encoded =
    /^\.doctor-source-copy-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-([A-Za-z0-9_-]+)$/u.exec(
      name,
    )?.[1];
  if (!encoded) {
    return null;
  }
  const filename = Buffer.from(encoded, "base64url").toString();
  return filename &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("\0") &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    legacyMigrationCopySourceName(filename) === encoded
    ? filename
    : null;
}

/** A private stage identifies its filename; receipts still authorize its deletion. */
export function listLegacyMigrationCopySourcePaths(parent: string): string[] {
  return [
    ...new Set(
      listLegacyMigrationCopyNames(parent).flatMap((name) => {
        const filename = sourceNameFromCopy(name);
        return filename ? [path.join(parent, filename)] : [];
      }),
    ),
  ];
}

/** Other bound consumers may share a parent; only undecodable stages are unbound. */
export function listUnboundLegacyMigrationSourceCopies(parent: string): string[] {
  return listLegacyMigrationCopyNames(parent)
    .filter((name) => sourceNameFromCopy(name) === null)
    .map((name) => path.join(parent, name));
}

/** Inventory is advisory; unknown names are never authorized for deletion. */
export function listLegacyMigrationCopyNames(parent: string): string[] {
  try {
    if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
      return [];
    }
    return fs.readdirSync(parent).filter((name) => name.startsWith(".doctor-source-copy-"));
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

/** Discover recovery artifacts only; the import owner must authorize their removal. */
export function listLegacyMigrationSourceCopies(sourcePath: string): string[] {
  const parent = path.dirname(sourcePath);
  return listLegacyMigrationCopyNames(parent)
    .filter((name) => sourceNameFromCopy(name) === path.basename(sourcePath))
    .map((name) => path.join(parent, name));
}

/** Retire a stranded copy only while its receipt and canonical data remain verified. */
export async function cleanupLegacyMigrationSourceCopy(
  params: {
    stateRoot: Root;
    directory: string;
  } & (
    | { maxBytes: number; verify: (buffer: Buffer, sha256: string) => void }
    | { expectedSizeBytes: number; verifyDigest: (sha256: string) => void }
  ),
): Promise<boolean> {
  const root = params.stateRoot;
  const parent = await pinDirectory(await root.resolve(path.dirname(params.directory)));
  try {
    const parentIdentity = fs.lstatSync(parent.receipt.realPath, { bigint: true });
    await parent.assertCurrent();
    const stagePath = await root.resolve(params.directory);
    const stageIdentity = fs.lstatSync(stagePath, { bigint: true });
    const assertPrivate = (stat: fs.BigIntStats) => {
      if (
        (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) ||
        (stat.mode & 0o077n) !== 0n
      ) {
        mismatch("recovery material is not privately owned");
      }
    };
    const assertStage = () => {
      assertDirectoryIdentitySync(parent.receipt.path, {
        ...parentIdentity,
        realPath: parent.receipt.realPath,
      });
      assertDirectoryIdentitySync(stagePath, { ...stageIdentity, realPath: stagePath });
      assertPrivate(fs.lstatSync(stagePath, { bigint: true }));
    };
    assertStage();
    // A failed post-unlink parent sync must be retried before retiring the last
    // recovery bytes. The import owner verifies its receipt and canonical state.
    requireDirectorySync(await parent.sync(), "Legacy migration source recovery directory");
    const removeEmptyStage = async () => {
      await root.remove(params.directory, {
        assertBeforeMutation: () => {
          assertStage();
          if (fs.readdirSync(stagePath).length !== 0) {
            mismatch("recovery directory is not empty");
          }
        },
      });
      requireDirectorySync(await parent.sync(), "Legacy migration copy recovery directory");
    };
    const entries = fs.readdirSync(stagePath);
    if (entries.length === 0) {
      // A crash after payload removal leaves no recovery bytes. Retire only the
      // still-private empty directory, never incomplete or unknown file material.
      await removeEmptyStage();
      return false;
    }
    if (entries.length !== 1 || entries[0] !== "payload") {
      mismatch("recovery directory contains incomplete or unknown material");
    }
    const relativePayload = path.join(params.directory, "payload");
    const payloadPath = path.join(stagePath, "payload");
    const identity = fs.lstatSync(payloadPath, { bigint: true });
    assertFile(payloadPath, identity);
    assertPrivate(identity);
    let sha256: string;
    let buffer: Buffer | undefined;
    if ("verifyDigest" in params) {
      if (
        !Number.isSafeInteger(params.expectedSizeBytes) ||
        params.expectedSizeBytes < 0 ||
        identity.size !== BigInt(params.expectedSizeBytes)
      ) {
        mismatch("streamed recovery payload has an invalid size");
      }
      sha256 = hashGeneration(payloadPath, identity, params.expectedSizeBytes);
    } else {
      const read = await root.read(relativePayload, {
        hardlinks: "reject",
        symlinks: "reject",
        maxBytes: params.maxBytes,
      });
      buffer = read.buffer;
      sha256 = createHash("sha256").update(buffer).digest("hex");
    }
    const assertPayload = () => {
      assertStage();
      if (hashGeneration(payloadPath, identity, Number(identity.size)) !== sha256) {
        mismatch("recovery payload changed");
      }
      if ("verifyDigest" in params) {
        params.verifyDigest(sha256);
      } else if (buffer) {
        params.verify(buffer, sha256);
      }
    };
    assertPayload();
    await root.remove(relativePayload, { assertBeforeMutation: assertPayload });
    await removeEmptyStage();
    return true;
  } finally {
    await parent.close();
  }
}

/**
 * Retain the original name through the import. The private directory is recovery
 * material, never a fixed claim or an exit-cleaned temporary workspace. The claim
 * owner alone decides when the native-off/link-denied fallback is admissible.
 */
export async function prepareLegacyMigrationSourceCopy(params: {
  stateRoot: Root;
  sourceRelativePath: string;
  claimRelativePath: string;
  expected: { dev: number; ino: number; mtimeMs: number; size: number };
  assertSourceUnchanged: () => Promise<void>;
}): Promise<LegacyMigrationSourceCopy> {
  const { stateRoot: root, sourceRelativePath, claimRelativePath, assertSourceUnchanged } = params;
  const expected = { ...params.expected };
  // Like the portable link publisher, these descriptor operations cannot consume
  // custom Root mutation policies. Never silently bypass them.
  if (
    root.defaults.assertBeforeMutation ||
    root.defaults.denyMutations ||
    root.defaults.mutationSymlinks
  ) {
    throw new FsSafeError(
      "helper-unavailable",
      "source copy cannot apply custom Root mutation policies",
    );
  }
  const size = expected.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new FsSafeError("too-large", "legacy migration source size is not bounded");
  }
  const sourcePath = await root.resolve(sourceRelativePath);
  const claimPath = await root.resolve(claimRelativePath);
  if (path.dirname(sourcePath) !== path.dirname(claimPath) || sourcePath === claimPath) {
    mismatch("requires distinct source and claim names in the same parent");
  }
  const parentRelativePath = path.dirname(sourceRelativePath);
  const parent = await pinDirectory(await root.resolve(parentRelativePath));
  try {
    const admittedParent = await root.stat(parentRelativePath);
    if (
      !admittedParent.isDirectory ||
      admittedParent.dev !== parent.receipt.identity.dev ||
      admittedParent.ino !== parent.receipt.identity.ino
    ) {
      mismatch("parent changed");
    }
    const rootIdentity = fs.lstatSync(root.rootReal, { bigint: true });
    const parentIdentity = fs.lstatSync(parent.receipt.realPath, { bigint: true });
    await parent.assertCurrent();
    const assertParent = () => {
      assertDirectoryIdentitySync(root.rootReal, { ...rootIdentity, realPath: root.rootReal });
      assertDirectoryIdentitySync(parent.receipt.path, {
        ...parentIdentity,
        realPath: parent.receipt.realPath,
      });
    };
    const source = await root.open(sourceRelativePath, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    let sourceIdentity: fs.BigIntStats;
    let sourceHash: string;
    try {
      const stat = fs.fstatSync(source.handle.fd);
      if (
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.mtimeMs !== expected.mtimeMs ||
        stat.size !== size ||
        source.realPath !== sourcePath
      ) {
        mismatch("does not match the admitted source");
      }
      sourceIdentity = fs.fstatSync(source.handle.fd, { bigint: true });
      sourceHash = hashGeneration(sourcePath, sourceIdentity, size);
    } finally {
      await source[Symbol.asyncDispose]();
    }
    const assertSource = () => {
      assertParent();
      assertAbsent(claimPath);
      if (hashGeneration(sourcePath, sourceIdentity, size) !== sourceHash) {
        mismatch("original bytes changed");
      }
      assertParent();
    };
    await assertSourceUnchanged();
    assertSource();

    const stageName = `.doctor-source-copy-${randomUUID()}-${legacyMigrationCopySourceName(sourcePath)}`;
    if (Buffer.byteLength(stageName) > 255) {
      throw new FsSafeError(
        "too-large",
        "legacy migration source filename is too long for a private copy",
      );
    }
    const stageRelativePath = path.join(parentRelativePath, stageName);
    const stagePath = path.join(parent.receipt.realPath, stageName);
    createDirectorySync(stagePath, {
      private: true,
      mode: 0o700,
      assertBeforeMutation: assertSource,
    });
    const stageIdentity = fs.lstatSync(stagePath, { bigint: true });
    let payloadName = "payload.tmp";
    let payloadIdentity: fs.BigIntStats | undefined;
    let completedIdentity: fs.BigIntStats | undefined;
    let discarded = false;
    const recoveryPath = path.join(stagePath, "payload");
    const assertStage = () => {
      assertParent();
      assertDirectoryIdentitySync(stagePath, { ...stageIdentity, realPath: stagePath });
      const current = fs.lstatSync(stagePath, { bigint: true });
      if (current.uid !== stageIdentity.uid || (current.mode & 0o077n) !== 0n) {
        mismatch(`private directory ownership changed: ${stagePath}`);
      }
    };
    const assertPayload = () => {
      assertStage();
      if (!payloadIdentity) {
        mismatch("payload ownership is unknown");
      }
      const payloadPath = path.join(stagePath, payloadName);
      assertFile(payloadPath, payloadIdentity);
      const current = fs.lstatSync(payloadPath, { bigint: true });
      if (current.uid !== payloadIdentity.uid || (current.mode & 0o077n) !== 0n) {
        mismatch(`private payload ownership changed: ${payloadPath}`);
      }
      const entries = fs.readdirSync(stagePath);
      if (entries.length !== 1 || entries[0] !== payloadName) {
        mismatch(`private directory contains unknown entries: ${stagePath}`);
      }
    };
    const assertCopies = () => {
      assertSource();
      assertPayload();
      if (
        !completedIdentity ||
        hashGeneration(recoveryPath, completedIdentity, size) !== sourceHash
      ) {
        mismatch("completed payload changed");
      }
      assertSource();
      assertStage();
    };
    const checkLogicalSource = async () => {
      // Re-enter Root admission after arbitrary caller work, then use synchronous
      // descriptor checks again at every destructive mutation boundary.
      await assertSourceUnchanged();
      const opened = await root.open(sourceRelativePath, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      await opened[Symbol.asyncDispose]();
      assertSource();
    };
    const cleanupStage = async (assertSafeToDiscard: () => void) => {
      if (discarded) {
        return;
      }
      assertSafeToDiscard();
      assertStage();
      if (payloadIdentity) {
        await root.remove(path.join(stageRelativePath, payloadName), {
          assertBeforeMutation: () => {
            assertSafeToDiscard();
            assertPayload();
          },
        });
        payloadIdentity = undefined;
      }
      await root.remove(stageRelativePath, {
        assertBeforeMutation: () => {
          assertSafeToDiscard();
          assertStage();
          if (fs.readdirSync(stagePath).length !== 0) {
            mismatch("private directory is not empty");
          }
        },
      });
      const currentParent = await pinDirectory(parent.receipt);
      try {
        requireDirectorySync(await currentParent.sync(), "Legacy migration copy cleanup directory");
      } finally {
        await currentParent.close();
      }
      discarded = true;
    };
    const copy: LegacyMigrationSourceCopy = {
      async verify() {
        await checkLogicalSource();
        assertCopies();
      },
      async discard() {
        if (!discarded) {
          await checkLogicalSource();
          await cleanupStage(assertSource);
        }
      },
      async removeSource(removeSource) {
        await checkLogicalSource();
        assertCopies();
        if (removeSource) {
          // A trusted caller hook owns its own awaited work and deletion.
          await removeSource(sourcePath);
        } else {
          await root.remove(sourceRelativePath, { assertBeforeMutation: assertCopies });
        }
        const assertRemoved = () => {
          assertParent();
          assertAbsent(sourcePath);
          assertAbsent(claimPath);
        };
        assertRemoved();
        const currentParent = await pinDirectory(parent.receipt);
        try {
          requireDirectorySync(await currentParent.sync(), "Legacy migration source directory");
        } finally {
          await currentParent.close();
        }
        await cleanupStage(assertRemoved);
      },
    };
    try {
      const stage = await pinDirectory({
        path: stagePath,
        realPath: stagePath,
        identity: stageIdentity,
      });
      try {
        const opened = await root.open(sourceRelativePath, {
          hardlinks: "reject",
          symlinks: "reject",
        });
        try {
          assertSource();
          assertStage();
          const target = await fsp.open(
            path.join(stagePath, payloadName),
            fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            payloadIdentity = fs.fstatSync(target.fd, { bigint: true });
            assertPayload();
            const copied = await copyFileHandle(opened.handle, target, {
              maxBytes: size,
              assertBeforeMutation: assertPayload,
            });
            assertSource();
            if (copied !== size || hashFileDescriptorSync(target.fd, size).sha256 !== sourceHash) {
              mismatch("staged bytes differ from the original");
            }
            await target.sync();
          } finally {
            await target.close();
          }
        } finally {
          await opened[Symbol.asyncDispose]();
        }
        await checkLogicalSource();
        assertPayload();
        assertAbsent(recoveryPath);
        // Ordinary rename is safe only inside this exclusively owned private
        // directory. It never targets the source or the shared fixed claim name.
        fs.renameSync(path.join(stagePath, payloadName), recoveryPath);
        payloadName = "payload";
        assertPayload();
        completedIdentity = fs.lstatSync(recoveryPath, { bigint: true });
        assertCopies();
        requireDirectorySync(await stage.sync(), "Legacy migration completed copy directory");
        requireDirectorySync(await parent.sync(), "Legacy migration source copy parent");
        await copy.verify();
        return copy;
      } finally {
        await stage.close();
      }
    } catch (error) {
      try {
        await copy.discard();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Legacy migration copy failed; cleanup could not be verified at ${stagePath}`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  } finally {
    await parent.close();
  }
}
