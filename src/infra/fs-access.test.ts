import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  canAccess,
  canAccessSync,
  directoryExists,
  directoryExistsSync,
  executableFileExists,
  executableFileExistsSync,
  pathEntryExists,
  readDirectoryEntriesSync,
  regularFileExists,
  regularFileExistsSync,
} from "./path-guards.js";

it("keeps access, file and directory discovery policies distinct", async () => {
  await withTestDir({ prefix: "openclaw-access-" }, async (dir) => {
    const file = path.join(dir, "plain.txt");
    await fs.writeFile(file, "fixture");
    for (const candidate of [dir, file]) {
      expect(await canAccess(candidate)).toBe(true);
      expect(canAccessSync(candidate)).toBe(true);
    }
    const missing = path.join(dir, "missing");
    expect(await canAccess(missing)).toBe(false);
    expect(canAccessSync(missing)).toBe(false);
    expect(await pathEntryExists(file)).toBe(true);
    expect(await pathEntryExists(dir)).toBe(true);
    expect(await pathEntryExists(missing)).toBe(false);
    expect(await directoryExists(dir)).toBe(true);
    expect(await directoryExists(file)).toBe(false);
    expect(await directoryExists(missing)).toBe(false);
    expect(await directoryExists(undefined)).toBe(false);
    expect(await regularFileExists(file)).toBe(true);
    expect(await regularFileExists(dir)).toBe(false);
    expect(await regularFileExists(missing)).toBe(false);
    expect(directoryExistsSync(dir)).toBe(true);
    expect(directoryExistsSync(file)).toBe(false);
    expect(directoryExistsSync(missing)).toBe(false);
    expect(regularFileExistsSync(file)).toBe(true);
    expect(regularFileExistsSync(dir)).toBe(false);
    expect(regularFileExistsSync(missing)).toBe(false);
    expect(readDirectoryEntriesSync(dir).map((entry) => [entry.name, entry.isFile()])).toEqual([
      ["plain.txt", true],
    ]);
    expect(readDirectoryEntriesSync(missing)).toEqual([]);
    expect(await executableFileExists(file, "win32")).toBe(true);
    expect(executableFileExistsSync(file, "win32")).toBe(true);
    for (const candidate of [dir, missing]) {
      expect(await executableFileExists(candidate, "win32")).toBe(false);
      expect(executableFileExistsSync(candidate, "win32")).toBe(false);
    }
    const link = path.join(dir, "linked-dir");
    await fs.symlink(dir, link, "junction");
    expect(await directoryExists(link)).toBe(true);
    expect(directoryExistsSync(link)).toBe(true);
    const danglingLink = path.join(dir, "dangling-dir");
    await fs.symlink(missing, danglingLink, "junction");
    expect(await pathEntryExists(danglingLink)).toBe(true);
    expect(await canAccess(danglingLink)).toBe(false);
    if (process.platform !== "win32") {
      await expect(pathEntryExists(path.join(file, "nested"))).rejects.toMatchObject({
        code: "ENOTDIR",
      });
      const fileLink = path.join(dir, "linked-file");
      await fs.symlink(file, fileLink);
      expect(await regularFileExists(fileLink)).toBe(true);
      expect(regularFileExistsSync(fileLink)).toBe(true);
      expect(await executableFileExists(fileLink, "win32")).toBe(true);
      expect(executableFileExistsSync(fileLink, "win32")).toBe(true);
    }
  });
});

it("applies the requested access mode when selecting a candidate", async () => {
  await withTestDir({ prefix: "openclaw-access-mode-" }, async (dir) => {
    const file = path.join(dir, "tool");
    await fs.writeFile(file, "fixture", { mode: 0o644 });
    expect(await canAccess(file, fs.constants.R_OK)).toBe(true);
    expect(canAccessSync(file, fs.constants.R_OK)).toBe(true);
    if (process.platform !== "win32") {
      expect(await canAccess(file, fs.constants.X_OK)).toBe(false);
      expect(canAccessSync(file, fs.constants.X_OK)).toBe(false);
      expect(await executableFileExists(file)).toBe(false);
      expect(executableFileExistsSync(file)).toBe(false);
      await fs.chmod(file, 0o755);
      expect(await canAccess(file, fs.constants.X_OK)).toBe(true);
      expect(canAccessSync(file, fs.constants.X_OK)).toBe(true);
      expect(await executableFileExists(file)).toBe(true);
      expect(executableFileExistsSync(file)).toBe(true);
    }
  });
});
