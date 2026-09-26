import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function watchPrCiDependencyOptions(checkout) {
  if (statSync(join(checkout, "node_modules"), { throwIfNoEntry: false })?.isDirectory()) {
    return {};
  }
  let root = checkout;
  try {
    const git = (cwd, args) =>
      spawnSync(process.env.OPENCLAW_PR_GIT || "git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    const common = git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.status !== 0) {
      throw new Error("Cannot find the canonical checkout.");
    }
    const canonical = realpathSync(dirname(common.stdout.trim()));
    let requested = process.env.OPENCLAW_PR_TOOLING_ROOT;
    if (!requested) {
      const config = git(canonical, ["config", "--path", "--get", "openclaw.pr.toolingRoot"]);
      if (config.status !== 0 && config.status !== 1) {
        throw new Error("Cannot read openclaw.pr.toolingRoot.");
      }
      requested = config.stdout.trim();
    }
    root = resolve(canonical, requested || ".");
    root = realpathSync(root);
    if (!statSync(join(root, "node_modules"), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("Missing node_modules.");
    }
  } catch {
    throw new Error(
      `Cannot resolve tooling dependencies at ${root}. Install dependencies in this checkout or set OPENCLAW_PR_TOOLING_ROOT to an installed checkout of this repository.`,
    );
  }
  const hook = new URL(import.meta.url);
  hook.searchParams.set("root", root);
  console.error(`[watch-pr-ci] resolving missing packages from scripts/pr tooling root ${root}`);
  // A node_modules link would change scripts/pr's wrapper selection in this checkout.
  return { execArgv: ["--import", hook.href], linkNodeModules: false };
}

const root = new URL(import.meta.url).searchParams.get("root");
if (root) {
  const parentURL = pathToFileURL(join(root, "package.json")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" ||
          isAbsolute(specifier) ||
          /^(?:\.{1,2}(?:\/|$)|[a-z][a-z\d+.-]*:|#)/i.test(specifier)
        ) {
          throw error;
        }
        return nextResolve(specifier, { ...context, parentURL });
      }
    },
  });
}
