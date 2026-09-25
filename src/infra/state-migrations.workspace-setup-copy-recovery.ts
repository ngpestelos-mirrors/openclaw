// Receipt-bound recovery of interrupted private workspace source copies.
import fs from "node:fs";
import path from "node:path";
import type { Root } from "@openclaw/fs-safe";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES } from "../agents/workspace-legacy-state.js";
import { formatErrorMessage } from "./errors.js";
import {
  cleanupLegacyMigrationSourceCopy,
  listLegacyMigrationSourceCopies,
} from "./state-migrations.source-copy.js";
import type { LegacyMigrationSourceClaim } from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { readReceipt, type MigrationReceipt } from "./state-migrations.workspace-setup-receipts.js";
import {
  canonicalCoversParsedSource,
  parseSource,
  type SourceSnapshot,
} from "./state-migrations.workspace-setup-store.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

export async function cleanupWorkspaceReceiptCopies(params: {
  sourceRoot: Root;
  sourceClaim: LegacyMigrationSourceClaim<SourceSnapshot>;
  source: LegacyWorkspaceStateSource;
  receipt: MigrationReceipt;
  env: NodeJS.ProcessEnv;
  assertIdentity: () => void;
}): Promise<MigrationMessages> {
  const copies = listLegacyMigrationSourceCopies(params.source.sourcePath);
  for (const directory of copies) {
    try {
      const archivePath = params.receipt.archivePath;
      const relativeArchive = archivePath
        ? path.relative(params.source.rootDir, archivePath)
        : null;
      const admittedArchive = relativeArchive
        ? await params.sourceRoot.resolve(relativeArchive)
        : null;
      await cleanupLegacyMigrationSourceCopy({
        stateRoot: params.sourceRoot,
        directory: path.relative(params.source.rootDir, directory),
        maxBytes:
          params.source.kind === "setup" ? 64 * 1024 : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
        verify: (buffer, sha256) => {
          const current = readReceipt(params.source, params.env);
          if (
            !current ||
            current.reportJson !== params.receipt.reportJson ||
            current.sha256 !== params.receipt.sha256 ||
            current.archivePath !== archivePath ||
            current.sourceMtimeMs !== params.receipt.sourceMtimeMs ||
            current.canonicalFingerprint !== params.receipt.canonicalFingerprint ||
            !current.canonicalFingerprint ||
            sha256 !== current.sha256
          ) {
            throw new Error("private workspace copy differs from its migration receipt");
          }
          if (
            fs.existsSync(params.source.sourcePath) ||
            fs.existsSync(params.sourceClaim.claimPath)
          ) {
            throw new Error("workspace source or claim reappeared during copy cleanup");
          }
          if (params.source.kind === "setup") {
            if (
              !admittedArchive ||
              readRegularFileSync({
                filePath: admittedArchive,
                maxBytes: 64 * 1024,
              }).buffer.compare(buffer) !== 0
            ) {
              throw new Error("workspace setup archive differs from the retained copy");
            }
          }
          if (
            params.source.kind === "attestation" &&
            (typeof current.sourceMtimeMs !== "number" || !Number.isFinite(current.sourceMtimeMs))
          ) {
            throw new Error("workspace attestation receipt lacks its original timestamp");
          }
          const parsed = parseSource(params.source, {
            mtimeMs: current.sourceMtimeMs ?? 0,
            raw: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
          });
          if (
            !canonicalCoversParsedSource({
              source: params.source,
              parsed,
              env: params.env,
              expectedFingerprint: current.canonicalFingerprint,
            })
          ) {
            throw new Error("canonical workspace state no longer covers the retained copy");
          }
          params.assertIdentity();
        },
      });
    } catch (error) {
      return {
        changes: [],
        warnings: [
          `Preserved interrupted workspace copy ${directory}: ${formatErrorMessage(error)}. Inspect it and rerun Doctor.`,
        ],
      };
    }
  }
  return {
    changes:
      copies.length > 0
        ? ["Removed interrupted private workspace copies covered by their SQLite receipt."]
        : [],
    warnings: [],
  };
}
