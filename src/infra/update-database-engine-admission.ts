import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

/** Refuse a downgrade that would strand an installed PostgreSQL store. */
export async function assertUpdateDatabaseEngineContexts(
  contexts: readonly { config: OpenClawConfig; env: NodeJS.ProcessEnv }[],
  targetEngines: unknown,
  targetPostgresFamilies?: unknown,
): Promise<void> {
  const supportsPostgres = Array.isArray(targetEngines) && targetEngines.includes("postgres");
  const { listDatabaseEngineStores, selectDatabaseEngine } =
    await import("./database-engine/registry.js");
  const { discoverBackupDatabasePaths } = await import("./backup-sqlite-snapshot.js");
  const { readBackupEngine, readPostgresBackupFamily } =
    await import("../snapshot/database-backup.js");
  for (const context of contexts) {
    const required = new Set(
      listDatabaseEngineStores()
        .filter((store) => selectDatabaseEngine(store, context.config) === "postgres")
        .map((store) => store.id),
    );
    // Preserve the SQLite path: a PostgreSQL-capable target needs no source copies.
    if (supportsPostgres && required.size === 0) {
      continue;
    }
    const paths = await discoverBackupDatabasePaths({
      ...context,
      stateDir: resolveStateDir(context.env),
    });
    const postgres = paths.filter((pathname) => readBackupEngine(pathname).engine === "postgres");
    if (postgres.length === 0 && required.size === 0) {
      continue;
    }
    const refuse = (detail: string): never => {
      throw new UpdatePreMutationError(
        "database-engine-preflight",
        `Update refused: ${detail}. Reverse-port to SQLite with the current binary before updating, or stay on the current version. See https://docs.openclaw.ai/reference/database-engines.`,
      );
    };
    if (!supportsPostgres) {
      refuse(
        `the target does not support the PostgreSQL store at ${postgres[0] ?? "the configured PostgreSQL families"}`,
      );
    }
    for (const pathname of postgres) {
      try {
        required.add(await readPostgresBackupFamily(pathname, context.config));
      } catch {
        refuse(
          `PostgreSQL family at ${pathname} cannot be captured by this updater; use a version with a port and backup provider for that family`,
        );
      }
    }
    for (const family of required) {
      if (!Array.isArray(targetPostgresFamilies) || !targetPostgresFamilies.includes(family)) {
        refuse(`the target does not declare support for the PostgreSQL ${family} family`);
      }
    }
  }
}
