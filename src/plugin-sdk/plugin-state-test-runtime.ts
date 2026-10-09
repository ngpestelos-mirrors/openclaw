/**
 * Test SDK subpath for plugin state stores, ingress queues, and state DB helpers.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";

/** Bundled fixtures use package-local operation entries without constructing a live registry. */
export function createPluginStateKeyedStoreForTests<T>(
  ...args: Parameters<typeof createPluginStateKeyedStore<T>>
) {
  const [pluginId, options, assertCurrent, moduleSource] = args;
  return createPluginStateKeyedStore<T>(
    pluginId,
    options,
    assertCurrent,
    moduleSource ?? {
      resolve(moduleUrl) {
        const requested = fileURLToPath(moduleUrl);
        const boundaryRoot = path.dirname(requested);
        if (
          path.basename(boundaryRoot) !== pluginId ||
          !/-operation-api\.[cm]?[jt]s$/u.test(path.basename(requested))
        ) {
          throw new Error("Fixture operation must belong to its bundled plugin package");
        }
        const modulePath = existsSync(requested) ? requested : requested.replace(/\.js$/u, ".ts");
        return { modulePath, boundaryRoot, origin: "bundled", pluginId };
      },
    },
  );
}

export {
  createPluginStateSyncKeyedStore as createPluginStateSyncKeyedStoreForTests,
  getPluginStateCapacity as getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctor as importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
export { setMaxMemoryHostEventsForTests } from "../memory-host-sdk/event-store.js";
export { createPluginBlobKernelStore } from "../plugin-state/plugin-blob-store.test-helpers.js";
export {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "../plugin-state/plugin-blob-store.js";
export {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
  listChannelIngressQueueAccountIdsForTests,
} from "./channel-ingress-test-runtime.js";
export { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
export type { DB as OpenClawStateKyselyDatabaseForTests } from "../state/openclaw-state-db.generated.js";
export { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
// Test-only ingress reliability helpers: core predicates polling/webhook tests
// assert directly; excluded from the public SDK surface (private-local subpath).
export {
  INGRESS_CLAIM_LEASE_MS,
  isIngressClaimOwnedByOtherLiveProcess,
} from "../channels/message/ingress-claim-owner.js";
export {
  resolveIngressRetryDelayMs,
  shouldDeadLetterRetryableIngressEvent,
} from "../channels/message/ingress-retry-policy.js";
// Test-only pairing-store seeding so channel tests exercise the real
// store-backed authorization path instead of injecting fake readers.
export { addChannelAllowFromStoreEntry } from "../pairing/pairing-store.js";
