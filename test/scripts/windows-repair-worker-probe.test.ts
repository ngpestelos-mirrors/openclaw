import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import {
  createPackagedOwnerLoader,
  type PackagedOwnerEvidence,
} from "../../scripts/lib/windows-repair-package.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function fixture(files: Record<string, string>) {
  const root = directories.make("windows-repair-package-owner-");
  const packageRoot = path.join(root, "package");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(packageRoot, "dist", name), contents);
  }
  const lifecycleMarker = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  await fs.writeFile(lifecycleMarker, "pending\n");
  const tarball = path.join(root, "candidate.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", root, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  await fs.rm(lifecycleMarker);
  return { packageRoot, tarball };
}

async function loadPackagedOwner(
  packageRoot: string,
  tarball: string,
  stem: string,
  names: string[],
  evidence: PackagedOwnerEvidence[],
) {
  const loadOwner = await createPackagedOwnerLoader(packageRoot, tarball);
  return loadOwner(stem, names, evidence);
}

it.each([
  { alias: "a", split: false },
  { alias: "$", split: false },
  { alias: "a", split: true },
  { alias: "$", split: true },
])(
  "loads named package owners through $alias with split chunks=$split",
  async ({ alias, split }) => {
    const admit = `function admit() { return "owned"; } export { admit as ${alias} };`;
    const finish = 'function finish() { return "finished"; } export { finish as f };';
    const facade = 'import { f as finish } from "./finish-fixture.mjs"; export { finish };';
    const rootSource = split ? admit : `${admit}\n${finish}`;
    const files: Record<string, string> = split
      ? {
          "executor-fixture.mjs": admit,
          "finish-fixture.mjs": finish,
          "executor-finish.mjs": facade,
        }
      : { "executor-fixture.mjs": rootSource };
    const { packageRoot, tarball } = await fixture(files);
    const evidence: PackagedOwnerEvidence[] = [];
    const owner = await loadPackagedOwner(
      packageRoot,
      tarball,
      "executor",
      ["admit", "finish"],
      evidence,
    );
    expect(owner.admit?.()).toBe("owned");
    expect(owner.finish?.()).toBe("finished");
    const expected: PackagedOwnerEvidence[] = [
      {
        file: "dist/executor-fixture.mjs",
        sha256: createHash("sha256").update(rootSource).digest("hex"),
        exports: split ? { admit: alias } : { admit: alias, finish: "f" },
      },
    ];
    if (split) {
      expected.push({
        file: "dist/executor-finish.mjs",
        sha256: createHash("sha256").update(facade).digest("hex"),
        exports: { finish: "finish" },
      });
    }
    expect(evidence).toHaveLength(expected.length);
    expect(evidence).toEqual(expect.arrayContaining(expected));
  },
);

it("authenticates every selected chunk before importing any owner", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-first.mjs":
      'throw new Error("unverified code executed"); function admit() {} export { admit as a };',
    "executor-second.mjs": "function finish() {} export { finish as f };",
  });
  await fs.writeFile(
    path.join(packageRoot, "dist", "executor-second.mjs"),
    'function finish() { return "changed"; } export { finish as f };',
  );
  await expect(
    loadPackagedOwner(packageRoot, tarball, "executor", ["admit", "finish"], []),
  ).rejects.toThrow("Installed module differs from the bound package");
});

it.each(["static", "computed"])(
  "authenticates %s transitive imports before owner execution",
  async (kind) => {
    const { packageRoot, tarball } = await fixture({
      "executor-fixture.mjs":
        kind === "static"
          ? 'import { value } from "./implementation.mjs"; function admit() { return value; } export { admit };'
          : 'const module = "./implementation.mjs"; const { value } = await import(module); function admit() { return value; } export { admit };',
      "implementation.mjs": 'export const value = "original";',
    });
    await fs.writeFile(
      path.join(packageRoot, "dist", "implementation.mjs"),
      'throw new Error("unverified transitive code executed"); export const value = "changed";',
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { createPackagedOwnerLoader } = await import(process.argv[1]); const loadOwner = await createPackagedOwnerLoader(process.argv[2], process.argv[3]); await loadOwner("executor", ["admit"], []);',
        pathToFileURL(path.resolve("scripts/lib/windows-repair-package.mts")).href,
        packageRoot,
        tarball,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Installed module differs from the bound package");
  },
);

it.each(["added", "missing", "pending lifecycle"])(
  "refuses %s installed files before loading an owner",
  async (kind) => {
    const { packageRoot, tarball } = await fixture({
      "executor-fixture.mjs": "function admit() {} export { admit };",
      "implementation.mjs": 'export const value = "original";',
    });
    if (kind === "pending lifecycle") {
      await fs.writeFile(
        path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
        "pending\n",
      );
    } else if (kind === "added") {
      await fs.writeFile(path.join(packageRoot, "dist", "unbound.mjs"), "export {};");
    } else {
      await fs.rm(path.join(packageRoot, "dist", "implementation.mjs"));
    }
    await expect(createPackagedOwnerLoader(packageRoot, tarball)).rejects.toThrow(
      kind === "missing" ? "Missing installed package members" : "Unbound installed package member",
    );
  },
);

it("rejects a linked package directory before loading an owner", async () => {
  const { packageRoot, tarball } = await fixture({
    "executor-fixture.mjs": "function admit() {} export { admit };",
  });
  const originalDist = path.join(packageRoot, "..", "original-dist");
  await fs.rename(path.join(packageRoot, "dist"), originalDist);
  await fs.symlink(originalDist, path.join(packageRoot, "dist"), "junction");
  await expect(createPackagedOwnerLoader(packageRoot, tarball)).rejects.toThrow(
    "Unbound installed package member: dist",
  );
});

it.each(["absent", "ambiguous"])("refuses an %s packaged authority owner", async (shape) => {
  const files: Record<string, string> =
    shape === "absent"
      ? { "executor-other.mjs": "function different() {} export { different as a };" }
      : {
          "executor-first.mjs": "function admit() {} export { admit as a };",
          "executor-second.mjs": "function admit() {} export { admit as b };",
        };
  const { packageRoot, tarball } = await fixture(files);
  await expect(loadPackagedOwner(packageRoot, tarball, "executor", ["admit"], [])).rejects.toThrow(
    "Expected one packaged executor owner",
  );
});
