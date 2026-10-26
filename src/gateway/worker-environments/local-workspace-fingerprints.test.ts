import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import {
  encodeLocalWorkspaceFingerprints,
  localWorkspaceFingerprintReuse,
} from "./local-workspace-fingerprints.js";
import {
  createLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";
import { scanActualWorkspaceManifest } from "./workspace-actual-manifest.js";
import { withWorkspaceHashMemo } from "./workspace-hash-memo.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Baseline = {
  records: Map<string, LocalWorkspaceManifestRecord>;
  treeRoot: string;
  blob: Buffer | null;
};

async function capture(root: string, baseline?: Baseline, blob = baseline?.blob) {
  const nodes: LocalWorkspaceManifestNode[] = [];
  const identities = new Map<string, string>();
  const metrics = { contentHashCount: 0, memoHitCount: 0 };
  // A new memo on every capture models the loss of all in-process stat identities on restart.
  await withWorkspaceHashMemo(
    new Map(),
    () =>
      scanActualWorkspaceManifest({
        root,
        baseCommit: null,
        ...(baseline
          ? {
              reuseFile: localWorkspaceFingerprintReuse(
                baseline.records,
                baseline.treeRoot,
                blob ?? null,
              ),
            }
          : {}),
        onEntry(node, identity) {
          nodes.push(node);
          if (identity) {
            identities.set(node.path, identity);
          }
        },
      }),
    metrics,
  );
  const records = createLocalWorkspaceManifestTree(nodes);
  const treeRoot = records.get("")!.treeRef;
  return {
    records,
    treeRoot,
    blob: encodeLocalWorkspaceFingerprints(records, treeRoot, identities),
    metrics,
  };
}

async function fixture() {
  const root = await fs.realpath(dirs.make("workspace-fingerprints-"));
  await fs.mkdir(path.join(root, "a"));
  await fs.mkdir(path.join(root, "b"));
  await fs.writeFile(path.join(root, "a/file.txt"), "AAAA");
  await fs.writeFile(path.join(root, "b/file.txt"), "BBBB");
  return { root, baseline: await capture(root) };
}

it("hashes and reports same-size files swapped by ancestor-directory renames after restart", async () => {
  // Filesystems can assign equal ctimes to separate files. Fix that metadata fact so
  // this directory-swap regression specifically requires the path-to-inode check.
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stats = await lstat(...args);
    Reflect.set(stats, "ctimeNs", 1n);
    return stats;
  });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
      const stats = await stat(...statArgs);
      Reflect.set(stats, "ctimeNs", 1n);
      return stats;
    });
    return handle;
  });
  const { root, baseline } = await fixture();
  const before = await fs.stat(path.join(root, "a/file.txt"), { bigint: true });
  await fs.rename(path.join(root, "a"), path.join(root, "temporary"));
  await fs.rename(path.join(root, "b"), path.join(root, "a"));
  await fs.rename(path.join(root, "temporary"), path.join(root, "b"));
  const after = await fs.stat(path.join(root, "b/file.txt"), { bigint: true });
  expect(after.ctimeNs).toBe(before.ctimeNs);
  const current = await capture(root, baseline);
  expect(current.metrics.contentHashCount).toBe(2);
  expect(current.treeRoot).not.toBe(baseline.treeRoot);
  expect(current.records.get("a/file.txt")!.node).toMatchObject({ sha256: hash("BBBB") });
  expect(current.records.get("b/file.txt")!.node).toMatchObject({ sha256: hash("AAAA") });
});

it("reuses unchanged file hashes after restart and hashes a same-size in-place edit", async () => {
  const { root, baseline } = await fixture();
  const unchanged = await capture(root, baseline);
  expect(unchanged.metrics.contentHashCount).toBe(0);
  expect(unchanged.treeRoot).toBe(baseline.treeRoot);
  await fs.writeFile(path.join(root, "a/file.txt"), "CCCC");
  const modified = await capture(root, baseline);
  expect(modified.metrics.contentHashCount).toBe(1);
  expect(modified.records.get("a/file.txt")!.node).toMatchObject({ sha256: hash("CCCC") });
  expect(modified.treeRoot).not.toBe(baseline.treeRoot);
});

it("ignores an older valid blob entirely after the baseline root changes", async () => {
  const { root, baseline } = await fixture();
  await fs.writeFile(path.join(root, "a/file.txt"), "CCCC");
  const current = await capture(root);
  expect(current.treeRoot).not.toBe(baseline.treeRoot);
  const restarted = await capture(root, current, baseline.blob);
  expect(restarted.metrics.contentHashCount).toBe(2);
  expect(restarted.treeRoot).toBe(current.treeRoot);
});

it.each(["wrong count", "truncated", "unsupported version", "different device"] as const)(
  "hashes every file when a fingerprint blob has a %s",
  async (defect) => {
    const { root, baseline } = await fixture();
    expect(baseline.blob).not.toBeNull();
    const codec = resolveZstdCodec();
    let bytes = codec.decompress(baseline.blob!);
    if (defect === "wrong count") {
      bytes.writeUInt32LE(1, 41);
    }
    if (defect === "truncated") {
      bytes = bytes.subarray(0, -1);
    }
    if (defect === "unsupported version") {
      bytes[0] = 2;
    }
    if (defect === "different device") {
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(1) + 1n, 1);
    }
    const current = await capture(root, baseline, codec.compress(bytes));
    expect(current.metrics.contentHashCount).toBe(2);
    expect(current.treeRoot).toBe(baseline.treeRoot);
  },
);

it("hashes every file for undecodable fingerprints", async () => {
  const { root, baseline } = await fixture();
  const current = await capture(root, baseline, Buffer.from("invalid zstd"));
  expect(current.metrics.contentHashCount).toBe(2);
  expect(current.treeRoot).toBe(baseline.treeRoot);
});
