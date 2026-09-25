// Doctor-only import for the retired exec approvals JSON store.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import { z } from "zod";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  normalizeExecApprovalsInternal,
  parsePersistedExecApprovals,
  resolveExecApprovalsPath,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { pathMayExistSync } from "./path-existence.js";
import type { LegacyExecApprovalsDetection } from "./state-migrations.exec-approvals.types.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import { recoverLegacyMigrationReceiptCopies } from "./state-migrations.source-copy-recovery.js";
import {
  listUnboundLegacyMigrationSourceCopies,
  listLegacyMigrationSourceCopies,
} from "./state-migrations.source-copy.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
export const MAX_LEGACY_EXEC_APPROVALS_BYTES = 4 * 1024 * 1024;
const MIGRATION_KIND = "legacy-exec-approvals-json";
const TARGET_TABLE = "exec_approvals_config";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const canonicalRawHash = (raw: string | null) =>
  createHash("sha256")
    .update(raw ?? "")
    .digest("hex");

type LegacySourceSnapshot = Omit<LegacyMigrationSourceSnapshot, "raw"> & { raw: string | null };

// Only the observed policy-free stub may omit its version. Unknown fields or
// nonempty policy are not proof that a legacy file is safe to retire.
const emptyLegacyExecApprovalsSchema = z.strictObject({
  version: z.literal(1).optional(),
  defaults: z.strictObject({}),
  agents: z.strictObject({}),
  socket: z.strictObject({ path: z.string().optional(), token: z.string().optional() }).optional(),
});

type ArchivedEmptyLegacy = { file: ExecApprovalsFile; archivePath: string };

type MigrationDecision =
  | "empty-legacy-retired"
  | "canonical-preserved"
  | "invalid-canonical-repaired"
  | "legacy-imported"
  | "malformed-legacy-preserved"
  | "receipt-authoritative";

function normalizeLegacyNullableUsageMetadata(raw: string): string {
  const parsed = safeParseJsonRecord(raw);
  if (!parsed || !isRecord(parsed.agents)) {
    return raw;
  }

  let changed = false;
  for (const agent of Object.values(parsed.agents)) {
    if (!isRecord(agent) || !Array.isArray(agent.allowlist)) {
      continue;
    }
    for (const entry of agent.allowlist) {
      if (!isRecord(entry)) {
        continue;
      }
      // Legacy files can contain null usage metadata. Repair only these fields at
      // import so canonical policy validation remains strict.
      for (const key of ["lastUsedAt", "lastUsedCommand"]) {
        if (entry[key] === null) {
          delete entry[key];
          changed = true;
        }
      }
    }
  }
  return changed ? JSON.stringify(parsed) : raw;
}

