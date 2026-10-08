import type { AuditEntry } from "../protocol/audit.js";

export const REEF_AUDIT_NAMESPACE = "audit";
export const REEF_AUDIT_HEAD_NAMESPACE = "audit-head";
export const REEF_AUDIT_HEAD_KEY = "head";
export const REEF_AUDIT_MAX_ENTRIES = 30_000;
export const REEF_AUDIT_STORE_MAX_ENTRIES = REEF_AUDIT_MAX_ENTRIES + 1;
export const REEF_AUDIT_HEAD_MAX_ENTRIES = 1;
export const REEF_AUDIT_MIGRATION_NAMESPACE = "audit-migration";
export const REEF_AUDIT_MIGRATION_KEY = "audit-jsonl";
export const REEF_AUDIT_MIGRATION_MAX_ENTRIES = 1;

type ReefAuditPendingAppend = {
  owner: string;
  expiresAt: number;
  entryKey?: string;
};

export type ReefAuditHeadRecord = {
  kind: "head";
  hash: string;
  seq: number;
  oldestHash: string;
  pending?: ReefAuditPendingAppend;
  garbageEntryKey?: string;
};

export type ReefAuditStateRecord = { kind: "entry"; entry: AuditEntry; nextHash?: string };

export const REEF_AUDIT_APPEND_RETRY_MS = 25;
export const REEF_AUDIT_APPEND_ATTEMPTS = 120;

export function reefAuditEntryKey(entryHash: string): string {
  return `entry:${entryHash}`;
}

export function parseReefAuditHead(input: unknown): ReefAuditHeadRecord {
  const value = input as ReefAuditHeadRecord | undefined;
  if (value === undefined) {
    return { kind: "head", hash: "", seq: 0, oldestHash: "" };
  }
  if (
    !value ||
    value.kind !== "head" ||
    typeof value.hash !== "string" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    (value.seq === 0) !== (value.hash === "") ||
    typeof value.oldestHash !== "string" ||
    (value.seq === 0) !== (value.oldestHash === "") ||
    (value.garbageEntryKey !== undefined &&
      (typeof value.garbageEntryKey !== "string" || value.garbageEntryKey.length === 0)) ||
    (value.pending !== undefined &&
      (typeof value.pending.owner !== "string" ||
        value.pending.owner.length === 0 ||
        !Number.isSafeInteger(value.pending.expiresAt) ||
        value.pending.expiresAt <= 0 ||
        (value.pending.entryKey !== undefined &&
          (typeof value.pending.entryKey !== "string" || value.pending.entryKey.length === 0))))
  ) {
    throw new Error("invalid Reef audit head");
  }
  return value;
}

export function parseAuditEntryRecord(input: unknown): AuditEntry {
  const value = input as ReefAuditStateRecord | undefined;
  if (!value || value.kind !== "entry") {
    throw new Error("missing Reef audit entry");
  }
  return value.entry;
}

export function parseAuditStateRecord(input: unknown): ReefAuditStateRecord {
  parseAuditEntryRecord(input);
  const value = input as ReefAuditStateRecord;
  if (
    value?.nextHash !== undefined &&
    (typeof value.nextHash !== "string" || value.nextHash.length === 0)
  ) {
    throw new Error("invalid Reef audit next pointer");
  }
  return value;
}
