import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { expectDefined } from "@openclaw/normalization-core";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { readRestartSentinelSnapshotSync } from "./restart-sentinel-store.js";
import {
  acquireGatewayMaintenanceCoordinator,
  hasGatewayLifecycleCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";
import {
  detectLegacyRestartSentinel,
  migrateLegacyRestartSentinelWithCustody,
  type RestartSentinelMigrationResult,
} from "./state-migrations.restart-sentinel.js";

const sourceLeases = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.restartSentinelImport"));

/** The June updater can publish its final notice after Doctor and after Gateway readiness. */
export async function importLegacyUpdateRestartSentinel(params: {
  context: OpenClawStateWorkerContext;
  shouldRun: () => boolean;
  expectedRevision?: number;
}): Promise<RestartSentinelMigrationResult & { superseded?: boolean }> {
  const { context } = params;
  const env = context.environment;
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (path.resolve(resolveOpenClawStateSqlitePath(env)) !== context.admission.databasePath) {
    throw new Error("Restart notice import does not match its captured state database.");
  }
  const detected = detectLegacyRestartSentinel({ stateDir });
  if (!detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const assertCurrent = () => {
    context.admission.assertCurrent();
    if (
      !params.shouldRun() ||
      !hasGatewayLifecycleCoordinator({
        databasePath: context.admission.databasePath,
        runtimeDirectory: context.coordinatorRuntime.directory,
      })
    ) {
      throw new Error("Restart notice import no longer owns this Gateway generation.");
    }
  };
  assertCurrent();
  const lease = expectDefined(
    sourceLeases.reserve([context.admission.identity.key]),
    "Restart sentinel import lease",
  );
  try {
    await lease.wait();
    assertCurrent();
    return await withStateDatabaseCoordinatorRuntimeDirectory(
      context.coordinatorRuntime,
      async () => {
        const custody = acquireGatewayMaintenanceCoordinator({
          databasePath: context.admission.databasePath,
        });
        const maintenance = createOpenClawDatabaseMaintenanceScope(
          custody.createSchemaFenceDelegate,
          () => {
            if (custody.closed) {
              throw new Error("Restart notice import maintenance custody was released.");
            }
          },
        );
        const assertOwned = () => {
          maintenance.assertAdmission();
          context.admission.assertCurrent();
        };
        try {
          // The restart sidecar joins this accepted work before replacing the Gateway.
          // Stable custody also preserves fs-safe's portable no-replace claim path.
          return await maintenance.run(async () => {
            const expectedRevision = runOpenClawStateWriteTransaction(
              ({ db }) => {
                assertOwned();
                return readRestartSentinelSnapshotSync(db).revision;
              },
              { env },
            );
            if (
              params.expectedRevision !== undefined &&
              params.expectedRevision !== expectedRevision
            ) {
              return { changes: [], warnings: [], superseded: true };
            }
            const stateRoot = await root(stateDir, {
              hardlinks: "reject",
              symlinks: "reject",
            });
            assertOwned();
            return await migrateLegacyRestartSentinelWithCustody({
              detected,
              stateRoot,
              stateDir,
              env,
              assertCurrent: assertOwned,
              expectedRevision,
              updatesOnly: true,
            });
          });
        } finally {
          await maintenance.close();
          custody.release();
        }
      },
    );
  } finally {
    lease.release();
  }
}