/** Detect retired approvals only when an explicit Doctor flow opts in. */
export function detectLegacyExecApprovals(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyExecApprovalsDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = resolveExecApprovalsPath(env);
  const sourcePresent =
    legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX) ||
    listLegacyMigrationSourceCopies(sourcePath).length > 0 ||
    listUnboundLegacyMigrationSourceCopies(path.dirname(sourcePath)).length > 0;
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourcePresent,
  };
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
    label: "exec approvals",
  });
  let raw: string | null = null;
  try {
    raw = utf8Decoder.decode(snapshot.buffer);
  } catch {
    // Invalid UTF-8 is malformed input that must stay available for recovery.
  }
  return { ...snapshot, raw };
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  emptyStub?: ArchivedEmptyLegacy;
}): { message: string; removeSource: boolean; sourceKey: string } {
  const sourceKey = resolveLegacyMigrationSourceKey("exec-approvals-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  const legacy = params.emptyStub
    ? ok<ExecApprovalsFile, string>(params.emptyStub.file)
    : params.snapshot.raw === null
      ? err<never, string>("invalid UTF-8 encoding")
      : parsePersistedExecApprovals(normalizeLegacyNullableUsageMetadata(params.snapshot.raw));
  const legacyFile = legacy.ok ? legacy.value : null;

  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const canonical = readExecApprovalsConfigRow(db);
      const canonicalFile = canonical ? tryParsePersistedExecApprovals(canonical.raw_json) : null;
      const importedRaw = legacyFile ? serializeExecApprovals(legacyFile) : null;
      const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      let receiptImportedSameSource = false;
      if (receipt?.sourceSha256 === params.snapshot.sha256) {
        try {
          const report: unknown = JSON.parse(receipt.reportJson);
          receiptImportedSameSource =
            isRecord(report) &&
            (report.decision === "legacy-imported" ||
              report.decision === "invalid-canonical-repaired" ||
              report.decision === "receipt-authoritative");
        } catch {
          // A malformed receipt is not authority to discard security state.
        }
      }
      let decision: MigrationDecision;
      let removeSource = false;
      // A running exec host retains its socket credential. Import it when SQLite
      // is absent; a policy-free stub must never replace an existing canonical row.
      if (
        params.emptyStub &&
        (canonical || (!legacyFile?.socket?.path && !legacyFile?.socket?.token))
      ) {
        decision = "empty-legacy-retired";
        removeSource = true;
      } else if (!legacyFile || params.snapshot.raw === null) {
        decision = "malformed-legacy-preserved";
      } else if (receiptImportedSameSource && canonicalFile) {
        decision = "receipt-authoritative";
        removeSource = true;
      } else if (!canonical) {
        writeExecApprovalsConfigRow({
          db,
          file: legacyFile,
          raw: importedRaw ?? undefined,
          now,
        });
        decision = "legacy-imported";
        removeSource = true;
      } else if (!canonicalFile) {
        writeExecApprovalsConfigRow({
          db,
          file: legacyFile,
          raw: importedRaw ?? undefined,
          now,
        });
        decision = "invalid-canonical-repaired";
        removeSource = true;
      } else {
        decision = "canonical-preserved";
        removeSource = canonical.raw_json === params.snapshot.raw;
      }

      if (decision === "legacy-imported" || decision === "invalid-canonical-repaired") {
        if (!legacyFile) {
          throw new Error("exec approvals import decisions require a parsed legacy file");
        }
        const verified = readExecApprovalsConfigRow(db);
        const verifiedFile = verified ? tryParsePersistedExecApprovals(verified.raw_json) : null;
        const rawMatches = verified?.raw_json === importedRaw;
        const fileMatches =
          verifiedFile &&
          isDeepStrictEqual(
            JSON.parse(serializeExecApprovals(verifiedFile)),
            JSON.parse(serializeExecApprovals(legacyFile)),
          );
        if (!rawMatches || !fileMatches) {
          throw new Error(
            `SQLite verification failed for the exec approvals migration (raw=${rawMatches}, parsed=${Boolean(fileMatches)})`,
          );
        }
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: TARGET_TABLE,
        decision,
        sourceSha256: params.snapshot.sha256,
        sourceValid: legacyFile !== null,
        ...(params.emptyStub ? { archivePath: params.emptyStub.archivePath } : {}),
        importedRecordCount:
          decision === "legacy-imported" || decision === "invalid-canonical-repaired" ? 1 : 0,
        preservedSqliteRecordCount:
          canonical &&
          decision !== "legacy-imported" &&
          decision !== "invalid-canonical-repaired" &&
          decision !== "malformed-legacy-preserved"
            ? 1
            : 0,
        removesSource: removeSource,
        ...(removeSource
          ? {
              canonicalRawSha256: canonicalRawHash(
                readExecApprovalsConfigRow(db)?.raw_json ?? null,
              ),
              canonicalPresent: Boolean(readExecApprovalsConfigRow(db)),
            }
          : {}),
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: TARGET_TABLE,
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: legacyFile && decision !== "empty-legacy-retired" ? 1 : 0,
        runId,
        now,
        reportJson,
        upsert: true,
      });
      const message = removeSource
        ? decisionMessages[decision]
        : legacy.ok
          ? "Conflicting legacy exec approvals remain"
          : `Invalid legacy exec approvals (${legacy.error})`;
      return { message, removeSource, sourceKey };
    },
    { env: params.env },
    { operationLabel: "state-migration.exec-approvals" },
  );
}

