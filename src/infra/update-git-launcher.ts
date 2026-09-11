import fs from "node:fs/promises";
import path from "node:path";
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { resolveEnvironmentValue } from "./process-env.js";

/** Match the installer shape; relocation also pins the executable that launched this CLI. */
export async function matchesStandaloneGitWrapper(
  contents: string,
  previousRoot: string,
  platform: NodeJS.Platform,
  expectedNodeRunner?: string,
): Promise<boolean> {
  const expectedEntry =
    platform === "win32"
      ? path.win32.join(previousRoot, "dist", "entry.js")
      : path.join(previousRoot, "dist", "entry.js");
  const lines = contents.trimEnd().split(/\r?\n/u);
  const matchesWindows =
    platform === "win32" &&
    lines.length === 2 &&
    lines[0] === "@echo off" &&
    lines[1] === `node "${expectedEntry}" %*`;
  const execArgs =
    platform === "win32" || lines.length !== 3 ? null : splitShellArgs(lines[2] ?? "");
  const matchesPosix =
    platform !== "win32" &&
    lines[0] === "#!/usr/bin/env bash" &&
    lines[1] === "set -euo pipefail" &&
    execArgs?.length === 4 &&
    execArgs[0] === "exec" &&
    execArgs[2] === expectedEntry &&
    execArgs[3] === "$@";

  if (!matchesWindows && !matchesPosix) {
    return false;
  }
  if (expectedNodeRunner) {
    let executable = execArgs?.[1];
    if (matchesWindows) {
      const pathEnv = resolveEnvironmentValue(process.env, "PATH") ?? "";
      // cmd.exe searches the current directory first unless Windows disables that lookup.
      const windowsSearchPath =
        resolveEnvironmentValue(process.env, "NoDefaultCurrentDirectoryInExePath") !== undefined
          ? pathEnv
          : `${process.cwd()};${pathEnv}`;
      executable = resolveExecutableFromPathEnv("node", windowsSearchPath, process.env, {
        includeExtensionless: false,
        useCache: false,
      });
    }
    if (!executable || !path.isAbsolute(executable)) {
      return false;
    }
    const [actual, expected] = await Promise.all([
      fs.realpath(executable).catch(() => null),
      fs.realpath(expectedNodeRunner).catch(() => null),
    ]);
    return actual !== null && actual === expected;
  }
  return true;
}
