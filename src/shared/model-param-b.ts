import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Infers the largest `<number>b` parameter-size token from a model id or display name. */
export function inferParamBFromIdOrName(text: string): number | null {
  const raw = normalizeLowercaseStringOrEmpty(text);
  // Trailing boundary is a lookahead so two adjacent `<num>b` tokens sharing one delimiter (e.g.
  // "8b 70b" / "8b-70b") both match; a consuming boundary ate the delimiter and skipped the second.
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?=[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const match of matches) {
    const numRaw = match[1];
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    if (best === null || value > best) {
      best = value;
    }
  }
  return best;
}

/** Restricts live repetition detection to models with a known total size of at most 32B. */
export function isSmallModel(model: {
  id: string;
  name?: string;
  parameterCount?: number;
}): boolean {
  const paramB =
    model.parameterCount === undefined
      ? inferParamBFromIdOrName(`${model.id} ${model.name ?? ""}`)
      : model.parameterCount / 1_000_000_000;
  return paramB !== null && paramB > 0 && paramB <= 32;
}
