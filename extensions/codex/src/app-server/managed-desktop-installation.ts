/** Per-user, immutable desktop generations selected only by explicit maintenance. */
import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import {
  assertNoSymlinkParentsSync,
  readRegularFileSync,
  replaceFileAtomic,
} from "openclaw/plugin-sdk/security-runtime";

export type CodexManagedDesktopSelection = Readonly<{
  version: 1;
  appName: "ChatGPT.app" | "Codex.app";
  generation: string;
}>;

export type CodexManagedDesktopInstallation = Readonly<{
  selection: CodexManagedDesktopSelection;
  appBundlePath: string;
  receiptContents: string;
  receiptIdentity: string;
}>;

export function resolveCodexManagedDesktopRoot(): string {
  return path.join(os.homedir(), "Library", "Application Support", "OpenClaw", "Codex");
}

export function resolveCodexManagedDesktopReceiptPath(
  root = resolveCodexManagedDesktopRoot(),
): string {
  return path.join(root, "selected.json");
}

export function resolveCodexManagedDesktopAppPath(
  selection: CodexManagedDesktopSelection,
  root = resolveCodexManagedDesktopRoot(),
): string {
  assertSelection(selection);
  return path.join(path.resolve(root), "versions", selection.generation, selection.appName);
}

/** Recognizes retained generations as well as the current one; never follows an alias. */
export function isCodexManagedDesktopAppPath(
  appBundlePath: string,
  root = resolveCodexManagedDesktopRoot(),
): boolean {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(appBundlePath)).split(path.sep);
    if (relative.length !== 3 || relative[0] !== "versions") {
      return false;
    }
    const selection = { version: 1, generation: relative[1], appName: relative[2] };
    assertSelection(selection);
    if (resolveCodexManagedDesktopAppPath(selection, root) !== appBundlePath) {
      return false;
    }
    inspectCandidate(root, appBundlePath);
    return true;
  } catch {
    return false;
  }
}

/** Strict reads let maintenance refuse a damaged receipt instead of overwriting it. */
export function readCodexManagedDesktopSelection(
  root = resolveCodexManagedDesktopRoot(),
): CodexManagedDesktopInstallation | undefined {
  const receipt = readReceipt(root);
  if (!receipt) {
    return undefined;
  }
  const selection: unknown = JSON.parse(receipt.contents);
  assertSelection(selection);
  const appBundlePath = resolveCodexManagedDesktopAppPath(selection, root);
  inspectCandidate(root, appBundlePath);
  return {
    selection,
    appBundlePath,
    receiptContents: receipt.contents,
    receiptIdentity: receipt.identity,
  };
}

/** Atomically selects a validated generation; never moves or removes app resources. */
export async function publishCodexManagedDesktopSelection(params: {
  root?: string;
  selection: CodexManagedDesktopSelection;
  expectedReceipt: { contents: string; identity: string } | undefined;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const root = path.resolve(params.root ?? resolveCodexManagedDesktopRoot());
  const receiptPath = resolveCodexManagedDesktopReceiptPath(root);
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const rootIdentity = inspectRoot(root);
  const appBundlePath = resolveCodexManagedDesktopAppPath(params.selection, root);
  const candidateIdentity = inspectCandidate(root, appBundlePath);
  const assertUnchanged = () => {
    assertCurrent();
    if (inspectRoot(root) !== rootIdentity) {
      throw new Error("Codex managed desktop root changed during publication.");
    }
    const current = readReceipt(root);
    if (
      current?.identity !== params.expectedReceipt?.identity ||
      current?.contents !== params.expectedReceipt?.contents
    ) {
      throw new Error("Codex managed desktop selection changed; retry the update.");
    }
    if (inspectCandidate(root, appBundlePath) !== candidateIdentity) {
      throw new Error("Codex managed desktop candidate changed during publication.");
    }
    assertCurrent();
  };
  await withFileLock(
    receiptPath,
    {
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
      stale: 60_000,
      staleRecovery: "remove-if-definitely-stale",
      assertResourceUnborrowed: () => {
        if (inspectRoot(root) !== rootIdentity) {
          throw new Error("Codex managed desktop root changed while holding its selector lock.");
        }
      },
    },
    async () => {
      assertUnchanged();
      await replaceFileAtomic({
        filePath: receiptPath,
        content: `${JSON.stringify(params.selection)}\n`,
        mode: 0o600,
        preserveExistingMode: false,
        syncTempFile: true,
        syncParentDir: true,
        beforeRename: async () => assertUnchanged(),
      });
    },
  );
}

function assertSelection(value: unknown): asserts value is CodexManagedDesktopSelection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("appName" in value) ||
    (value.appName !== "ChatGPT.app" && value.appName !== "Codex.app") ||
    !("generation" in value) ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.generation) ||
    Object.keys(value).some((key) => !["version", "appName", "generation"].includes(key))
  ) {
    throw new Error("Invalid Codex managed desktop selection.");
  }
}

function inspectRoot(root: string): string {
  if (path.resolve(root) === path.resolve(resolveCodexManagedDesktopRoot())) {
    assertNoSymlinkParentsSync({ rootDir: os.homedir(), targetPath: root });
  }
  const stat = fs.lstatSync(root, { bigint: true });
  assertOwned(stat);
  if (!stat.isDirectory()) {
    throw new Error("Codex managed desktop root must be a real directory.");
  }
  return `${stat.dev}:${stat.ino}`;
}

function inspectCandidate(root: string, appBundlePath: string): string {
  inspectRoot(root);
  const command = path.join(appBundlePath, "Contents", "Resources", "codex");
  assertNoSymlinkParentsSync({
    rootDir: root,
    targetPath: path.dirname(command),
    requireDirectories: true,
    allowMissing: false,
  });
  const bundle = fs.lstatSync(appBundlePath, { bigint: true });
  const executable = fs.lstatSync(command, { bigint: true });
  assertOwned(bundle);
  assertOwned(executable);
  if (!bundle.isDirectory() || !executable.isFile() || !(executable.mode & 0o111n)) {
    throw new Error("Codex managed desktop candidate must contain a real executable.");
  }
  return `${identity(bundle)}:${identity(executable)}`;
}

function readReceipt(root: string): { contents: string; identity: string } | undefined {
  const receiptPath = resolveCodexManagedDesktopReceiptPath(root);
  let before: BigIntStats;
  try {
    before = fs.lstatSync(receiptPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  inspectRoot(root);
  if (!before.isFile()) {
    throw new Error("Codex managed desktop receipt must be a regular file.");
  }
  assertOwned(before);
  const contents = readRegularFileSync({ filePath: receiptPath, maxBytes: 4096 }).buffer.toString(
    "utf8",
  );
  if (identity(fs.lstatSync(receiptPath, { bigint: true })) !== identity(before)) {
    throw new Error("Codex managed desktop receipt changed while reading.");
  }
  return { contents, identity: identity(before) };
}

function assertOwned(stat: BigIntStats): void {
  if ((process.getuid && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o022n) !== 0n) {
    throw new Error(
      "Codex managed desktop files must be owned by this user and not shared-writable.",
    );
  }
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
