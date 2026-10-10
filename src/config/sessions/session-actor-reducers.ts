import type { SessionActorReducer } from "./session-actor-contract.js";
import { reduceSessionBookkeeping } from "./session-entry-patch-operation.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Reduce only bookkeeping; lifecycle and custody belong to the phase command. */
export function reduceSessionActorEntry(
  entry: SessionEntry,
  reducers: readonly SessionActorReducer[],
): SessionEntry {
  let next = structuredClone(entry);
  for (const reducer of reducers) {
    const patch = reduceSessionBookkeeping(next, reducer);
    if (patch) next = { ...next, ...patch };
  }
  return next;
}
