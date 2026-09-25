// Doctor-only import for retired per-server MCP OAuth JSON stores.
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { mcpOAuthStoreKeyFromLegacyFileName } from "../agents/mcp-oauth-identity.js";
import { parseMcpOAuthStoreJson } from "../agents/mcp-oauth-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { pathMayExistSync } from "./path-existence.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { parseLegacyMcpOAuthStore } from "./state-migrations.mcp-oauth-format.js";
import { withRootBoundedLegacyFileLock } from "./state-migrations.mcp-oauth-lock.js";
import type { LegacyMcpOAuthDetection } from "./state-migrations.mcp-oauth.types.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  cleanupLegacyMigrationSourceCopy,
  listLegacyMigrationCopySourcePaths,
  listLegacyMigrationSourceCopies,
} from "./state-migrations.source-copy.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  removeLegacyMigrationReceiptSource,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_MCP_OAUTH_DIR = "mcp-oauth";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MIGRATION_KIND = "legacy-mcp-oauth-json";
const MAX_LEGACY_STORE_BYTES = 4 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type McpOAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "mcp_oauth_stores">;

function verifyReceiptStore(
  sourcePath: string,
  receipt: LegacyMigrationReceipt,
  env: NodeJS.ProcessEnv,
): void {
  const current = readLegacyMigrationReceipt(receipt.sourceKey, env);
  if (
    !current ||
    current.sourceSha256 !== receipt.sourceSha256 ||
    current.reportJson !== receipt.reportJson
  ) {
    throw new Error("MCP OAuth migration receipt changed during copy cleanup");
  }
  const report: unknown = JSON.parse(receipt.reportJson);
  const storeKey = storeKeyForSource(sourcePath);
  if (
    !isRecord(report) ||
    report.source !== MIGRATION_KIND ||
    report.storeKey !== storeKey ||
    report.target !== "mcp_oauth_stores"
  ) {
    throw new Error("MCP OAuth migration receipt has no verified canonical target");
  }
  const db = openOpenClawStateDatabase({ env }).db;
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<McpOAuthMigrationDatabase>(db)
      .selectFrom("mcp_oauth_stores")
      .selectAll()
      .where("store_key", "=", storeKey),
  );
  if (!row || row.format_version !== 1) {
    throw new Error("canonical MCP OAuth store is unavailable");
  }
  // Refresh and logout legitimately change a valid canonical store. The durable
  // receipt retires the old bytes; never replay them over the current owner.
  try {
    parseMcpOAuthStoreJson(storeKey, row.store_json);
  } catch (error) {
    throw new Error("canonical MCP OAuth store is invalid", { cause: error });
  }
}

type LegacySourceSnapshot = LegacyMigrationSourceSnapshot & { store: Record<string, unknown> };

function parseLegacyMcpOAuthJson(buffer: Buffer): unknown {
  try {
    return JSON.parse(utf8Decoder.decode(buffer));
  } catch {
    throw new Error("legacy MCP OAuth store contains invalid JSON");
  }
}

function exactLegacyBaseName(name: string): string | null {
  const baseName = name.endsWith(DOCTOR_CLAIM_SUFFIX)
    ? name.slice(0, -DOCTOR_CLAIM_SUFFIX.length)
    : name;
  return mcpOAuthStoreKeyFromLegacyFileName(baseName) ? baseName : null;
}

function exactLegacyBaseNames(entries: Iterable<{ name: string }>): string[] {
  const baseNames = new Set<string>();
  for (const entry of entries) {
    const baseName = exactLegacyBaseName(entry.name);
    if (baseName) {
      baseNames.add(baseName);
    }
  }
  return Array.from(baseNames).toSorted();
}

function listLegacySourcePaths(sourceDir: string): string[] {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  return exactLegacyBaseNames(entries).map((baseName) => path.join(sourceDir, baseName));
}