const decisionMessages: Record<MigrationDecision, string> = {
  "empty-legacy-retired": "Archived empty legacy exec approvals without changing SQLite policy.",
  "legacy-imported": "Imported legacy exec approvals into shared SQLite state.",
  "invalid-canonical-repaired":
    "Replaced an invalid SQLite exec approvals row with validated legacy state.",
  "canonical-preserved": "Preserved byte-identical canonical SQLite exec approvals.",
  "malformed-legacy-preserved": "Preserved malformed legacy exec approvals for operator recovery.",
  "receipt-authoritative": "Completed cleanup for previously imported legacy exec approvals.",
};

async function migrateWithExclusiveStateOwnership(params: {
  detected: LegacyExecApprovalsDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const sourcePath = params.detected.sourcePath;
  const copies = listLegacyMigrationSourceCopies(sourcePath);
  if (copies.length > 0) {
    const receipt = readLegacyMigrationReceipt(
      resolveLegacyMigrationSourceKey("exec-approvals-json", sourcePath),
      params.env,
    );
    const recovery = await recoverLegacyMigrationReceiptCopies({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
      claimPath: sourcePath + DOCTOR_CLAIM_SUFFIX,
      env: params.env,
      receipt,
      label: "exec approvals",
      maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
      verifyCanonical: (current) => {
        const report: unknown = JSON.parse(current.reportJson);
        if (
          !isRecord(report) ||
          report.source !== MIGRATION_KIND ||
          report.removesSource !== true ||
          ![
            "empty-legacy-retired",
            "legacy-imported",
            "invalid-canonical-repaired",
            "receipt-authoritative",
            "canonical-preserved",
          ].includes(String(report.decision)) ||
          typeof report.canonicalRawSha256 !== "string" ||
          typeof report.canonicalPresent !== "boolean"
        ) {
          throw new Error("exec approvals receipt does not authorize source retirement");
        }
        const canonical = readExecApprovalsConfigRow(
          openOpenClawStateDatabase({ env: params.env }).db,
        );
        const validCanonical = canonical && tryParsePersistedExecApprovals(canonical.raw_json);
        if (
          (!canonical && (report.canonicalPresent || report.decision !== "empty-legacy-retired")) ||
          (canonical &&
            !validCanonical &&
            (!report.canonicalPresent ||
              canonicalRawHash(canonical.raw_json) !== report.canonicalRawSha256))
        ) {
          throw new Error("canonical exec approvals no longer match the recorded decision");
        }
        if (report.decision === "empty-legacy-retired") {
          const archive = report.archivePath;
          if (
            typeof archive !== "string" ||
            !archive.startsWith(sourcePath + ".migrated." + current.sourceSha256 + ".") ||
            !/^[0-9a-f-]{36}$/u.test(
              archive.slice((sourcePath + ".migrated." + current.sourceSha256 + ".").length),
            ) ||
            createHash("sha256")
              .update(
                readRegularFileSync({
                  filePath: archive,
                  maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
                }).buffer,
              )
              .digest("hex") !== current.sourceSha256
          ) {
            throw new Error("archived empty exec approvals no longer match their receipt");
          }
        }
      },
    });
    if (recovery.removed > 0 && recovery.warnings.length === 0 && receipt) {
      markLegacyMigrationSourceRemoved(receipt.sourceKey, params.env);
    }
    if (
      recovery.warnings.length > 0 ||
      !legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX)
    ) {
      return {
        changes: recovery.removed
          ? ["Removed interrupted private exec approvals copy covered by its SQLite receipt."]
          : [],
        warnings: recovery.warnings,
      };
    }
  }
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "exec approvals",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  try {
    await source.recover("legacy exec approvals source and interrupted claim both exist");
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed recovering a legacy exec approvals Doctor claim: ${String(error)}`],
    };
  }
  if (!(await source.exists())) {
    return { changes: [], warnings: [] };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await source.read();
  } catch (error) {
    return { changes: [], warnings: [`Failed reading legacy exec approvals: ${String(error)}`] };
  }

  try {
    params.beforeVerify?.();
    const current = await source.read();
    if (!snapshotsMatch(current, snapshot)) {
      throw new Error("legacy exec approvals changed after migration loaded them");
    }
    await source.claim({
      snapshot,
      mismatchMessage: "legacy exec approvals changed before migration could claim them",
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed claiming legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let result: ReturnType<typeof decideAndRecordMigration>;
  let emptyStub: ArchivedEmptyLegacy | undefined;
  try {
    const parsedStub = emptyLegacyExecApprovalsSchema.safeParse(
      snapshot.raw === null ? null : safeParseJsonRecord(snapshot.raw),
    );
    if (parsedStub.success) {
      const archiveSuffix = `.migrated.${snapshot.sha256}.${randomUUID()}`;
      const archivePath = `${sourcePath}${archiveSuffix}`;
      // Keep exact bytes before retirement; a fresh no-clobber backup lets retries
      // recover even when an earlier archive write was interrupted.
      await params.stateRoot.create(
        `${source.sourceRelativePath}${archiveSuffix}`,
        snapshot.buffer,
        { mode: 0o600 },
      );
      const archived = await readLegacySourceSnapshot(
        params.stateRoot,
        params.stateDir,
        archivePath,
      );
      if (archived.sha256 !== snapshot.sha256) {
        throw new Error("legacy exec approvals archive differs from the claimed source");
      }
      emptyStub = {
        archivePath,
        file: normalizeExecApprovalsInternal({ ...parsedStub.data, version: 1 }),
      };
    }
    result = decideAndRecordMigration({
      env: params.env,
      sourcePath,
      snapshot,
      emptyStub,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  if (!result.removeSource) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `${result.message}${restoreError ? ` Claim restore failed: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: "legacy exec approvals reappeared during migration cleanup",
      remainingMessage: "legacy exec approvals remain after migration cleanup",
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Legacy exec approvals cleanup failed: ${String(error)}`],
    };
  }

  const warnings: string[] = [];
  try {
    markLegacyMigrationSourceRemoved(
      result.sourceKey,
      params.env,
      "state-migration.exec-approvals.receipt",
    );
  } catch (error) {
    warnings.push(
      `Legacy exec approvals were removed, but their receipt could not be finalized: ${String(error)}`,
    );
  }
  return {
    changes: [result.message],
    warnings,
    notices: [
      ...(emptyStub ? [`Archived empty legacy exec approvals at ${emptyStub.archivePath}.`] : []),
      "Removed retired exec approvals JSON after recording its migration decision.",
    ],
  };
}

