import type {
  SessionEntryPatchCommitObserver,
  SessionEntryPatchCommitted,
} from "./session-entry-patch.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Committed callbacks receive detached facts with the existing optional-argument contract. */
export function notifySessionEntryPatchCommitted(
  observer: SessionEntryPatchCommitObserver | undefined,
  entry: InternalSessionEntry,
  transcript: SessionEntryPatchCommitted["transcriptPredicate"],
  outcomes: SessionEntryPatchCommitted["outcomes"],
): void {
  const snapshot = structuredClone(entry);
  if (outcomes?.length) {
    observer?.(snapshot, transcript, outcomes);
  } else if (transcript) {
    observer?.(snapshot, transcript);
  } else {
    observer?.(snapshot);
  }
}
