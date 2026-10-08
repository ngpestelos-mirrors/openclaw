import { toUSVString } from "node:util";
import type { SessionEntriesCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  validatePluginStateComparison,
  type PluginStatePreparedComparison,
  type PluginStateComparisonLimits,
} from "./plugin-state-store.comparison.js";
import { capturePluginStateNativeBindingStore } from "./plugin-state-store.native-binding.js";
import type {
  PluginStateBatch,
  PluginStateBatchChange,
  PluginStateBatchKey,
  PluginStateBatchResult,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateObservation,
} from "./plugin-state-store.types.js";
import {
  invalidInput,
  prepareRegisterParams,
  validateKey,
} from "./plugin-state-store.validation.js";
import {
  comparePluginStateBatchInWorker,
  listPluginStateInWorker,
  observeExistingPluginStateBatchInWorker,
  observePluginStateBatchInWorker,
} from "./plugin-state-worker-client.js";

/** Capture one physical store and its live authority before asynchronous planning. */
export function createPluginStateBatch<T = unknown>(
  owner: object,
  stores: readonly Pick<PluginStateKeyedStore<T>, "lookup" | "entries">[],
  authority?: { assertCurrent: () => void },
): PluginStateBatch<T> {
  if (stores.length === 0 || stores.length > 10_000) {
    throw invalidInput("Plugin state batches require between 1 and 10000 stores.");
  }
  if (authority && typeof authority.assertCurrent !== "function") {
    throw invalidInput("Plugin state batch authority requires assertCurrent.");
  }
  const captureBinding = (store: object) => {
    const binding = capturePluginStateNativeBindingStore(store);
    if (!binding) {
      throw invalidInput("Plugin state batches require host-owned asynchronous stores.");
    }
    binding.assertCurrent?.();
    return binding;
  };
  const bindings = stores.map(captureBinding);
  const allBindings = [...new Set([captureBinding(owner), ...bindings])];
  authority?.assertCurrent();
  const first = allBindings[0]!;
  const context = captureOpenClawStateWorkerContext({ env: first.options.env });
  const contexts = new Map([[first.options.env, context]]);
  for (const binding of allBindings) {
    if (binding.options.pluginId !== first.options.pluginId) {
      throw invalidInput("Plugin state batches require stores belonging to one plugin.");
    }
    let candidate = contexts.get(binding.options.env);
    if (!candidate) {
      candidate = captureOpenClawStateWorkerContext({ env: binding.options.env });
      contexts.set(binding.options.env, candidate);
    }
    if (
      candidate.admission.databasePath !== context.admission.databasePath ||
      candidate.admission.identity.key !== context.admission.identity.key ||
      candidate.admission.identity.birthtime !== context.admission.identity.birthtime
    ) {
      throw invalidInput("Plugin state batches require one physical state source.");
    }
  }
  const checks = [...new Set(allBindings.flatMap((binding) => binding.sessionEntryCurrent ?? []))];
  const sessionEntryCurrent: SessionEntriesCurrentCheck | undefined = checks.length
    ? {
        sources: checks.flatMap((check) => ("source" in check ? [check.source] : check.sources)),
        assertCurrent(entries) {
          let offset = 0;
          for (const check of checks) {
            if ("source" in check) {
              check.assertCurrent(entries[offset++]);
            } else {
              check.assertCurrent(entries.slice(offset, offset + check.sources.length));
              offset += check.sources.length;
            }
          }
        },
      }
    : undefined;
  const assertActive = () => {
    for (const candidate of contexts.values()) {
      candidate.admission.assertCurrent();
    }
    for (const binding of allBindings) {
      binding.assertCurrent?.();
    }
    authority?.assertCurrent();
  };
  const scope = { context, assertActive, sessionEntryCurrent };
  const requireBinding = (store: number) => {
    const binding = Number.isSafeInteger(store) ? bindings[store] : undefined;
    if (!binding) {
      throw invalidInput("Plugin state batch key names an unknown store.");
    }
    return binding;
  };
  const prepareKeys = (keys: readonly PluginStateBatchKey[]) => {
    assertActive();
    if (keys.length > 10_000) {
      throw invalidInput("Plugin state batches accept at most 10000 keys.");
    }
    const seen = new Set<string>();
    return keys.map(({ store, key }) => {
      const binding = requireBinding(store);
      const normalizedKey = toUSVString(validateKey(key));
      const identity = JSON.stringify([binding.options.namespace, normalizedKey]);
      if (seen.has(identity)) {
        throw invalidInput("Plugin state batches require unique namespace and key pairs.");
      }
      seen.add(identity);
      return { binding, key: normalizedKey };
    });
  };
  const prepareReadKeys = (keys: readonly PluginStateBatchKey[]) =>
    prepareKeys(keys).map(({ binding, key }) => ({
      pluginId: binding.options.pluginId,
      namespace: binding.options.namespace,
      key,
    }));
  return {
    async observeExisting(keys) {
      const entries = prepareReadKeys(keys);
      const observed = await observeExistingPluginStateBatchInWorker({ ...scope, entries });
      assertActive();
      // SAFETY: The observations retain the supplied namespaces' caller-owned JSON type.
      return observed as PluginStateObservation<T>[] | undefined;
    },
    async entries(store) {
      assertActive();
      const { pluginId, namespace } = requireBinding(store).options;
      const entries = await listPluginStateInWorker({ ...scope, pluginId, namespace });
      assertActive();
      // SAFETY: Entries retain the selected host-minted namespace's caller-owned JSON type.
      return entries as PluginStateEntry<T>[];
    },
    async observe(keys) {
      const entries = prepareReadKeys(keys);
      if (!entries.length) {
        return [];
      }
      const observed = await observePluginStateBatchInWorker({ ...scope, entries });
      assertActive();
      // SAFETY: Each host-minted namespace stores the caller's JSON value type.
      return observed as PluginStateObservation<T>[];
    },
    async compareAndApply(changes: readonly PluginStateBatchChange<T>[]) {
      const keys = prepareKeys(changes);
      const entries = changes.map(
        (
          { comparison, intent },
          index,
        ): PluginStatePreparedComparison & PluginStateComparisonLimits => {
          const { binding, key } = keys[index]!;
          if (intent?.operation !== "update" && intent?.operation !== "delete") {
            throw invalidInput("Plugin state comparison requires an update or delete intent.");
          }
          const operation = intent.operation === "update" ? "register" : "delete";
          validatePluginStateComparison(comparison, operation);
          const { pluginId, namespace, maxEntries, overflowPolicy, defaultTtlMs } = binding.options;
          const common = { pluginId, namespace, maxEntries, overflowPolicy, key, comparison };
          if (intent.operation === "update" && intent.action === "set") {
            return {
              ...common,
              ...prepareRegisterParams(
                key,
                intent.value,
                defaultTtlMs,
                { ttlMs: intent.ttlMs },
                namespace,
              ),
              operation: "update",
              action: "set",
            };
          }
          if (intent.action === "keep") {
            return { ...common, operation: intent.operation, action: "keep" };
          }
          if (intent.operation === "delete" && intent.action === "delete") {
            return { ...common, operation: "delete", action: "delete" };
          }
          throw invalidInput("Plugin state comparison has an invalid mutation action.", operation);
        },
      );
      if (!entries.length) {
        return { status: "unchanged" };
      }
      const result = await comparePluginStateBatchInWorker({ ...scope, entries });
      if (result.status === "conflict") {
        assertActive();
      }
      // SAFETY: Conflicts return the same namespace JSON type exposed by observe.
      return result as PluginStateBatchResult<T>;
    },
  };
}