async function listLegacySourcePathsFromRoot(params: {
  stateRoot: Root;
  stateDir: string;
}): Promise<string[]> {
  // Validate the legacy directory through the pinned root before creating any
  // retired-runtime lock sidecars. A symlinked directory must never escape stateDir.
  const entries = await params.stateRoot.list(LEGACY_MCP_OAUTH_DIR, {
    withFileTypes: true,
  });
  return exactLegacyBaseNames(entries).map((baseName) =>
    path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR, baseName),
  );
}

/** Detect exact retired MCP OAuth filenames only for an explicit Doctor flow. */
export function detectLegacyMcpOAuthStores(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyMcpOAuthDetection {
  const sourceDir = path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR);
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourceDir, sourcePaths: [], hasLegacy: false };
  }
  try {
    const sourcePaths = listLegacySourcePaths(sourceDir);
    return {
      sourceDir,
      sourcePaths,
      hasLegacy:
        sourcePaths.length > 0 ||
        fs.readdirSync(sourceDir).some((name) => name.startsWith(".doctor-source-copy-")),
    };
  } catch {
    return { sourceDir, sourcePaths: [], hasLegacy: pathMayExistSync(sourceDir) };
  }
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "MCP OAuth", false);
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  options: { parseStore?: boolean } = {},
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_STORE_BYTES,
    label: "MCP OAuth",
  });
  const parsed =
    options.parseStore === false
      ? {}
      : parseLegacyMcpOAuthStore(parseLegacyMcpOAuthJson(snapshot.buffer));
  return { ...snapshot, store: parsed };
}

function storeKeyForSource(sourcePath: string): string {
  const storeKey = mcpOAuthStoreKeyFromLegacyFileName(path.basename(sourcePath));
  if (!storeKey) {
    throw new Error("legacy MCP OAuth filename is invalid");
  }
  return storeKey;
}

function importAndRecordReceipt(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { sourceKey: string; imported: boolean } {
  const sourceKey = resolveLegacyMigrationSourceKey("mcp-oauth-json", params.sourcePath);
  const storeKey = storeKeyForSource(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<McpOAuthMigrationDatabase>(db);
      const existingReceipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      if (existingReceipt) {
        return { sourceKey, imported: false };
      }

      const existingStore = executeSqliteQueryTakeFirstSync(
        db,
        stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
      );
      let importedLegacyState: boolean;
      if (existingStore) {
        if (existingStore.format_version !== 1) {
          throw new Error("canonical MCP OAuth store has an unsupported format version");
        }
        const canonicalStore = parseMcpOAuthStoreJson(storeKey, existingStore.store_json);
        const canMergeLegacyState = canonicalStore.credentialState === "uninitialized";
        const legacyStore = { ...params.snapshot.store };
        if (canonicalStore.pendingAuthorizationChallenge?.resourceMetadataUrl) {
          delete legacyStore.discoveryState;
        }
        importedLegacyState =
          canMergeLegacyState &&
          Object.keys(legacyStore).some((key) => !Object.hasOwn(canonicalStore, key));
        if (importedLegacyState) {
          const mergedStore = { ...legacyStore, ...canonicalStore };
          delete mergedStore.credentialState;
          executeSqliteQuerySync(
            db,
            stateDb
              .updateTable("mcp_oauth_stores")
              .set({
                store_json: JSON.stringify(mergedStore),
                updated_at: now,
              })
              .where("store_key", "=", storeKey),
          );
        }
      } else {
        importedLegacyState = true;
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("mcp_oauth_stores").values({
            store_key: storeKey,
            format_version: 1,
            store_json: JSON.stringify(params.snapshot.store),
            updated_at: now,
          }),
        );
      }

      const verified = executeSqliteQueryTakeFirstSync(
        db,
        stateDb.selectFrom("mcp_oauth_stores").selectAll().where("store_key", "=", storeKey),
      );
      if (!verified || verified.format_version !== 1) {
        throw new Error("SQLite verification failed for an MCP OAuth store");
      }
      parseMcpOAuthStoreJson(storeKey, verified.store_json);

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "mcp_oauth_stores",
        storeKey,
        sourceSha256: params.snapshot.sha256,
        importedRecordCount: importedLegacyState ? 1 : 0,
        preservedSqliteRecordCount: existingStore ? 1 : 0,
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "mcp_oauth_stores",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: 1,
        runId,
        now,
        reportJson,
      });
      return { sourceKey, imported: importedLegacyState };
    },
    { env: params.env },
  );
}

