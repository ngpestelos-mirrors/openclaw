// Dependency-free: native Node tooling imports this TypeScript source directly.
/** Type guard for non-array object records at browser-safe boundaries. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns an existing non-array record field or replaces it with a fresh record. */
export function ensureRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

/** Checks an array without filtering, coercing, or copying its string entries. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Checks enumerable own keys without requiring every allowed key to be present. */
export function hasOnlyKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

/** Coerces object-like values to records, falling back to an empty record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return asOptionalObjectRecord(value) ?? {};
}

/** Reads a field only when it exists as a string. */
export function readStringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Returns a non-array record or undefined. */
export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Returns a non-array record or a fresh ordinary empty record. */
export function asNonArrayRecord(value: unknown): Record<string, unknown> {
  return asOptionalRecord(value) ?? {};
}

/** Returns a non-array record or null. */
export function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Returns any object-backed record, including arrays, or undefined. */
export function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Returns any object-backed record, including arrays, or null. */
export function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return asOptionalObjectRecord(value) ?? null;
}

/** Checks that every enumerable own value in a non-array record is a string. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Retains string-valued own enumerable entries from a non-array record. */
export function filterStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Trims string-valued record entries and omits blank values. */
export function normalizeOptionalTrimmedStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = typeof raw === "string" ? raw.trim() : undefined;
    if (normalized) {
      // Ordinary assignment intentionally ignores string __proto__ values.
      record[key] = normalized;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}
