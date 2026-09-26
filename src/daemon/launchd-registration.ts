/** Local launchd registration identity; never serialized into updater receipts. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncDirectoryBestEffort } from "@openclaw/fs-safe/durability";
import { hasErrnoCode } from "../infra/errno.js";
import {
  readServiceFileState,
  type GatewayServiceDefinitionTransactionHooks,
} from "./service-stage.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

export type LaunchAgentArtifactState = NonNullable<
  Awaited<ReturnType<typeof readServiceFileState>>
> & { registrationTarget?: string };

/** Only the former-home registration may be a link, and only to its canonical plist. */
export async function readLaunchAgentArtifactState(
  file: string,
  registrationTarget?: string,
): Promise<LaunchAgentArtifactState | null> {
  const before = await fs.lstat(file).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!before) {
    return null;
  }
  if (!before.isSymbolicLink()) {
    return readServiceFileState(file);
  }
  if (!registrationTarget) {
    throw new Error("Managed service artifact is not a regular file.");
  }
  const target = await fs.readlink(file);
  const after = await fs.lstat(file);
  const keys = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode"] as const;
  if (!after.isSymbolicLink() || keys.some((key) => before[key] !== after[key])) {
    throw new Error("LaunchAgent registration changed during inspection.");
  }
  if (target !== registrationTarget) {
    throw new Error("The former-home LaunchAgent registration targets a different definition.");
  }
  return {
    registrationTarget: target,
    sha256: createHash("sha256").update(target).digest("hex"),
    mode: after.mode & 0o7777,
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  };
}

/** Replace a captured regular definition only after its replacement is activated. */
export async function publishLaunchAgentRegistration(params: {
  file: string;
  target: string;
  hooks: GatewayServiceDefinitionTransactionHooks;
}): Promise<void> {
  const directory = path.dirname(params.file);
  const temporary = path.join(
    directory,
    `.${path.basename(params.file)}.registration-${randomUUID()}`,
  );
  assertGatewayServiceUpdateCurrent();
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  assertGatewayServiceUpdateCurrent();
  await fs.symlink(params.target, temporary);
  try {
    const prepared = await readLaunchAgentArtifactState(temporary, params.target);
    if (prepared?.registrationTarget !== params.target) {
      throw new Error("Prepared LaunchAgent registration is not its expected symbolic link.");
    }
    await params.hooks.beforeWrite();
    await params.hooks.filePrepared(params.file, temporary);
    if (
      !isDeepStrictEqual(prepared, await readLaunchAgentArtifactState(temporary, params.target))
    ) {
      throw new Error("Prepared LaunchAgent registration changed before publication.");
    }
    assertGatewayServiceUpdateCurrent();
    params.hooks.assertCurrent();
    await fs.rename(temporary, params.file);
    await syncDirectoryBestEffort(directory);
    await params.hooks.fileWritten(params.file, params.target);
  } finally {
    await fs.unlink(temporary).catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
    });
  }
}
