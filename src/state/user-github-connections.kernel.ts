import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  PersonalGitHubStateError,
  readPersonalGitHubSecret,
  writePersonalGitHubSecret,
} from "../secrets/store/secret-store-hidden-github.js";
import {
  githubOAuthTimestamp as timestamp,
  githubOAuthSecret as secret,
  githubOAuthProfileId as profileId,
  githubOAuthScopes as scopes,
  githubOAuthRefreshFields,
  githubOAuthDeviceFields,
  validGitHubDeviceTiming,
} from "../shared/github-oauth-values.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { stageUserGitHubConnectionCommit } from "./user-github-connection-events.js";
import type { UserGitHubConnectionCommit } from "./user-github-connections.types.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";
import type { UserProfilesDatabase } from "./user-profiles.types.js";

const tokenPair = z.strictObject({
  accessToken: secret,
  refreshToken: secret,
  tokenType: z.literal("bearer"),
  scopes,
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
  refreshTokenExpiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
});
const deviceFields = {
  requestId: z.string().uuid(),
  createdAtMs: timestamp,
  expiresAtMs: timestamp,
};
const device = z.strictObject({
  ...deviceFields,
  kind: z.literal("device"),
  ...githubOAuthDeviceFields,
  candidate: z.strictObject({ profileId, tokens: tokenPair, receivedAtMs: timestamp }).optional(),
});
const connected = z.strictObject({
  kind: z.literal("connected"),
  profileId,
  ...githubOAuthRefreshFields,
  refreshFailure: z.enum(["expired", "failed"]).optional(),
  refresh: z
    .strictObject({
      operationId: z.string().uuid(),
      tokens: tokenPair.optional(),
      receivedAtMs: timestamp.optional(),
    })
    .optional(),
});
const connectionSchema = z
  .strictObject({
    version: z.literal(1),
    generation: z.string().uuid(),
    selection: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("disconnected") }),
      connected,
    ]),
    pending: z
      .discriminatedUnion("kind", [
        z.strictObject({ ...deviceFields, kind: z.literal("starting") }),
        device,
      ])
      .optional(),
  })
  .superRefine((record, ctx) => {
    const pending = record.pending;
    if (pending && !validGitHubDeviceTiming(pending)) {
      ctx.addIssue({ code: "custom", message: "Invalid device timing" });
    }
    const selection = record.selection;
    if (
      selection.kind === "connected" &&
      (selection.refreshExpiresAtMs <= selection.accessExpiresAtMs ||
        Boolean(selection.refresh?.tokens) !== (selection.refresh?.receivedAtMs !== undefined))
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid refresh state" });
    }
  });

export type UserGitHubConnection = z.infer<typeof connectionSchema>;
export type UserGitHubConnected = z.infer<typeof connected>;
export type UserGitHubDevice = z.infer<typeof device>;

const connectionAuthoritySchema = z.strictObject({
  generation: z.string().uuid(),
  selection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("disconnected") }),
    connected.omit({ refreshToken: true, refresh: true }).extend({ refreshing: z.boolean() }),
  ]),
});
const connectionCommitSchema = z.strictObject({
  kind: z.literal("user-github-connection"),
  changes: z.array(
    z.strictObject({ owner: z.string(), connection: connectionAuthoritySchema.nullable() }),
  ),
  retiredProfileIds: z.array(z.string()),
});
export type UserGitHubConnectionAuthority = z.infer<typeof connectionAuthoritySchema>;

/** The connection owner defines the same credential-free projection for snapshots and commits. */
export function projectUserGitHubConnectionAuthority(
  connection: UserGitHubConnection | undefined,
): UserGitHubConnectionAuthority | null {
  if (!connection) return null;
  const selected = connection.selection;
  return {
    generation: connection.generation,
    selection:
      selected.kind === "disconnected"
        ? { kind: "disconnected" }
        : {
            kind: selected.kind,
            profileId: selected.profileId,
            accountId: selected.accountId,
            login: selected.login,
            accessExpiresAtMs: selected.accessExpiresAtMs,
            refreshExpiresAtMs: selected.refreshExpiresAtMs,
            refreshFailure: selected.refreshFailure,
            scopes: [...selected.scopes],
            refreshing: Boolean(selected.refresh),
          },
  };
}

export function isUserGitHubConnectionCommit(value: unknown): value is UserGitHubConnectionCommit {
  return connectionCommitSchema.safeParse(value).success;
}

function publishAfterCommit(
  db: DatabaseSync,
  changes: UserGitHubConnectionCommit["changes"],
  retiredProfileIds: string[],
  capture?: (receipt: UserGitHubConnectionCommit) => void,
): void {
  const receipt: UserGitHubConnectionCommit = {
    kind: "user-github-connection",
    changes,
    retiredProfileIds,
  };
  if (capture) capture(receipt);
  else stageUserGitHubConnectionCommit(db, receipt);
}

export function parseUserGitHubConnection(raw: string): UserGitHubConnection {
  const result = connectionSchema.safeParse(safeParseJson(raw));
  if (!result.success) {
    throw new PersonalGitHubStateError();
  }
  const record = result.data;
  if (record.pending?.kind === "device") {
    registerSecretValueForRedaction(record.pending.deviceCode);
    if (record.pending.candidate) {
      registerTokens(record.pending.candidate.tokens);
    }
  }
  if (record.selection.kind === "connected") {
    registerSecretValueForRedaction(record.selection.refreshToken);
    if (record.selection.refresh?.tokens) {
      registerTokens(record.selection.refresh.tokens);
    }
  }
  return record;
}

function registerTokens(tokens: z.infer<typeof tokenPair>): void {
  registerSecretValueForRedaction(tokens.accessToken);
  registerSecretValueForRedaction(tokens.refreshToken);
}

