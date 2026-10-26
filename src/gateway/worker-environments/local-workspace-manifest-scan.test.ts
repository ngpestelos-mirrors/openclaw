import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deserialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  localWorkspaceDigestBytes,
  type LocalWorkspacePreparation,
} from "./local-workspace-cas.js";
import { executeLocalWorkspaceManifestRead } from "./local-workspace-manifest-scan.js";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
} from "./local-workspace-manifest-tree.js";
import type { LocalWorkspaceMutation } from "./local-workspace-store.types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function repairFixture() {
  const root = await fs.realpath(dirs.make("workspace-baseline-repair-"));
  const projection = path.join(root, "projection");
  const canonical = path.join(root, "canonical");
  for (const directory of [projection, canonical]) {
    await fs.mkdir(path.join(directory, "nested"), { recursive: true });
    await fs.writeFile(path.join(directory, "nested/file.txt"), "baseline");
  }
  await requireGit(canonical, ["init", "--quiet"]);
  await requireGit(canonical, ["add", "nested/file.txt"]);
  const records = createLocalWorkspaceManifestTree([
    { path: "nested", type: "directory" },
    { path: "nested/file.txt", type: "file", mode: 0o644, size: 8, sha256: hash("baseline") },
  ]);
  const treeRoot = localWorkspaceDigestBytes(records.get("")!.treeRef);
  const snapshot = {
    row: {
      revision: 7,
      projection_path: projection,
      base_commit: "a".repeat(40),
      source_paths_json: '["nested/file.txt"]',
      baseline_json: null,
      baseline_ref: localWorkspaceManifestRootReference(records, "a".repeat(40)),
      tree_root_digest: treeRoot,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
      pending_ref: "refs/openclaw/results/preserved",
    },
    records: new Map(),
  };
  return { projection, canonical, snapshot, treeRoot };
}

it.each(["projection", "canonical"] as const)(
  "reconstructs a collected baseline only when the %s filesystem has the exact saved tree digest",
  async (matching) => {
    const { projection, canonical, snapshot, treeRoot } = await repairFixture();
    const divergent = matching === "projection" ? canonical : projection;
    await fs.writeFile(path.join(divergent, "nested/file.txt"), "preserved live edit");
    const result = await executeLocalWorkspaceManifestRead(snapshot, {
      kind: "repair",
      canonicalRoot: canonical,
    });
    expect(result.kind).toBe("replace");
    if (result.kind !== "replace") {
      throw new Error("Missing prepared repair");
    }
    const mutation = deserialize(inflateRawSync(result.update.mutation)) as LocalWorkspaceMutation;
    expect(mutation).toEqual({
      kind: "update",
      revision: 7,
      patch: {
        tree_root_digest: treeRoot,
        canonical_fingerprints: null,
        projection_fingerprints: null,
      },
    });
    const nodes = result.update.preparations!.flatMap((batch) => {
      const preparation = deserialize(inflateRawSync(batch)) as LocalWorkspacePreparation;
      return preparation.nodes!;
    });
    expect(nodes.find(({ node }) => node.path === "nested/file.txt")!.node).toMatchObject({
      sha256: hash("baseline"),
      size: 8,
    });
    expect(nodes.find(({ node }) => node.path === "")!.treeRef).toBe(
      `sha256:${Buffer.from(treeRoot).toString("hex")}`,
    );
    expect(await fs.readFile(path.join(divergent, "nested/file.txt"), "utf8")).toBe(
      "preserved live edit",
    );
  },
);

it("preserves divergent filesystems when neither can reconstruct the exact missing baseline", async () => {
  const { projection, canonical, snapshot } = await repairFixture();
  await fs.writeFile(path.join(projection, "nested/file.txt"), "guest edit");
  await fs.writeFile(path.join(canonical, "nested/file.txt"), "host edit");
  await expect(
    executeLocalWorkspaceManifestRead(snapshot, {
      kind: "repair",
      canonicalRoot: canonical,
    }),
  ).rejects.toThrow("neither workspace matches the saved baseline");
  expect(await fs.readFile(path.join(projection, "nested/file.txt"), "utf8")).toBe("guest edit");
  expect(await fs.readFile(path.join(canonical, "nested/file.txt"), "utf8")).toBe("host edit");
});
