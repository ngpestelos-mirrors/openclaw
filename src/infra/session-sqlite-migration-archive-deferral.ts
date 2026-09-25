/** Cancellation of unpublished session archives after a verified retained import. */
import { hasDeferredPluginSessionImport } from "./deferred-plugin-session-sources.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
} from "./session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  collectRecordedConsumedArchives,
  migrationMoveKey,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
} from "./session-sqlite-migration-manifest.js";

/** An intact, unaliased original and no archive prove that this intention can be withdrawn. */
export function isUnpublishedMigrationMove(
  activeRun: ActiveSessionSqliteMigrationRun,
  move: SessionSqliteMigrationMove,
): boolean {
  const key = migrationMoveKey(move);
  if (
    activeRun.manifest.targets.some((target) =>
      target.completedMoves.some((candidate) => migrationMoveKey(candidate) === key),
    ) ||
    collectRecordedConsumedArchives(activeRun.manifest).has(move.archivePath)
  ) {
    return false;
  }
  const references = activeRun.manifest.targets.flatMap((target) =>
    target.plannedMoves
      .filter((candidate) => migrationMoveKey(candidate) === key)
      .map((candidate) => ({ target, move: candidate })),
  );
  try {
    if (!references.length || statMigrationPath(move.archivePath)) {
      return false;
    }
    const identity = readMigrationArtifactIdentity(move.sourcePath);
    return references.every(({ target, move: candidate }) => {
      assertSafeSessionSqliteMigrationMove(candidate, target);
      return (
        candidate.artifact?.disposal.state === "retained" &&
        sameMigrationArtifact(identity, candidate.artifact.identity)
      );
    });
  } catch {
    return false;
  }
}

/** Withdraw all shared references together; never invent a completed, disposed, or restored archive. */
export function withdrawUnpublishedMigrationMoves(
  activeRun: ActiveSessionSqliteMigrationRun,
  moves: readonly SessionSqliteMigrationMove[],
): void {
  if (!moves.length) {
    return;
  }
  if (!moves.every((move) => isUnpublishedMigrationMove(activeRun, move))) {
    throw new Error("Cannot withdraw a migration archive without its exact unpublished original.");
  }
  const keys = new Set(moves.map(migrationMoveKey));
  for (const target of activeRun.manifest.targets) {
    target.plannedMoves = target.plannedMoves.filter((move) => !keys.has(migrationMoveKey(move)));
  }
  writeSessionSqliteMigrationManifest(activeRun);
}

/** A crash between retaining the import and withdrawing its intentions must not invent archives. */
export function isUnpublishedDeferredSessionMove(
  activeRun: ActiveSessionSqliteMigrationRun,
  move: SessionSqliteMigrationMove,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    isUnpublishedMigrationMove(activeRun, move) &&
    activeRun.manifest.targets
      .filter((target) =>
        target.plannedMoves.some(
          (candidate) => migrationMoveKey(candidate) === migrationMoveKey(move),
        ),
      )
      .every((target) =>
        hasDeferredPluginSessionImport({
          target,
          sqlitePath: target.sqlitePath,
          env,
        }),
      )
  );
}
