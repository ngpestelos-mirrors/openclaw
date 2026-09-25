import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root, type Root } from "@openclaw/fs-safe";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { ensureWebPushSubscriptionBindingColumns } from "./push-web-store.kernel.js";
import {
  webPushSubscriptionFromRow,
  webPushSubscriptionToRow,
  webPushSubscriptionsEqual,
  WEB_PUSH_VAPID_STATE_KEY,
  type VapidKeyPair,
  type WebPushDatabase,
  type WebPushSubscription,
} from "./push-web-store.records.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  hasPendingLegacyMigrationSourceRemoval,
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  cleanupLegacyMigrationSourceCopy,
  listLegacyMigrationSourceCopies,
  listUnboundLegacyMigrationSourceCopies,
} from "./state-migrations.source-copy.js";
import {
  claimLegacyMigrationSourceClaims,
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist as sourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as sourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  restoreLegacyMigrationSourceClaims,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";
import {
  parseLegacySubscriptions,
  parseLegacyVapidKeys,
} from "./state-migrations.web-push-parse.js";

const LEGACY_SUBSCRIPTIONS_MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_VAPID_KEYS_MAX_BYTES = 64 * 1024;
const MIGRATION_KIND = "legacy-web-push-json";

type ParsedLegacyState = {
  subscriptions: Map<string, WebPushSubscription>;
  vapidKeys: VapidKeyPair | null;
  sources: { claim: LegacyMigrationSourceClaim; snapshot: LegacySourceSnapshot }[];
};

function resolveLegacyWebPushPaths(stateDir: string) {
  return {
    subscriptionsPath: path.join(stateDir, "push", "web-push-subscriptions.json"),
    vapidKeysPath: path.join(stateDir, "push", "vapid-keys.json"),
  };
}

export function detectLegacyWebPush(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["webPush"] {
  const paths = resolveLegacyWebPushPaths(params.stateDir);
  return {
    ...paths,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (sourceOrClaimMayExist(paths.subscriptionsPath) ||
        sourceOrClaimMayExist(paths.vapidKeysPath) ||
        listLegacyMigrationSourceCopies(paths.subscriptionsPath).length > 0 ||
        listLegacyMigrationSourceCopies(paths.vapidKeysPath).length > 0 ||
        listUnboundLegacyMigrationSourceCopies(path.dirname(paths.subscriptionsPath)).length > 0 ||
        hasPendingLegacyMigrationSourceRemoval(
          [sourceKey(paths.subscriptionsPath), sourceKey(paths.vapidKeysPath)],
          { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
        )),
  };
}

function sourceKey(sourcePath: string): string {
  return resolveLegacyMigrationSourceKey(MIGRATION_KIND, sourcePath);
}

function sourceFingerprint(
  db: DatabaseSync,
  sourcePath: string,
  buffer: Buffer,
  env: NodeJS.ProcessEnv,
): string {
  const kysely = getNodeSqliteKysely<WebPushDatabase>(db);
  let canonical: unknown;
  if (path.basename(sourcePath) === "vapid-keys.json") {
    // Parse the payload as the importer does before comparing the canonical key pair.
    parseLegacyVapidKeys(buffer.toString("utf8"), env);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", WEB_PUSH_VAPID_STATE_KEY),
    );
    if (!row) {
      throw new Error("canonical Web Push VAPID identity is missing");
    }
    canonical = JSON.parse(row.value_json) as unknown;
  } else {
    const subscriptions = parseLegacySubscriptions(buffer.toString("utf8"));
    canonical = [...subscriptions.keys()].toSorted().map((endpointHash) => {
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("web_push_subscriptions")
          .selectAll()
          .where("endpoint_hash", "=", endpointHash),
      );
      if (!row) {
        throw new Error("canonical Web Push subscription is missing");
      }
      return [endpointHash, webPushSubscriptionFromRow(row)];
    });
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function assertReceiptCanonical(params: {
  sourcePath: string;
  buffer: Buffer;
  sha256: string;
  receipt: LegacyMigrationReceipt;
  env: NodeJS.ProcessEnv;
}): void {
  const current = readLegacyMigrationReceipt(sourceKey(params.sourcePath), params.env);
  const report: unknown = JSON.parse(params.receipt.reportJson);
  if (
    !current ||
    !isRecord(report) ||
    current.reportJson !== params.receipt.reportJson ||
    current.sourceSha256 !== params.sha256 ||
    typeof report.canonicalFingerprint !== "string"
  ) {
    throw new Error("private Web Push copy differs from its migration receipt");
  }
  const db = openOpenClawStateDatabase({ env: params.env }).db;
  if (
    sourceFingerprint(db, params.sourcePath, params.buffer, params.env) !==
    report.canonicalFingerprint
  ) {
    throw new Error("canonical Web Push state changed after import");
  }
}

function createLegacySourceClaim(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  maxBytes: number,
): LegacyMigrationSourceClaim {
  return new LegacyMigrationSourceClaim({
    stateRoot,
    stateDir,
    sourcePath,
    label: "Web Push",
    readSnapshot: (snapshotPath) =>
      readLegacyMigrationSourceSnapshot({
        stateRoot,
        stateDir,
        sourcePath: snapshotPath,
        maxBytes,
        label: "Web Push",
        hashDecodedText: true,
      }),
  });
}

async function readLegacyState(
  stateRoot: Root,
  stateDir: string,
  detected: LegacyStateDetection["webPush"],
  env: NodeJS.ProcessEnv,
): Promise<ParsedLegacyState> {
  const subscriptionsSource = createLegacySourceClaim(
    stateRoot,
    stateDir,
    detected.subscriptionsPath,
    LEGACY_SUBSCRIPTIONS_MAX_BYTES,
  );
  const vapidSource = createLegacySourceClaim(
    stateRoot,
    stateDir,
    detected.vapidKeysPath,
    LEGACY_VAPID_KEYS_MAX_BYTES,
  );
  await subscriptionsSource.recover("interrupted Web Push doctor claim conflicts with its source");
  await vapidSource.recover("interrupted Web Push doctor claim conflicts with its source");
  const sources: ParsedLegacyState["sources"] = [];
  let subscriptions = new Map<string, WebPushSubscription>();
  let vapidKeys: VapidKeyPair | null = null;
  if (await subscriptionsSource.exists()) {
    const snapshot = await subscriptionsSource.read();
    subscriptions = parseLegacySubscriptions(snapshot.raw);
    sources.push({ claim: subscriptionsSource, snapshot });
  }
  if (await vapidSource.exists()) {
    const snapshot = await vapidSource.read();
    vapidKeys = parseLegacyVapidKeys(snapshot.raw, env);
    sources.push({ claim: vapidSource, snapshot });
  }
  return { subscriptions, vapidKeys, sources };
}

async function assertSourcesUnchanged(sources: ParsedLegacyState["sources"]): Promise<void> {
  for (const { claim, snapshot } of sources) {
    if (!sourceSnapshotsMatch(await claim.read(), snapshot)) {
      throw new Error("legacy Web Push source changed after doctor loaded it");
    }
  }
}

function mergedSubscription(params: {
  existing: WebPushSubscription;
  legacy: WebPushSubscription;
}): WebPushSubscription {
  const { existing, legacy } = params;
  const createdAtMs = Math.min(existing.createdAtMs, legacy.createdAtMs);
  if (existing.updatedAtMs === legacy.updatedAtMs) {
    const normalizedExisting = { ...existing, createdAtMs };
    const normalizedLegacy = { ...legacy, createdAtMs };
    if (!webPushSubscriptionsEqual(normalizedExisting, normalizedLegacy)) {
      throw new Error("Web Push subscription diverges at the same timestamp");
    }
    return normalizedExisting;
  }
  const winner = existing.updatedAtMs > legacy.updatedAtMs ? existing : legacy;
  return { ...winner, createdAtMs };
}

function findSubscriptionById(db: DatabaseSync, subscriptionId: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("subscription_id", "=", subscriptionId),
  );
}

function writeSubscription(
  db: DatabaseSync,
  endpointHash: string,
  subscription: WebPushSubscription,
): void {
  const row = webPushSubscriptionToRow({ endpointHash, subscription });
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .insertInto("web_push_subscriptions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("endpoint_hash").doUpdateSet({
          subscription_id: row.subscription_id,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          created_at_ms: row.created_at_ms,
          updated_at_ms: row.updated_at_ms,
        }),
      ),
  );
}

