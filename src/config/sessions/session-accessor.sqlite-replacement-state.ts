import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionEntryReplacementSnapshot,
  SessionEntryStatus,
} from "./session-accessor.sqlite-contract.js";
import {
  projectSessionSharingEntry,
  type SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  writeSessionEntry,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import type {
  SessionEntryMaintenanceInput,
  SessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
} from "./session-accessor.sqlite-maintenance-store.js";
import { readSessionEntryReplacementLabelOwnerKeys } from "./session-accessor.sqlite-replacement-read.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReplacement } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

export type SessionEntryReplacementSelection = {
  sessionKeys?: readonly string[];
  statuses?: readonly SessionEntryStatus[];
  includeLabelOwners?: string;
};

export type SqliteSessionEntryReplacement = SessionEntryReplacement & {
  previousSessionKeys?: readonly string[];
};

export type SessionEntryReplacementState = {
  entries: SessionEntryReplacementSnapshot[];
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
};

export type SessionEntryReplacementCommit = {
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  includeLabelOwners?: string;
  validationKeys: string[];
  replacements: SqliteSessionEntryReplacement[];
  consumePendingReset?: boolean;
  maintenance?: SessionEntryMaintenanceInput;
};

export type SessionEntryReplacementCommitted = {
  previous: Map<string, SessionEntry>;
  current: Map<string, SessionEntry>;
  maintenancePlans: SessionEntryMaintenancePlan[];
};

export type SessionEntryReplacementPublication = {
  kind: "session-entry-replacements";
  previous: Map<string, Pick<SessionEntry, "sessionId">>;
  current: Map<string, SessionSharingEntry>;
  changedKeys: string[];
};

/** Receipts carry only publication facts, never saved prompts or maintenance payloads. */
export function prepareSessionEntryReplacementPublication(
  result: SessionEntryReplacementCommitted,
): SessionEntryReplacementPublication {
  return {
    kind: "session-entry-replacements",
    previous: new Map(
      [...result.previous].map(([key, entry]) => [key, { sessionId: entry.sessionId }]),
    ),
    current: new Map(
      [...result.current].map(([key, entry]) => [key, projectSessionSharingEntry(entry)]),
    ),
    changedKeys: [
      ...new Set([
        ...result.previous.keys(),
        ...result.current.keys(),
        ...result.maintenancePlans.flatMap((plan) => plan.archivedSessionKeys),
      ]),
    ],
  };
}

/** One SQL owner serves admitted worker writes and the native rollback exception. */
export function commitSessionEntryReplacementsInDatabase(
  database: OpenClawAgentDatabase,
  input: SessionEntryReplacementCommit,
  assertCommitAllowed: () => void,
): SessionEntryReplacementCommitted {
  if (
    input.includeLabelOwners !== undefined &&
    JSON.stringify(
      readSessionEntryReplacementLabelOwnerKeys(database, input.includeLabelOwners),
    ) !== JSON.stringify(input.labelOwnerKeys)
  ) {
    throw new Error("SQLite session label owners changed before replacement");
  }
  const transactionEntries = new Map<string, SessionEntry>();
  for (const sessionKey of input.validationKeys) {
    const transactionRow = readExactSessionEntryRow(database, sessionKey);
    const expectedRow = input.expectedRows.get(sessionKey);
    if (
      transactionRow?.row.entry_json !== expectedRow?.row.entry_json ||
      !sqliteSessionEntriesEqual(transactionRow?.entry, expectedRow?.entry)
    ) {
      throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
    }
    if (transactionRow) {
      transactionEntries.set(sessionKey, transactionRow.entry);
    }
  }
  assertCommitAllowed();
  const previous = new Map<string, SessionEntry>();
  const current = new Map<string, SessionEntry>();
  for (const replacement of input.replacements) {
    const sourceEntries = [
      replacement.sessionKey,
      ...(replacement.previousSessionKeys ?? []),
    ].flatMap((sessionKey) => {
      const entry = transactionEntries.get(sessionKey);
      return entry ? [{ entry, sessionKey }] : [];
    });
    const selectedBefore = sourceEntries.toSorted(
      (left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0),
    )[0]?.entry;
    for (const { entry, sessionKey } of sourceEntries) {
      previous.set(sessionKey, entry);
    }
    const written = writeSessionEntry(
      database,
      replacement.sessionKey,
      cloneSessionEntry(replacement.entry),
      {
        ...(input.consumePendingReset ? { consumePendingReset: true } : {}),
        previousEntry: selectedBefore ?? null,
        canonicalPreviousEntry: transactionEntries.get(replacement.sessionKey) ?? null,
      },
    );
    deleteLegacySessionEntryRows(
      database,
      [...(replacement.previousSessionKeys ?? [])],
      replacement.sessionKey,
      {
        rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId,
      },
    );
    current.set(replacement.sessionKey, written);
  }
  const maintenance = input.maintenance;
  const preservation = maintenance?.preservation;
  const maintenancePlan =
    maintenance && preservation
      ? applySessionEntryMaintenanceInDatabase(database, maintenance, () => preservation)
      : emptySessionEntryMaintenancePlan();
  return { previous, current, maintenancePlans: [maintenancePlan] };
}
