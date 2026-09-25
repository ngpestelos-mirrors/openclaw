import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  withDeferredPluginMigrationsCurrent,
} from "../infra/deferred-plugin-migrations.js";
import {
  deferredSessionDatabaseIdentity,
  recordDeferredPluginSessionImport,
} from "../infra/deferred-plugin-session-sources.js";
import {
  isUnpublishedMigrationMove,
  withdrawUnpublishedMigrationMoves,
} from "../infra/session-sqlite-migration-archive-deferral.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
} from "../infra/session-sqlite-migration-artifact.js";
import type {
  ActiveSessionSqliteMigrationRun,
  SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isRetainedSourceIssue, type LegacyArchiveTarget } from "./doctor-session-sqlite-types.js";

/** No-copy fallback only for the raw Node link refusal, before this run publishes any archive. */
export function deferSessionArchiveOnLinkDenial(params: {
  error: unknown;
  move: SessionSqliteMigrationMove;
  activeRun: ActiveSessionSqliteMigrationRun;
  owners: readonly LegacyArchiveTarget[];
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  retain: (owner: LegacyArchiveTarget) => void;
}): boolean {
  const { error, move, activeRun } = params;
  // Never unwrap fs-safe post-publication errors, even if their cause is EPERM.
  if (
    getFsSafeNativeConfig().mode !== "off" ||
    !isRecord(error) ||
    (error.code !== "EACCES" && error.code !== "EPERM") ||
    error.syscall !== "link" ||
    error.path !== move.sourcePath ||
    error.dest !== move.archivePath ||
    activeRun.manifest.targets.some((target) => target.completedMoves.length > 0)
  ) {
    return false;
  }
  const moves = activeRun.manifest.targets.flatMap((target) => target.plannedMoves);
  if (!moves.length || !moves.every((planned) => isUnpublishedMigrationMove(activeRun, planned))) {
    return false;
  }
  const owners = params.owners.filter(
    (owner) =>
      owner.validated &&
      owner.verifiedSources &&
      owner.verifiedDatabaseIdentity &&
      !owner.sourceConflicts?.size &&
      owner.report.issues.every(
        (issue) =>
          isRetainedSourceIssue(issue) || issue.code === "plugin_migration_source_retained",
      ),
  );
  const referencingTargets = activeRun.manifest.targets.filter(
    (target) => target.plannedMoves.length > 0,
  );
  if (
    !referencingTargets.length ||
    referencingTargets.some(
      (target) =>
        !owners.some(
          (owner) =>
            owner.target.agentId === target.agentId &&
            owner.target.storePath === target.storePath &&
            owner.target.sqlitePath === target.sqlitePath &&
            target.plannedMoves.every((planned) =>
              owner.verifiedSources?.some((source) => source.path === planned.sourcePath),
            ),
        ),
    )
  ) {
    return false;
  }
  const pending = readDeferredPluginMigrations({ env: params.env });
  let notified = false;
  withDeferredPluginMigrationsCurrent({ env: params.env, expectedPending: pending }, () =>
    runOpenClawStateWriteTransaction(
      () => {
        // Capture covers indexes, shared transcripts, trajectories, and unindexed history.
        // Recheck every byte/inode and the validated canonical database before any receipt.
        for (const owner of owners) {
          if (
            deferredSessionDatabaseIdentity(owner.target.sqlitePath) !==
              owner.verifiedDatabaseIdentity ||
            !owner.verifiedSources!.every((source) =>
              sameMigrationArtifact(readMigrationArtifactIdentity(source.path), source.identity),
            )
          ) {
            throw new Error(
              "Session migration inputs or database changed before archive deferral.",
            );
          }
        }
        const pluginIds = pending.map((plugin) => plugin.pluginId);
        for (const owner of owners) {
          if (!owner.retainedImportVerified) {
            recordDeferredPluginSessionImport({
              cfg: params.cfg,
              env: params.env,
              target: owner.sourceTarget,
              sqlitePath: owner.target.sqlitePath,
              expectedDatabaseIdentity: owner.verifiedDatabaseIdentity,
              sources: owner.verifiedSources!,
              pluginIds,
              recordCount: owner.report.legacyEntries,
            });
            if (!notified) {
              owner.report.issues.push({
                code: "plugin_migration_source_retained",
                message:
                  "Canonical session import is verified. This filesystem refused archive hard links; original session migration inputs remain in place. SQLite is authoritative and these inputs will not be imported again.",
              });
              notified = true;
            }
            owner.retainedImportVerified = true;
          }
          owner.deferredPluginIds = pluginIds;
        }
      },
      { env: params.env },
    ),
  );
  // Receipts precede withdrawal so interruption cannot authorize replay. Reconciliation
  // can withdraw the same still-unpublished intentions on import or restore after a crash.
  withdrawUnpublishedMigrationMoves(activeRun, moves);
  for (const owner of owners) {
    params.retain(owner);
  }
  return true;
}