function migrateIntoDatabase(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  legacy: ParsedLegacyState;
  nowMs: number;
}): { importedSubscriptions: number; importedVapidKeys: boolean } {
  let importedSubscriptions = 0;
  let importedVapidKeys = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureWebPushSubscriptionBindingColumns(db);
      const webPushDb = getNodeSqliteKysely<WebPushDatabase>(db);
      const expectedSubscriptions = new Map<string, WebPushSubscription>();
      for (const [endpointHash, legacySubscription] of params.legacy.subscriptions) {
        const existingRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (existingRow && existingRow.endpoint !== legacySubscription.endpoint) {
          throw new Error("Web Push endpoint hash collision during legacy import");
        }
        const existing = existingRow ? webPushSubscriptionFromRow(existingRow) : null;
        const expected = existing
          ? mergedSubscription({ existing, legacy: legacySubscription })
          : legacySubscription;
        const conflictingIdRow = findSubscriptionById(db, expected.subscriptionId);
        if (conflictingIdRow && conflictingIdRow.endpoint_hash !== endpointHash) {
          throw new Error("Web Push subscription id conflicts with another endpoint");
        }
        if (!existing || !webPushSubscriptionsEqual(existing, expected)) {
          writeSubscription(db, endpointHash, expected);
          importedSubscriptions += 1;
        }
        expectedSubscriptions.set(endpointHash, expected);
      }

      let expectedVapidKeys: VapidKeyPair | null = null;
      if (params.legacy.vapidKeys) {
        const existingVapidRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("config_machine_state")
            .select("value_json")
            .where("state_key", "=", WEB_PUSH_VAPID_STATE_KEY),
        );
        if (existingVapidRow) {
          // SAFETY: The Web Push owner stores only VapidKeyPair objects under this key.
          const existingVapidKeys = JSON.parse(existingVapidRow.value_json) as VapidKeyPair;
          if (
            existingVapidKeys.publicKey !== params.legacy.vapidKeys.publicKey ||
            existingVapidKeys.privateKey !== params.legacy.vapidKeys.privateKey
          ) {
            throw new Error("legacy Web Push VAPID identity conflicts with SQLite");
          }
          expectedVapidKeys = existingVapidKeys;
        } else {
          executeSqliteQuerySync(
            db,
            webPushDb.insertInto("config_machine_state").values({
              state_key: WEB_PUSH_VAPID_STATE_KEY,
              value_json: JSON.stringify(params.legacy.vapidKeys),
              updated_at_ms: params.nowMs,
            }),
          );
          expectedVapidKeys = params.legacy.vapidKeys;
          importedVapidKeys = true;
        }
      }

      for (const [endpointHash, expected] of expectedSubscriptions) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (!row || !webPushSubscriptionsEqual(webPushSubscriptionFromRow(row), expected)) {
          throw new Error("SQLite verification failed for a Web Push subscription");
        }
      }
      if (expectedVapidKeys) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("config_machine_state")
            .select("value_json")
            .where("state_key", "=", WEB_PUSH_VAPID_STATE_KEY),
        );
        // SAFETY: This transaction writes or validates this key as a VapidKeyPair above.
        const persisted = row ? (JSON.parse(row.value_json) as VapidKeyPair) : undefined;
        if (
          !persisted ||
          persisted.publicKey !== expectedVapidKeys.publicKey ||
          persisted.privateKey !== expectedVapidKeys.privateKey ||
          persisted.subject !== expectedVapidKeys.subject
        ) {
          throw new Error("SQLite verification failed for the Web Push VAPID identity");
        }
      }
      for (const { claim, snapshot } of params.legacy.sources) {
        const key = sourceKey(claim.sourcePath);
        const previousReceipt = readLegacyMigrationReceiptFromDatabase(db, key);
        if (previousReceipt && !previousReceipt.removedSource) {
          throw new Error(
            "Web Push source already has an import receipt; preserve it for Doctor recovery",
          );
        }
        const sha256 = createHash("sha256").update(snapshot.buffer).digest("hex");
        const now = params.nowMs;
        recordLegacyMigrationReceipt(db, {
          sourceKey: key,
          upsert: previousReceipt !== null,
          migrationKind: MIGRATION_KIND,
          sourcePath: claim.sourcePath,
          targetTable:
            path.basename(claim.sourcePath) === "vapid-keys.json"
              ? "config_machine_state"
              : "web_push_subscriptions",
          sourceSha256: sha256,
          sourceSizeBytes: snapshot.size,
          sourceRecordCount:
            path.basename(claim.sourcePath) === "vapid-keys.json"
              ? 1
              : params.legacy.subscriptions.size,
          runId: `${key}:${sha256.slice(0, 16)}`,
          now,
          reportJson: JSON.stringify({
            source: MIGRATION_KIND,
            canonicalFingerprint: sourceFingerprint(
              db,
              claim.sourcePath,
              snapshot.buffer,
              params.env,
            ),
          }),
        });
      }
    },
    { env: params.env },
  );
  return { importedSubscriptions, importedVapidKeys };
}

