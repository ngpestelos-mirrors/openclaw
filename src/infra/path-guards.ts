// Exposes generic path guard helpers with fs-safe defaults.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, isPathInside, safeStatSync } from "@openclaw/fs-safe/path";

// Generic path guard facade for containment checks and safe relative paths.
export {
  hasNodeErrorCode,
  isNotFoundPathError,
  normalizeWindowsPathForComparison,
  safeStatSync,
} from "@openclaw/fs-safe/path";
export { isPathInside };

export function directoryExistsSync(filePath: string): boolean {
  return safeStatSync(filePath)?.isDirectory() ?? false;
}

export function regularFileExistsSync(filePath: string): boolean {
  return safeStatSync(filePath)?.isFile() ?? false;
}

/** Optional discovery directories may be absent or unreadable. */
export function readDirectoryEntriesSync(filePath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(filePath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Inspect the entry itself, including dangling links; only ENOENT means absent. */
export async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.lstat(filePath);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Best-effort discovery probe; inaccessible candidates are not usable. */
export async function canAccess(filePath: string, mode?: number): Promise<boolean> {
  try {
    await fsPromises.access(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous discovery probe with the same access-mode contract as Node. */
export function canAccessSync(filePath: string, mode?: number): boolean {
  try {
    fs.accessSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

/** Follow links when discovering a directory; missing or unreadable candidates are absent. */
export async function directoryExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    return (await fsPromises.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

/** Follow links when discovering a regular file; inaccessible candidates are absent. */
export async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Discover a regular executable file, without imposing Windows suffix/PATHEXT policy. */
export async function executableFileExists(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (
    (await canAccess(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK)) &&
    (await regularFileExists(filePath))
  );
}

/** Windows has no POSIX execute bit; a visible regular file preserves its native contract. */
export function executableFileExistsSync(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return false;
    }
    fs.accessSync(filePath, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns true only when target is a descendant of root, not root itself. */
export function isPathStrictlyInside(root: string, target: string): boolean {
  return isPathInside(root, target) && !isPathInside(target, root);
}

/**
 * Normalize a Windows path for boundary math whose result is handed back to callers.
 *
 * Unlike `normalizeWindowsPathForComparison`, this preserves case: `path.win32.relative`
 * already matches roots case-insensitively, so lowercasing only corrupts the returned
 * relative path — and callers create files from it on a case-preserving filesystem.
 * Extended-length prefix stripping stays, or `\\?\`-prefixed inputs read as boundary escapes.
 */
export function normalizeWindowsPathPreservingCase(input: string): string {
  // Mirrors normalizeWindowsPathForComparison step for step, minus the lowercasing,
  // so the only behavior that shifts is the case of the characters handed back.
  // fs-safe 0.5.2 keeps surrounding whitespace (it can disguise reserved names),
  // so this mirror must not trim either.
  const normalized = path.win32.normalize(input);
  if (!normalized.startsWith("\\\\?\\")) {
    return normalized;
  }
  const withoutPrefix = normalized.slice(4);
  return withoutPrefix.toUpperCase().startsWith("UNC\\")
    ? `\\\\${withoutPrefix.slice(4)}`
    : withoutPrefix;
}
