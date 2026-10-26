import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";
import { MAX_WORKSPACE_INVENTORY_ENTRIES } from "./workspace-inventory-limits.js";

const HEADER_BYTES = 45;
const FILE_BYTES = 16;
const FORMAT_VERSION = 1;

type FileFingerprint = { dev: bigint; ino: bigint; size: bigint; ctimeNs: bigint };

function fingerprint(identity: string): FileFingerprint {
  const [, dev, ino, size, , ctimeNs] = identity.split(":");
  return { dev: BigInt(dev!), ino: BigInt(ino!), size: BigInt(size!), ctimeNs: BigInt(ctimeNs!) };
}

function filePaths(records: ReadonlyMap<string, LocalWorkspaceManifestRecord>): string[] {
  return [...records.values()]
    .filter(({ node }) => node.type === "file")
    .map(({ node }) => node.path)
    .toSorted();
}

/** Fingerprints belong to this projection and root; immutable tree nodes never carry stat facts. */
export function encodeLocalWorkspaceFingerprints(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  treeRef: string,
  identities: ReadonlyMap<string, string>,
): Buffer | null {
  const paths = filePaths(records);
  const bytes = Buffer.alloc(HEADER_BYTES + paths.length * FILE_BYTES);
  bytes.writeUInt8(FORMAT_VERSION, 0);
  Buffer.from(treeRef.slice("sha256:".length), "hex").copy(bytes, 9);
  bytes.writeUInt32LE(paths.length, 41);
  let dev: bigint | undefined;
  for (let index = 0; index < paths.length; index++) {
    const identity = identities.get(paths[index]!);
    if (!identity) {
      return null;
    }
    const stat = fingerprint(identity);
    dev ??= stat.dev;
    // One header cannot describe files spanning devices. Those scans stay correct by hashing.
    if (stat.dev !== dev) {
      return null;
    }
    bytes.writeBigUInt64LE(stat.ino, HEADER_BYTES + index * FILE_BYTES);
    bytes.writeBigInt64LE(stat.ctimeNs, HEADER_BYTES + index * FILE_BYTES + 8);
  }
  bytes.writeBigUInt64LE(dev ?? 0n, 1);
  return resolveZstdCodec().compress(bytes);
}

/** An invalid blob disables the entire baseline reuse path, never a prefix of its records. */
export function localWorkspaceFingerprintReuse(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  treeRef: string,
  blob: Uint8Array | null,
) {
  const paths = filePaths(records);
  let decoded: Buffer | undefined;
  if (blob) {
    try {
      const bytes = resolveZstdCodec().decompress(
        blob,
        HEADER_BYTES + MAX_WORKSPACE_INVENTORY_ENTRIES * FILE_BYTES,
      );
      if (
        bytes.length === HEADER_BYTES + paths.length * FILE_BYTES &&
        bytes.readUInt8(0) === FORMAT_VERSION &&
        bytes.subarray(9, 41).equals(Buffer.from(treeRef.slice("sha256:".length), "hex")) &&
        bytes.readUInt32LE(41) === paths.length
      ) {
        decoded = bytes;
      }
    } catch {
      // Fingerprints are a performance hint. Corrupt or unsupported blobs must hash all files.
    }
  }
  const offsets = new Map(
    paths.map((entryPath, index) => [entryPath, HEADER_BYTES + index * FILE_BYTES]),
  );
  return (entryPath: string, identity: string) => {
    if (!decoded) {
      return undefined;
    }
    const offset = offsets.get(entryPath);
    const previous = records.get(entryPath)?.node;
    if (offset === undefined || previous?.type !== "file") {
      return undefined;
    }
    const stat = fingerprint(identity);
    return decoded.readBigUInt64LE(1) === stat.dev &&
      decoded.readBigUInt64LE(offset) === stat.ino &&
      decoded.readBigInt64LE(offset + 8) === stat.ctimeNs &&
      previous.size === Number(stat.size)
      ? previous
      : undefined;
  };
}
