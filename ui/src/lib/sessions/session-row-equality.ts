import type { GatewaySessionRow } from "../../api/types.ts";

function presentationKeys(row: GatewaySessionRow): string[] {
  return Object.keys(row).filter(
    (key) =>
      key !== "snapshotAt" &&
      !(
        key === "totalTokensFresh" &&
        row.totalTokens === undefined &&
        row.totalTokensFresh === false
      ),
  );
}

/** Compare presentation values without treating read freshness as a content change. */
export function isShallowEqualSessionRow(
  incoming: GatewaySessionRow,
  existing: GatewaySessionRow,
): boolean {
  const incomingFields: Record<string, unknown> = incoming;
  const existingFields: Record<string, unknown> = existing;
  const incomingKeys = presentationKeys(incoming);
  const existingKeys = presentationKeys(existing);
  if (incomingKeys.length !== existingKeys.length) {
    return false;
  }
  return incomingKeys.every((key) => {
    const a = incomingFields[key];
    const b = existingFields[key];
    return (
      a === b ||
      (a !== null && b !== null && typeof a === "object" && typeof b === "object"
        ? JSON.stringify(a) === JSON.stringify(b)
        : false)
    );
  });
}
