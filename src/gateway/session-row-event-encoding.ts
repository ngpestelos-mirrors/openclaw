import { isProxy } from "node:util/types";
import type { GatewayWsClient } from "./server/ws-types.js";

export type SessionEventProjection = ((client: GatewayWsClient) => unknown) & {
  rows?: WeakSet<object>;
};

function isPlainData(value: unknown, rows: WeakSet<object>, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return typeof value !== "function" && typeof value !== "bigint";
  }
  if (rows.has(value) || seen.has(value)) {
    return true;
  }
  if (isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) ||
    "toJSON" in value
  ) {
    return false;
  }
  seen.add(value);
  const keys = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !isPlainData(descriptor.value, rows, seen)) {
      return false;
    }
  }
  return true;
}

export function trySerializeSessionRowEvent(
  payload: unknown,
  rows: WeakSet<object>,
  encodings: WeakMap<object, string>,
  serializeFields: (fields: Record<string, unknown>) => string,
): string | undefined {
  // Only publication-owned rows are immutable. Caller data with hooks keeps native serialization.
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    isProxy(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype ||
    !isPlainData(payload, rows)
  ) {
    return undefined;
  }
  const encodeRow = (row: object) => {
    let encoded = encodings.get(row);
    if (encoded === undefined) {
      encoded = JSON.stringify(row);
      encodings.set(row, encoded);
    }
    return encoded;
  };
  const fields: string[] = [];
  let pending: Record<string, unknown> = Object.create(null);
  let pendingCount = 0;
  const flush = () => {
    if (pendingCount) {
      const encoded = serializeFields(pending);
      if (encoded) {
        fields.push(encoded);
      }
      pending = Object.create(null);
      pendingCount = 0;
    }
  };
  for (const [name, value] of Object.entries(payload)) {
    let encoded: string;
    if (name === "session" && value !== null && typeof value === "object" && rows.has(value)) {
      encoded = `"session":${encodeRow(value)}`;
    } else if (
      name === "ancestorSessions" &&
      Array.isArray(value) &&
      value.every((row) => row !== null && typeof row === "object" && rows.has(row))
    ) {
      encoded = `"ancestorSessions":[${value.map(encodeRow).join(",")}]`;
    } else {
      pending[name] = value;
      pendingCount += 1;
      continue;
    }
    flush();
    fields.push(encoded);
  }
  flush();
  return `,"payload":{${fields.join(",")}}`;
}
