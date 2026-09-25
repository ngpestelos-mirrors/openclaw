// Shared receipt-validated cleanup for private Doctor source copies.
import fs from "node:fs";
import type { Root } from "@openclaw/fs-safe";
import {
  readLegacyMigrationReceipt,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  cleanupLegacyMigrationSourceCopy,
  listLegacyMigrationSourceCopies,
} from "./state-migrations.source-copy.js";
import { resolveLegacyMigrationRelativePath } from "./state-migrations.source-snapshot.js";

export async function recoverLegacyMigrationReceiptCopies(
  params: {
    stateRoot: Root;
    stateDir: string;
    sourcePath: string;
    claimPath: string;
    env: NodeJS.ProcessEnv;
    receipt: LegacyMigrationReceipt | null;
    label: string;
    verifyCanonical: (receipt: LegacyMigrationReceipt) => void;
  } & ({ maxBytes: number } | { streamed: true }),
): Promise<{ removed: number; warnings: string[] }> {
  const copies = listLegacyMigrationSourceCopies(params.sourcePath);
  const warnings: string[] = [];
  let removed = 0;
  // A pre-import interruption still has its original/claim. Let that owner
  // finish its ordinary migration before trying receipt-only copy cleanup.
  if (
    fs.lstatSync(params.sourcePath, { throwIfNoEntry: false }) ||
    fs.lstatSync(params.claimPath, { throwIfNoEntry: false })
  ) {
    return { removed, warnings };
  }
  for (const directory of copies) {
    try {
      const receipt = params.receipt;
      if (
        !receipt?.sourceSha256 ||
        fs.lstatSync(params.sourcePath, { throwIfNoEntry: false }) ||
        fs.lstatSync(params.claimPath, { throwIfNoEntry: false })
      ) {
        throw new Error("receipt is absent or source/claim still exists");
      }
      const verify = (sha256: string) => {
        const current = readLegacyMigrationReceipt(receipt.sourceKey, params.env);
        if (
          !current ||
          current.reportJson !== receipt.reportJson ||
          current.sourceSha256 !== receipt.sourceSha256 ||
          sha256 !== receipt.sourceSha256 ||
          fs.lstatSync(params.sourcePath, { throwIfNoEntry: false }) ||
          fs.lstatSync(params.claimPath, { throwIfNoEntry: false })
        ) {
          throw new Error("copy differs from receipt or source reappeared");
        }
        params.verifyCanonical(current);
      };
      const common = {
        stateRoot: params.stateRoot,
        directory: resolveLegacyMigrationRelativePath(params.stateDir, directory, params.label),
      };
      let removedPayload: boolean;
      if ("streamed" in params) {
        if (receipt.sourceSizeBytes === null || !Number.isSafeInteger(receipt.sourceSizeBytes)) {
          throw new Error("streamed copy receipt has no valid source size");
        }
        removedPayload = await cleanupLegacyMigrationSourceCopy({
          ...common,
          expectedSizeBytes: receipt.sourceSizeBytes,
          verifyDigest: verify,
        });
      } else {
        removedPayload = await cleanupLegacyMigrationSourceCopy({
          ...common,
          maxBytes: params.maxBytes,
          verify: (_buffer, sha256) => verify(sha256),
        });
      }
      if (removedPayload) {
        removed++;
      }
    } catch (error) {
      warnings.push(
        `${params.label} private copy ${directory} was preserved: ${String(error)}. Inspect it and rerun Doctor.`,
      );
    }
  }
  return { removed, warnings };
}