/** Display fallback to a tombstone is never credential ownership. */
export function resolvePersonalGitHubOwner(profile: string, db: DatabaseSync): string | undefined {
  if (!tableExists(db, "user_profiles")) {
    return undefined;
  }
  const resolved = selectResolvedUserProfileMetadataById(db, profile);
  return resolved && !resolved.merged_into ? resolved.id : undefined;
}

function requireOwner(db: DatabaseSync, owner: string): void {
  if (resolvePersonalGitHubOwner(owner, db) !== owner) {
    throw new Error("Personal GitHub owner changed; reconnect and try again.");
  }
}

function readConnection(db: DatabaseSync, owner: string): UserGitHubConnection | undefined {
  const raw = readPersonalGitHubSecret(db, owner);
  return raw === undefined ? undefined : parseUserGitHubConnection(raw);
}

export function readUserGitHubConnectionInDatabase(
  db: DatabaseSync,
  owner: string,
): UserGitHubConnection | undefined {
  requireOwner(db, owner);
  return readConnection(db, owner);
}

export function readCanonicalUserGitHubConnectionInDatabase(
  db: DatabaseSync,
  profile: string,
): { owner: string; connection: UserGitHubConnection | undefined } | undefined {
  const owner = resolvePersonalGitHubOwner(profile, db);
  return owner ? { owner, connection: readConnection(db, owner) } : undefined;
}

export function writeUserGitHubConnectionInDatabase(
  db: DatabaseSync,
  owner: string,
  next: UserGitHubConnection,
  current: UserGitHubConnection | undefined,
  capture?: (receipt: UserGitHubConnectionCommit) => void,
): UserGitHubConnection {
  const parsed = parseUserGitHubConnection(JSON.stringify(next));
  writePersonalGitHubSecret(db, owner, JSON.stringify(parsed));
  const retained = new Set(connectionProfiles(parsed));
  publishAfterCommit(
    db,
    [{ owner, connection: projectUserGitHubConnectionAuthority(parsed) }],
    connectionProfiles(current).filter((id) => !retained.has(id)),
    capture,
  );
  return parsed;
}

export function disconnectedUserGitHubConnection(): UserGitHubConnection {
  return { version: 1, generation: randomUUID(), selection: { kind: "disconnected" } };
}

export function disconnectUserGitHubConnectionInDatabase(
  db: DatabaseSync,
  owner: string,
  capture: (receipt: UserGitHubConnectionCommit) => void,
): UserGitHubConnection {
  requireOwner(db, owner);
  return writeUserGitHubConnectionInDatabase(
    db,
    owner,
    disconnectedUserGitHubConnection(),
    readConnectionForReplacement(db, owner),
    capture,
  );
}

function connectionProfiles(record: UserGitHubConnection | undefined): string[] {
  return [
    ...(record?.selection.kind === "connected" ? [record.selection.profileId] : []),
    ...(record?.pending?.kind === "device" && record.pending.candidate
      ? [record.pending.candidate.profileId]
      : []),
  ];
}

// Only explicit replacement may repair corruption. A broken merge target must
// count as disconnected state so it never adopts the source's credentials.
function readConnectionForReplacement(db: DatabaseSync, owner: string) {
  try {
    return readConnection(db, owner);
  } catch (error) {
    if (!(error instanceof PersonalGitHubStateError)) {
      throw error;
    }
    return disconnectedUserGitHubConnection();
  }
}

/** Transfer only this live source, never credentials stranded on historical aliases. */
export function mergeUserGitHubConnection(
  db: DatabaseSync,
  source: string,
  target: string,
  capture?: (receipt: UserGitHubConnectionCommit) => void,
): void {
  requireOwner(db, source);
  requireOwner(db, target);
  const sourceRecord = readConnectionForReplacement(db, source);
  const targetRecord = readConnectionForReplacement(db, target);
  const selected = targetRecord ?? sourceRecord;
  if (!selected) {
    return;
  }
  const next: UserGitHubConnection = { ...selected, generation: randomUUID(), pending: undefined };
  writePersonalGitHubSecret(db, target, JSON.stringify(next));
  if (sourceRecord) {
    writePersonalGitHubSecret(db, source, null);
  }
  const retained = new Set(connectionProfiles(next));
  publishAfterCommit(
    db,
    [
      { owner: source, connection: null },
      { owner: target, connection: projectUserGitHubConnectionAuthority(next) },
    ],
    [...connectionProfiles(sourceRecord), ...connectionProfiles(targetRecord)].filter(
      (id) => !retained.has(id),
    ),
    capture,
  );
}

export function listUserGitHubConnectionsInDatabase(db: DatabaseSync): Array<{
  owner: string;
  connection: UserGitHubConnection;
}> {
  if (!tableExists(db, "secret_store_entries") || !tableExists(db, "user_profiles")) {
    return [];
  }
  const query = getNodeSqliteKysely<
    Pick<DB, "secret_store_entries"> & Pick<UserProfilesDatabase, "user_profiles">
  >(db);
  return executeSqliteQuerySync(
    db,
    query
      .selectFrom("secret_store_entries")
      .innerJoin("user_profiles", "user_profiles.id", "secret_store_entries.scope_id")
      .select(["scope_id", "value"])
      .where("scope_kind", "=", "identity")
      .where("name", "=", "github-connection")
      .where("kind", "=", "secret")
      .where("allowed_hosts", "is", null)
      .where("deleted_at_ms", "is", null)
      .where("merged_into", "is", null)
      .orderBy("scope_id"),
  ).rows.flatMap((row) => {
    try {
      return [{ owner: row.scope_id, connection: parseUserGitHubConnection(row.value) }];
    } catch {
      return [];
    }
  });
}
