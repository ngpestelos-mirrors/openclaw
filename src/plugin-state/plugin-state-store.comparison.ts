import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  createPluginStateError,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  getPluginStateKysely,
  parseStoredJson,
  selectPluginStateEntry,
  type PluginStateDatabase,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import { updatePluginStateEntry } from "./plugin-state-store.mutations.js";
import type { PluginStateRegisterEntryParams } from "./plugin-state-store.retention.js";
import type {
  PluginStateCompareResult,
  PluginStateBatchResult,
  PluginStateObservation,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

type Key = { pluginId: string; namespace: string; key: string };
export type PluginStateBatchObservationParams = { entries: readonly Key[] };
export type PluginStateBatchComparisonParams = {
  entries: readonly (PluginStatePreparedComparison & PluginStateComparisonLimits)[];
};
export type PluginStatePreparedComparison = Key & { comparison: string } & (
    | { operation: "update"; action: "set"; valueJson: string; ttlMs?: number }
    | { operation: "update" | "delete"; action: "keep" }
    | { operation: "delete"; action: "delete" }
  );
export type PluginStateComparisonLimits = Pick<
  PluginStateRegisterEntryParams,
  "maxEntries" | "overflowPolicy"
>;

const COMPARISON_PATTERN = /^1:([a-f0-9]{64}):([a-f0-9]{64}|-)$/u;

export function validatePluginStateComparison(
  value: string,
  operation: PluginStateStoreOperation,
): string {
  const match = typeof value === "string" ? COMPARISON_PATTERN.exec(value) : null;
  const scope = match?.[1];
  if (!scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      message: "Plugin state comparison must be an observation returned by this store.",
    });
  }
  return scope;
}

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function comparisonScope(storeIdentity: string, key: Key): string {
  return digest([storeIdentity, key.pluginId, key.namespace, key.key]);
}

function observation(
  store: PluginStateDatabase,
  scope: string,
  row: PluginStateReadRow | undefined,
  operation: PluginStateStoreOperation,
): PluginStateObservation<unknown> {
  // Preserve the stored JSON image; caller reserialization can change legacy whitespace/key order.
  const image = row ? digest([row.value_json, row.created_at, row.expires_at]) : "-";
  return {
    value: row ? parseStoredJson(row.value_json, operation, store.path) : undefined,
    comparison: `1:${scope}:${image}`,
  };
}

/** Called after canonical writable admission, with the native owner's recorded database identity. */
export function observePluginStateEntry(
  store: PluginStateDatabase,
  params: Key,
  storeIdentity: string,
): PluginStateObservation<unknown> {
  return observation(
    store,
    comparisonScope(storeIdentity, params),
    selectPluginStateEntry(store.db, { ...params, now: Date.now() }),
    "lookup",
  );
}

function readBatchRows(
  store: PluginStateDatabase,
  entries: readonly Key[],
  now: number,
): Array<PluginStateReadRow | undefined> {
  const first = entries[0];
  if (!first) {
    return [];
  }
  const query = getPluginStateKysely(store.db)
    .selectFrom((eb) =>
      eb
        .fn<{ key: number; value: string }>("json_each", [
          eb.val(JSON.stringify(entries.map(({ namespace, key }) => [namespace, key]))),
        ])
        .as("requested"),
    )
    // Keep requested keys outermost so each row seeks the complete primary key.
    .crossJoin("plugin_state_entries")
    .where("plugin_id", "=", first.pluginId)
    .where((eb) =>
      eb(
        "namespace",
        "=",
        eb.fn<string>("json_extract", [eb.ref("requested.value"), eb.val("$[0]")]),
      ),
    )
    .where((eb) =>
      eb(
        "entry_key",
        "=",
        eb.fn<string>("json_extract", [eb.ref("requested.value"), eb.val("$[1]")]),
      ),
    )
    .select(["requested.key as position", "entry_key", "value_json", "created_at", "expires_at"])
    .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]));
  const rows = new Map(
    executeSqliteQuerySync(store.db, query).rows.map((row) => [row.position, row]),
  );
  return entries.map((_, index) => rows.get(index));
}

/** A bootstrap-only physical source has no rows, but still owns comparison identities. */
export function observeMissingPluginStateBatch(
  store: PluginStateDatabase,
  params: PluginStateBatchObservationParams,
  storeIdentity: string,
): PluginStateObservation<unknown>[] {
  return params.entries.map((entry) =>
    observation(store, comparisonScope(storeIdentity, entry), undefined, "lookup"),
  );
}

/** One indexed row set under the caller's admitted read or canonical writer transaction. */
export function observePluginStateBatch(
  store: PluginStateDatabase,
  params: PluginStateBatchObservationParams,
  storeIdentity: string,
): PluginStateObservation<unknown>[] {
  const rows = readBatchRows(store, params.entries, Date.now());
  return params.entries.map((entry, index) =>
    observation(store, comparisonScope(storeIdentity, entry), rows[index], "lookup"),
  );
}

function validateComparisonScope(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison,
  storeIdentity: string,
): string {
  const operation = params.operation === "update" ? "register" : "delete";
  const expected = validatePluginStateComparison(params.comparison, operation);
  const scope = comparisonScope(storeIdentity, params);
  if (expected !== scope) {
    throw createPluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation,
      path: store.path,
      message: "Plugin state observation belongs to another database, namespace or key.",
    });
  }
  return scope;
}

function applyComparedEntry(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison & PluginStateComparisonLimits,
  now: number,
  row: PluginStateReadRow | undefined,
): { status: "applied" | "unchanged" } {
  if (params.operation === "delete") {
    return {
      status:
        params.action === "delete" && row && deletePluginStateEntry(store.db, params) > 0
          ? "applied"
          : "unchanged",
    };
  }
  deleteExpiredPluginStateEntries(store.db, now, params);
  if (params.action === "keep") {
    return { status: "unchanged" };
  }
  updatePluginStateEntry(store, params, now, row !== undefined);
  return { status: "applied" };
}

/** Compare the complete precondition set before any ordered mutation can change it. */
export function compareAndApplyPluginStateBatch(
  store: PluginStateDatabase,
  params: PluginStateBatchComparisonParams,
  storeIdentity: string,
): PluginStateBatchResult<unknown> {
  const scopes = params.entries.map((entry) =>
    validateComparisonScope(store, entry, storeIdentity),
  );
  const now = Date.now();
  const rows = readBatchRows(store, params.entries, now);
  const current = params.entries.map((_, index) =>
    observation(store, scopes[index]!, rows[index], "lookup"),
  );
  if (params.entries.some((entry, index) => entry.comparison !== current[index]!.comparison)) {
    return { status: "conflict", current };
  }
  let applied = false;
  for (const [index, entry] of params.entries.entries()) {
    if (applyComparedEntry(store, entry, now, rows[index]).status === "applied") {
      applied = true;
    }
  }
  return { status: applied ? "applied" : "unchanged" };
}

/** The caller owns the IMMEDIATE transaction containing comparison, expiry, quotas and mutation. */
export function compareAndApplyPluginStateEntry(
  store: PluginStateDatabase,
  params: PluginStatePreparedComparison & PluginStateComparisonLimits,
  storeIdentity: string,
): PluginStateCompareResult<unknown> {
  const scope = validateComparisonScope(store, params, storeIdentity);
  const now = Date.now();
  const row = selectPluginStateEntry(store.db, { ...params, now });
  const current = observation(
    store,
    scope,
    row,
    params.operation === "update" ? "lookup" : "delete",
  );
  if (current.comparison !== params.comparison) {
    return { status: "conflict", current };
  }
  return applyComparedEntry(store, params, now, row);
}