/** Import or retire the old file under exclusive state ownership. */
export async function migrateLegacyExecApprovals(params: {
  detected?: LegacyExecApprovalsDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const result = await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy exec approvals",
    releaseLabel: "Exec approvals",
    errorLabel: "Failed reading legacy exec approvals",
    retryGuidance: `Stop the Gateway and node hosts holding ${params.stateDir}.`,
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        symlinks: "reject",
      });
      const unboundWarnings = listUnboundLegacyMigrationSourceCopies(
        path.dirname(detected.sourcePath),
      ).map(
        (directory) =>
          "Preserved unbound exec approvals private copy " +
          directory +
          ". Inspect it and rerun Doctor.",
      );
      const migration = await migrateWithExclusiveStateOwnership({
        ...params,
        detected,
        env,
        stateRoot,
      });
      return { ...migration, warnings: [...unboundWarnings, ...migration.warnings] };
    },
  });
  if (result.changes.length > 0) {
    return result;
  }
  const retainedPaths = [
    detected.sourcePath,
    `${detected.sourcePath}${DOCTOR_CLAIM_SUFFIX}`,
  ].filter(pathMayExistSync);
  return {
    ...result,
    warnings: result.warnings.map(
      (problem) =>
        new ExecApprovalsMigrationRequiredError(
          retainedPaths.join(", ") || detected.sourcePath,
          "doctor",
          problem,
        ).message,
    ),
  };
}
