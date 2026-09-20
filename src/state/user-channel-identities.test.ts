import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  linkUserChannelIdentity,
  listUserChannelIdentities,
  resolveUserChannelIdentity,
  unlinkUserChannelIdentity,
  type UserChannelIdentity,
} from "./user-channel-identities.js";
import { readUserProfileAliasRevision } from "./user-profile-events.js";
import { userProfilesDb } from "./user-profiles-internal.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
  linkEmail,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profiles.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});
const identity: UserChannelIdentity = {
  channelId: "discord",
  accountId: "team-bot",
  senderId: "100000000000000001",
};
function stateOptions() {
  return { path: join(tempDirs.make("openclaw-channel-identities-"), "state.sqlite") };
}

it("does not create state or identity tables while resolving absent links", () => {
  const options = stateOptions();
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(listUserChannelIdentities("absent", options)).toEqual([]);
  expect(existsSync(options.path)).toBe(false);
  const { db } = openOpenClawStateDatabase(options);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  expect(listUserChannelIdentities("absent", options)).toEqual([]);
  expect(tableExists(db, "user_profiles")).toBe(false);
  expect(tableExists(db, "user_profile_identities")).toBe(false);
});

it("keeps stable senders scoped to the channel account and refuses conflicting assignments", () => {
  const options = stateOptions();
  const ada = ensureProfileForEmail("ada@example.test", options);
  const grace = ensureProfileForEmail("grace@example.test", options);
  const link = { profileId: ada.id, identity };
  expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
  expect(linkUserChannelIdentity(ada.id, identity, options)).toEqual(link);
  expect(listUserChannelIdentities(ada.id, options)).toEqual([link]);
  expect(() => linkUserChannelIdentity(grace.id, identity, options)).toThrow(
    "linked to another profile",
  );
  expect(() => unlinkUserChannelIdentity(grace.id, identity, options)).toThrow(
    "linked to another profile",
  );
  for (const other of [
    { ...identity, accountId: "personal-bot" },
    { ...identity, channelId: "another-channel" },
  ]) {
    expect(resolveUserChannelIdentity(other, options)).toBeUndefined();
    linkUserChannelIdentity(grace.id, other, options);
    expect(resolveUserChannelIdentity(other, options)?.profileId).toBe(grace.id);
  }
  expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(ada.id);
  expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(true);
  expect(unlinkUserChannelIdentity(ada.id, identity, options)).toBe(false);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
});

it("reads current roles and only canonical login identities, including the current verified GitHub login", () => {
  const options = stateOptions();
  const passkey = ensureProfileForTailscaleIdentity({ login: "ada@passkey" }, options);
  linkEmail("ada@example.test", passkey.id, options);
  const profile = syncGitHubIdentity(
    {
      identity: { accountId: 123, login: "old-login" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    },
    options,
  );
  linkUserChannelIdentity(profile.id, identity, options);
  setUserProfileRole(profile.id, "admin", options);
  const { db } = openOpenClawStateDatabase(options);
  executeSqliteQuerySync(
    db,
    userProfilesDb(db).insertInto("user_profile_emails").values({
      email: "old-login@github",
      profile_id: profile.id,
      created_at: 1,
    }),
  );
  executeSqliteQuerySync(
    db,
    userProfilesDb(db)
      .insertInto("user_profile_identities")
      .values([
        {
          provider: "github-attribution",
          subject: "123",
          profile_id: profile.id,
          canonical_login: "retired-login",
          created_at: 1,
        },
        {
          provider: "github-attribution",
          subject: "456",
          profile_id: profile.id,
          canonical_login: null,
          created_at: 1,
        },
      ]),
  );
  syncGitHubIdentity(
    {
      identity: { accountId: 123, login: "new-login" },
      authenticationAlias: { kind: "github-login", login: "new-login" },
    },
    options,
  );
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: profile.id,
    role: "admin",
    loginIdentities: ["ada@example.test", "ada@passkey", "new-login@github"],
  });
  setUserProfileRole(profile.id, "member", options);
  expect(resolveUserChannelIdentity(identity, options)?.role).toBe("member");
  syncGitHubIdentity(
    {
      identity: { accountId: 789, login: "new-person" },
      authenticationAlias: { kind: "email", email: "ada@example.test" },
    },
    options,
  );
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: profile.id,
    role: "member",
    loginIdentities: ["ada@passkey", "new-login@github"],
  });
});

it("moves links through explicit profile merges and uses the surviving person's role and aliases", () => {
  const options = stateOptions();
  const source = ensureProfileForEmail("source@example.test", options);
  const target = ensureProfileForEmail("target@example.test", options);
  setUserProfileRole(source.id, "admin", options);
  setUserProfileRole(target.id, "member", options);
  linkUserChannelIdentity(source.id, identity, options);
  linkEmail("source@example.test", target.id, options);
  expect(resolveUserChannelIdentity(identity, options)).toEqual({
    profileId: target.id,
    role: "member",
    loginIdentities: ["source@example.test", "target@example.test"],
  });
  expect(listUserChannelIdentities(source.id, options)).toEqual([
    { profileId: target.id, identity },
  ]);
  expect(unlinkUserChannelIdentity(source.id, identity, options)).toBe(true);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
});

it("publishes link and unlink authority changes only after their transaction commits", () => {
  const options = stateOptions();
  const profile = ensureProfileForEmail("ada@example.test", options);
  const revision = readUserProfileAliasRevision();
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      linkUserChannelIdentity(profile.id, identity, options);
      expect(readUserProfileAliasRevision()).toBe(revision);
      throw new Error("rollback");
    }, options),
  ).toThrow("rollback");
  expect(readUserProfileAliasRevision()).toBe(revision);
  expect(resolveUserChannelIdentity(identity, options)).toBeUndefined();
  linkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  linkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      unlinkUserChannelIdentity(profile.id, identity, options);
      throw new Error("rollback");
    }, options),
  ).toThrow("rollback");
  expect(readUserProfileAliasRevision()).toBe(revision + 1);
  expect(resolveUserChannelIdentity(identity, options)?.profileId).toBe(profile.id);
  unlinkUserChannelIdentity(profile.id, identity, options);
  expect(readUserProfileAliasRevision()).toBe(revision + 2);
});

it("rejects the shared owner and malformed identities without linking a person", () => {
  const options = stateOptions();
  const owner = ensureGatewayOwnerProfile("Owner", options);
  const profile = ensureProfileForEmail("ada@example.test", options);
  expect(() => linkUserChannelIdentity(owner.id, identity, options)).toThrow("shared owner");
  expect(() => linkUserChannelIdentity("missing", identity, options)).toThrow(
    "user profile not found",
  );
  for (const senderId of ["", " trimmed ", "x".repeat(513)]) {
    expect(() => linkUserChannelIdentity(profile.id, { ...identity, senderId }, options)).toThrow(
      "invalid channel identity",
    );
  }
  expect(listUserChannelIdentities(profile.id, options)).toEqual([]);
});