async function removeClaimedSources(params: {
  claimed: readonly LegacyMigrationSourceClaim[];
  env: NodeJS.ProcessEnv;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<void> {
  for (const claim of params.claimed) {
    await claim.assertSourceNotReappeared(
      `legacy Web Push source reappeared during import: ${claim.sourcePath}`,
    );
  }
  for (const claim of params.claimed) {
    await claim.remove({ removeSource: params.removeSource, skipSourceCheck: true });
    markLegacyMigrationSourceRemoved(sourceKey(claim.sourcePath), params.env);
  }
}

async function recoverReceiptSources(params: {
  stateRoot: Root;
  stateDir: string;
  detected: LegacyStateDetection["webPush"];
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const sourcePaths = [params.detected.subscriptionsPath, params.detected.vapidKeysPath];
  const pushDir = path.join(params.stateDir, "push");
  if (await params.stateRoot.exists("push")) {
    await params.stateRoot.list("push", { withFileTypes: true });
  }
  for (const directory of listUnboundLegacyMigrationSourceCopies(pushDir)) {
    warnings.push(
      "Preserved unbound Web Push private copy " + directory + ". Inspect it and rerun Doctor.",
    );
  }
  for (const sourcePath of sourcePaths) {
    const copies = listLegacyMigrationSourceCopies(sourcePath);
    const receipt = readLegacyMigrationReceipt(sourceKey(sourcePath), params.env);
    const claimPath = sourcePath + ".doctor-importing";
    const sourceExists = pathMayExistSync(sourcePath);
    const claimExists = pathMayExistSync(claimPath);
    if (!receipt) {
      if (copies.length > 0 && !sourceExists && !claimExists) {
        warnings.push(
          "Preserved Web Push private copies for " +
            sourcePath +
            " without a matching SQLite receipt. Inspect them and rerun Doctor.",
        );
      }
      continue;
    }
    if (sourceExists && claimExists) {
      warnings.push(
        "Preserved source and interrupted Web Push claim together at " +
          sourcePath +
          ". Inspect them and rerun Doctor.",
      );
      continue;
    }
    // Preserve this importer's existing newer-file merge contract. A single
    // artifact after completed removal is a new generation, not a staged replay.
    if (receipt.removedSource && sourceExists !== claimExists) {
      continue;
    }
    let failed = false;
    const remainingPath = sourceExists ? sourcePath : claimExists ? claimPath : null;
    if (remainingPath) {
      try {
        const relative = resolveLegacyMigrationRelativePath(
          params.stateDir,
          remainingPath,
          "Web Push",
        );
        const maxBytes =
          sourcePath === params.detected.vapidKeysPath
            ? LEGACY_VAPID_KEYS_MAX_BYTES
            : LEGACY_SUBSCRIPTIONS_MAX_BYTES;
        const { buffer, stat } = await params.stateRoot.read(relative, {
          hardlinks: "reject",
          symlinks: "reject",
          maxBytes,
        });
        const verify = () => {
          const current = readRegularFileSync({ filePath: remainingPath, maxBytes });
          if (
            current.stat.dev !== stat.dev ||
            current.stat.ino !== stat.ino ||
            current.stat.mtimeMs !== stat.mtimeMs ||
            current.stat.size !== stat.size ||
            current.stat.nlink !== 1 ||
            !current.buffer.equals(buffer)
          ) {
            throw new Error("retired Web Push source generation changed before cleanup");
          }
          assertReceiptCanonical({
            sourcePath,
            buffer: current.buffer,
            sha256: createHash("sha256").update(current.buffer).digest("hex"),
            receipt,
            env: params.env,
          });
        };
        verify();
        await params.stateRoot.remove(relative, { assertBeforeMutation: verify });
        changes.push("Removed retired Web Push source covered by its SQLite receipt.");
      } catch (error) {
        failed = true;
        warnings.push(
          "Preserved retired Web Push source " +
            remainingPath +
            ": " +
            String(error) +
            ". Inspect it and rerun Doctor.",
        );
      }
    }
    if (failed) {
      continue;
    }
    for (const directory of copies) {
      try {
        await cleanupLegacyMigrationSourceCopy({
          stateRoot: params.stateRoot,
          directory: resolveLegacyMigrationRelativePath(params.stateDir, directory, "Web Push"),
          maxBytes:
            sourcePath === params.detected.vapidKeysPath
              ? LEGACY_VAPID_KEYS_MAX_BYTES
              : LEGACY_SUBSCRIPTIONS_MAX_BYTES,
          verify: (buffer, sha256) => {
            assertReceiptCanonical({ sourcePath, buffer, sha256, receipt, env: params.env });
            if (pathMayExistSync(sourcePath) || pathMayExistSync(claimPath)) {
              throw new Error("retired Web Push source reappeared during copy cleanup");
            }
          },
        });
        changes.push("Removed interrupted private Web Push copy covered by its SQLite receipt.");
      } catch (error) {
        failed = true;
        warnings.push(
          "Preserved interrupted Web Push copy " +
            directory +
            ": " +
            String(error) +
            ". Inspect it and rerun Doctor.",
        );
      }
    }
    if (!failed && (copies.length > 0 || remainingPath || !receipt.removedSource)) {
      markLegacyMigrationSourceRemoved(receipt.sourceKey, params.env);
      if (copies.length === 0 && !remainingPath) {
        changes.push("Finalized retired Web Push source cleanup receipt.");
      }
    }
  }
  return { changes, warnings };
}

async function migrateLegacyWebPushWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let recovery: MigrationMessages;
  try {
    recovery = await recoverReceiptSources(params);
  } catch (error) {
    return {
      changes,
      warnings: [
        "Failed reading legacy Web Push state: " +
          String(error) +
          ". Inspect them and rerun Doctor.",
      ],
    };
  }
  changes.push(...recovery.changes);
  warnings.push(...recovery.warnings);
  if (warnings.length > 0) {
    return { changes, warnings };
  }

  let legacy: ParsedLegacyState;
  try {
    legacy = await readLegacyState(params.stateRoot, params.stateDir, params.detected, params.env);
  } catch (error) {
    warnings.push(`Failed reading legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  if (legacy.sources.length === 0) {
    return { changes, warnings };
  }

  let claimed: LegacyMigrationSourceClaim[];
  try {
    params.beforeVerify?.();
    await assertSourcesUnchanged(legacy.sources);
    // Claim both sources before the database transaction. A legacy writer can no longer
    // overwrite the retired paths after SQLite becomes canonical.
    await claimLegacyMigrationSourceClaims(legacy.sources, {
      beforeClaim: params.beforeClaim,
      mismatchMessage: "legacy Web Push source changed before doctor could claim it",
    });
    claimed = legacy.sources.map(({ claim }) => claim);
  } catch (error) {
    warnings.push(`Failed migrating legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  let result: { importedSubscriptions: number; importedVapidKeys: boolean };
  try {
    result = migrateIntoDatabase({
      stateDir: params.stateDir,
      env: params.env,
      legacy,
      nowMs: Date.now(),
    });
  } catch (error) {
    const restoreErrors = await restoreLegacyMigrationSourceClaims(claimed);
    warnings.push(
      `Failed migrating legacy Web Push state: ${String(error)}${
        restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""
      }`,
    );
    return { changes, warnings };
  }

  try {
    await removeClaimedSources({
      claimed,
      env: params.env,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(`Web Push state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    `Migrated ${result.importedSubscriptions} Web Push subscription${result.importedSubscriptions === 1 ? "" : "s"} to SQLite.`,
  );
  if (result.importedVapidKeys) {
    changes.push("Migrated the Web Push VAPID identity to SQLite.");
  }
  notices.push("Removed retired Web Push JSON state after verified SQLite import.");
  return { changes, warnings, notices };
}

export async function migrateLegacyWebPush(params: {
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }

  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy Web Push state",
    releaseLabel: "Web Push",
    errorLabel: "Failed reading legacy Web Push state",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_SUBSCRIPTIONS_MAX_BYTES,
        symlinks: "reject",
      });
      return await migrateLegacyWebPushWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    },
  });
}