async function cleanupReceiptAuthoritativeSources(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  receipt: LegacyMigrationReceipt;
  env: NodeJS.ProcessEnv;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<number> {
  let removed = 0;
  for (const candidate of [params.sourcePath, `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`]) {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, candidate)))) {
      continue;
    }
    await removeLegacyMigrationReceiptSource({
      ...params,
      candidate,
      label: "MCP OAuth",
      ...(listLegacyMigrationSourceCopies(params.sourcePath).length === 0
        ? { retiredClaimPath: `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}` }
        : {}),
      readSnapshot: (sourcePath) =>
        readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath, {
          parseStore: false,
        }),
    });
    removed += 1;
  }
  if (
    (!params.receipt.removedSource || removed > 0) &&
    listLegacyMigrationSourceCopies(params.sourcePath).length === 0
  ) {
    markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
  }
  return removed;
}

async function migrateOneStore(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath: params.sourcePath,
    label: "MCP OAuth",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  await source.recoverLinkedMove();
  const receipt = readLegacyMigrationReceipt(
    resolveLegacyMigrationSourceKey("mcp-oauth-json", params.sourcePath),
    params.env,
  );
  if (receipt) {
    try {
      const removed = await cleanupReceiptAuthoritativeSources({ ...params, receipt });
      if (removed > 0) {
        changes.push("Discarded recreated retired MCP OAuth JSON without importing it.");
      }
    } catch (error) {
      warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
      return { changes, warnings };
    }
    let removedPayloads = 0;
    for (const directory of listLegacyMigrationSourceCopies(params.sourcePath)) {
      try {
        if ((await source.exists()) || (await source.exists(true))) {
          throw new Error("legacy source or claim is still present");
        }
        const removedPayload = await cleanupLegacyMigrationSourceCopy({
          stateRoot: params.stateRoot,
          directory: relativeLegacyPath(params.stateDir, directory),
          maxBytes: MAX_LEGACY_STORE_BYTES,
          verify: (_buffer, sha256) => {
            if (sha256 !== receipt.sourceSha256) {
              throw new Error("private copy differs from the MCP OAuth migration receipt");
            }
            verifyReceiptStore(params.sourcePath, receipt, params.env);
            if (pathMayExistSync(params.sourcePath) || pathMayExistSync(source.claimPath)) {
              throw new Error("legacy source or claim reappeared during copy cleanup");
            }
          },
        });
        if (removedPayload) {
          removedPayloads++;
          changes.push("Removed interrupted private MCP OAuth copy covered by its SQLite receipt.");
        }
      } catch (error) {
        warnings.push(
          `Preserved interrupted MCP OAuth copy ${directory}: ${String(error)}. Inspect it and rerun Doctor.`,
        );
      }
    }
    if (warnings.length > 0) {
      return { changes, warnings };
    }
    if (removedPayloads > 0 && !receipt.removedSource) {
      markLegacyMigrationSourceRemoved(receipt.sourceKey, params.env);
    }
    return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
  }
  if (
    listLegacyMigrationSourceCopies(params.sourcePath).length > 0 &&
    !(await source.exists()) &&
    !(await source.exists(true))
  ) {
    return {
      changes,
      warnings: [
        `Preserved private MCP OAuth copies for ${path.basename(params.sourcePath)} without a matching SQLite receipt. Inspect the directory and rerun Doctor.`,
      ],
    };
  }

  const hasSource = await source.exists();
  const hasClaim = await source.exists(true);
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: [
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: source and interrupted claim both exist.`,
      ],
    };
  }
  const activePath = hasSource ? params.sourcePath : hasClaim ? source.claimPath : null;
  if (!activePath) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, activePath);
  } catch (error) {
    warnings.push(
      `Failed reading legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}`,
    );
    return { changes, warnings };
  }

  if (activePath === params.sourcePath) {
    try {
      snapshot = await source.claim({
        snapshot,
        mismatchMessage: "legacy MCP OAuth source changed before Doctor could claim it",
        beforeClaim: () => params.beforeClaim?.(params.sourcePath),
      });
    } catch (error) {
      const restoreError = await source.restore();
      warnings.push(
        `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      );
      return { changes, warnings };
    }
  }

  let result: ReturnType<typeof importAndRecordReceipt>;
  try {
    result = importAndRecordReceipt({
      env: params.env,
      sourcePath: params.sourcePath,
      snapshot,
    });
  } catch (error) {
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy MCP OAuth store ${path.basename(params.sourcePath)}: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    await source.assertSourceNotReappeared("legacy MCP OAuth source reappeared during import");
    const finalSnapshot = await source.read(true);
    if (!snapshotsMatch(snapshot, finalSnapshot)) {
      throw new Error("legacy MCP OAuth claim changed after SQLite import");
    }
    await source.remove({
      removeSource: params.removeSource,
      claimRemainingMessage: "legacy MCP OAuth Doctor claim remains after cleanup",
      skipSourceCheck: true,
    });
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(`MCP OAuth state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    result.imported
      ? `Migrated MCP OAuth store ${path.basename(params.sourcePath)} to SQLite.`
      : `Preserved canonical SQLite MCP OAuth store for ${path.basename(params.sourcePath)}.`,
  );
  notices.push("Removed retired MCP OAuth JSON after verified SQLite import.");
  return { changes, warnings, notices };
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeLegacyLock?: (sourcePath: string) => void;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  let sourcePaths: string[];
  try {
    sourcePaths = await listLegacySourcePathsFromRoot(params);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "not-found") {
      return { changes, warnings };
    }
    return { changes, warnings: [`Failed reading legacy MCP OAuth directory: ${String(error)}`] };
  }
  const copyPaths = listLegacyMigrationCopySourcePaths(
    path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR),
  ).filter(
    (sourcePath) => exactLegacyBaseName(path.basename(sourcePath)) === path.basename(sourcePath),
  );
  sourcePaths = [...new Set([...sourcePaths, ...copyPaths])].toSorted();
  const copies = (await params.stateRoot.list(LEGACY_MCP_OAUTH_DIR, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(".doctor-source-copy-"))
    .map((entry) => path.join(params.stateDir, LEGACY_MCP_OAUTH_DIR, entry.name));
  for (const directory of copies) {
    if (
      !sourcePaths.some((sourcePath) =>
        listLegacyMigrationSourceCopies(sourcePath).includes(directory),
      )
    ) {
      warnings.push(
        `Preserved unbound MCP OAuth private copy ${directory}. Inspect it and rerun Doctor.`,
      );
    }
  }
  for (const sourcePath of sourcePaths) {
    try {
      // Retired releases serialize complete refresh/login flows on this exact
      // path. Hold their lock while claiming bytes so an old CLI cannot race Doctor.
      params.beforeLegacyLock?.(sourcePath);
      const result = await withRootBoundedLegacyFileLock(
        {
          stateRoot: params.stateRoot,
          targetRelativePath: relativeLegacyPath(params.stateDir, sourcePath),
        },
        async () => await migrateOneStore({ ...params, sourcePath }),
      );
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    } catch (error) {
      const staleGuidance =
        (error as { code?: unknown }).code === "file_lock_stale"
          ? " Verify no older OpenClaw process is running, remove the retired .lock sidecar, and rerun Doctor."
          : "";
      warnings.push(
        `Failed locking legacy MCP OAuth store ${path.basename(sourcePath)}: ${String(error)}.${staleGuidance}`,
      );
    }
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}

/** Import retired MCP OAuth stores while excluding old Gateways that can recreate them. */
export async function migrateLegacyMcpOAuthStores(params: {
  detected: LegacyMcpOAuthDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeLegacyLock?: (sourcePath: string) => void;
  beforeClaim?: (sourcePath: string) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy MCP OAuth stores",
    releaseLabel: "MCP OAuth",
    errorLabel: "Failed reading legacy MCP OAuth state",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_STORE_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
    },
  });
}
