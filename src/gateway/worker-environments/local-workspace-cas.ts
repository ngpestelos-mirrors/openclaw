import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { deflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type {
  LocalWorkspaceManifestNode,
  LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";

/** Unlike the in-memory treap, persisted child links name immutable subtrees. */
export type LocalWorkspaceTreeNode = {
  node: LocalWorkspaceManifestNode;
  treeRef: string;
  contentRef: string;
  left: string | null;
  right: string | null;
  children: string | null;
};

export type LocalWorkspacePreparation = {
  nodes?: LocalWorkspaceTreeNode[];
  paths?: { digest: string; compressed: Uint8Array };
};

export const LOCAL_WORKSPACE_NODE_BATCH = 256;

export function localWorkspaceDigestBytes(ref: string): Uint8Array {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) {
    throw new Error("Invalid local workspace tree digest");
  }
  return Uint8Array.from(Buffer.from(ref.slice(7), "hex"));
}

export function localWorkspaceDigestReference(bytes: Uint8Array): string {
  return `sha256:${Buffer.from(bytes).toString("hex")}`;
}

export function encodeLocalWorkspaceTreeNodes(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selected: Iterable<LocalWorkspaceManifestRecord> = records.values(),
): LocalWorkspaceTreeNode[] {
  const childDigest = (child: string | null) => {
    if (child === null) {
      return null;
    }
    const record = records.get(child);
    if (!record) {
      throw new Error("Local workspace baseline nodes are missing");
    }
    return record.treeRef;
  };
  return Array.from(selected, (record) => ({
    node: record.node,
    treeRef: record.treeRef,
    contentRef: record.contentRef,
    left: childDigest(record.left),
    right: childDigest(record.right),
    children: childDigest(record.children),
  }));
}

export function prepareLocalWorkspaceTreeNodes(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selected: Iterable<LocalWorkspaceManifestRecord> = records.values(),
): Uint8Array[] {
  const nodes = encodeLocalWorkspaceTreeNodes(records, selected);
  const batches: Uint8Array[] = [];
  for (let offset = 0; offset < nodes.length; offset += LOCAL_WORKSPACE_NODE_BATCH) {
    batches.push(
      deflateRawSync(
        serialize({ nodes: nodes.slice(offset, offset + LOCAL_WORKSPACE_NODE_BATCH) }),
      ),
    );
  }
  return batches;
}

export function prepareLocalWorkspaceSourcePathSet(raw: string) {
  // Array order is part of the admitted document; equal documents share bytes.
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return { digest, compressed: zstdCompressSync(Buffer.from(raw)) };
}

export function decodeLocalWorkspaceSourcePathSet(compressed: Uint8Array): string {
  return zstdDecompressSync(compressed).toString("utf8");
}
