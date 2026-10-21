import { describe, expect, it } from "vitest";
import type { TlonResolvedAccount } from "../types.js";
import {
  applyTlonSettingsOverrides,
  buildTlonSettingsMigrations,
  shouldMigrateTlonSetting,
} from "./settings-helpers.js";

const baseAccount: TlonResolvedAccount = {
  accountId: "default",
  name: "Tlon",
  enabled: true,
  configured: true,
  ship: "~sampel-palnet",
  url: "https://example.com",
  code: "lidlut-tabwed-pillex-ridrup",
  dangerouslyAllowPrivateNetwork: false,
  groupChannels: ["chat/~host/general"],
  dmAllowlist: ["~zod"],
  groupInviteAllowlist: ["~bus"],
  autoDiscoverChannels: true,
  showModelSignature: false,
  autoAcceptDmInvites: true,
  autoAcceptGroupInvites: true,
  defaultAuthorizedShips: ["~nec"],
  ownerShip: "~marzod",
};

function allowlistMigrationDecisions(currentSettings: Record<string, unknown>) {
  const allowlistKeys = new Set(["dmAllowlist", "groupInviteAllowlist", "defaultAuthorizedShips"]);
  return Object.fromEntries(
    buildTlonSettingsMigrations(baseAccount, currentSettings)
      .filter((migration) => allowlistKeys.has(migration.key))
      .map((migration) => [
        migration.key,
        shouldMigrateTlonSetting(migration.fileValue, migration.settingsValue),
      ]),
  );
}

const applySettings = (
  currentSettings: Parameters<typeof applyTlonSettingsOverrides>[0]["currentSettings"],
) => applyTlonSettingsOverrides({ account: baseAccount, currentSettings });

describe("shouldMigrateTlonSetting", () => {
  it("does not rehydrate explicit empty-array revocations during startup migration", () => {
    expect(
      allowlistMigrationDecisions({
        dmAllowlist: [],
        groupInviteAllowlist: [],
        defaultAuthorizedShips: [],
      }),
    ).toEqual({
      dmAllowlist: false,
      groupInviteAllowlist: false,
      defaultAuthorizedShips: false,
    });
  });

  it("still seeds file-config allowlists on first run when settings are missing", () => {
    expect(allowlistMigrationDecisions({})).toEqual({
      dmAllowlist: true,
      groupInviteAllowlist: true,
      defaultAuthorizedShips: true,
    });
  });
});

describe("applyTlonSettingsOverrides", () => {
  it("treats explicit empty settings allowlists as authoritative deny-all", () => {
    const result = applySettings({ dmAllowlist: [], groupInviteAllowlist: [] });
    expect(result.effectiveDmAllowlist).toStrictEqual([]);
    expect(result.effectiveGroupInviteAllowlist).toStrictEqual([]);
  });

  it("falls back to file config when settings fields are removed", () => {
    expect(applySettings({})).toMatchObject({
      effectiveDmAllowlist: baseAccount.dmAllowlist,
      effectiveGroupInviteAllowlist: baseAccount.groupInviteAllowlist,
      effectiveAutoDiscoverChannels: baseAccount.autoDiscoverChannels,
      effectiveOwnerShip: baseAccount.ownerShip,
    });
  });

  it("keeps other explicit settings overrides authoritative", () => {
    const result = applySettings({
      autoDiscoverChannels: false,
      autoAcceptDmInvites: false,
      autoAcceptGroupInvites: false,
      showModelSig: true,
      ownerShip: "~nec",
      pendingApprovals: [],
    });
    expect(result).toMatchObject({
      effectiveAutoDiscoverChannels: false,
      effectiveAutoAcceptDmInvites: false,
      effectiveAutoAcceptGroupInvites: false,
      effectiveShowModelSig: true,
      effectiveOwnerShip: "~nec",
    });
    expect(result.pendingApprovals).toStrictEqual([]);
  });
});
