import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import * as auth from "./users-auth-connect.test-support.js";

auth.setupModelAccountConnectTest();

const savedId = "personal:profile-1:saved";

function expectLookup(mock: unknown, params: unknown) {
  expect(mock).toHaveBeenCalledWith(params, { context: expect.anything() });
}

it("lists account pages for their owner or an identified administrator", async () => {
  const accounts = [{ authProfileId: savedId }];
  auth.listUserModelAccounts.mockReturnValue({
    accounts,
    nextCursor: savedId,
  });
  await auth.expectReply(
    auth.rpc("users.listModelAccounts", { cursor: "personal:profile-1:before" }),
    {
      profileId: "profile-1",
      accounts,
      nextCursor: savedId,
      links: [],
    },
  );
  expectLookup(auth.listUserModelAccounts, {
    profileId: "profile-1",
    cursor: "personal:profile-1:before",
  });
  await auth.expectReply(auth.rpc("users.listAuthLinks", { profileId: "profile-1" }), {
    links: [],
  });
  auth.listUserModelAccounts.mockClear();
  auth.listUserProfileAuthLinks.mockClear();
  await auth.expectError(
    auth.rpc("users.listModelAccounts", { profileId: "profile-other" }),
    "FORBIDDEN",
  );
  expect(auth.listUserModelAccounts).not.toHaveBeenCalled();
  await auth.expectError(
    auth.rpc("users.listAuthLinks", { profileId: "profile-other" }),
    "FORBIDDEN",
  );
  expect(auth.listUserProfileAuthLinks).not.toHaveBeenCalled();

  const admin = auth.createClient("profile-admin", ["operator.admin"]);
  auth.listUserModelAccounts.mockReturnValue({ accounts: [] });
  await auth.expectReply(
    auth.rpc("users.listModelAccounts", { profileId: "profile-other" }, admin),
    {
      profileId: "profile-other",
      accounts: [],
      links: [],
    },
  );
  expectLookup(auth.listUserModelAccounts, {
    profileId: "profile-other",
    cursor: undefined,
  });
});

it.each([
  ["users.listModelAccounts", {}],
  ["users.authConnect.catalog", {}],
  ["users.authConnect.start", { provider: "openai", method: "oauth" }],
  ["users.selectModelAccount", { authProfileId: "personal:profile-other:saved" }],
  ["users.listAuthLinks", {}],
  ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
  ["users.unlinkAuthProfile", { provider: "openai" }],
] as const)(
  "requires an identified administrator for %s with an explicit owner",
  async (method, params) => {
    delete auth.self.authenticatedUserProfile;
    auth.self.connect.scopes = ["operator.admin"];
    auth.readUserModelAccountSummary.mockReturnValue({
      provider: "openai",
      authProfileId: "personal:profile-other:saved",
    });

    await auth.expectError(
      auth.rpc(method, { ...params, profileId: "profile-other" }),
      "FORBIDDEN",
    );
    expect(auth.prepareUserProfileSelectionAuthority).not.toHaveBeenCalled();
    expect(auth.runAuth).not.toHaveBeenCalled();
    expect(auth.writes).toEqual([]);
    expect(auth.linksByOwner.size).toBe(0);
  },
);

it("selects a retained owned account and cancels an older sign-in without rewriting credentials", async () => {
  const flow = await auth.startFlow();
  await auth.expectError(
    auth.rpc("users.selectModelAccount", { authProfileId: "personal:profile-other:missing" }),
    "INVALID_REQUEST",
  );
  expect(await auth.status(flow)).toMatchObject({ status: "pending" });
  auth.readUserModelAccountSummary.mockReturnValue({
    provider: "openai",
    authProfileId: savedId,
  });
  await auth.expectReply(auth.rpc("users.selectModelAccount", { authProfileId: savedId }), {
    links: [{ provider: "openai", authProfileId: savedId, updatedAt: 2 }],
  });
  expectLookup(auth.readUserModelAccountSummary, {
    profileId: "profile-1",
    authProfileId: "personal:profile-1:saved",
  });
  expect(await auth.status(flow)).toEqual({ status: "cancelled" });
  await auth.expectReply(auth.complete(flow), { status: "cancelled" });
  expect(auth.writes).toEqual([]);
  expect(auth.broadcast).toHaveBeenCalledExactlyOnceWith(
    "chat.metadata.changed",
    {},
    { dropIfSlow: true },
  );
  await auth.expectReply(
    auth.rpc("users.unlinkAuthProfile", { profileId: "profile-1", provider: "openai" }),
    { links: [] },
  );
  expect(auth.linksByOwner.get("profile-1")).toEqual([]);
  expect(auth.broadcast).toHaveBeenCalledTimes(2);
});

it("orders pending selection before disconnect without cancelling a newer sign-in", async ({
  signal,
}) => {
  const lookupEntered = createDeferredCore();
  const releaseLookup = createDeferredCore<{ provider: string; authProfileId: string }>();
  const unlinkEntered = createDeferredCore();
  const authProfileId = savedId;
  auth.readUserModelAccountSummary.mockImplementationOnce(() => {
    lookupEntered.resolve();
    return releaseLookup.promise;
  });
  const unlink = auth.service.unlinkAsync.bind(auth.service);
  vi.spyOn(auth.service, "unlinkAsync").mockImplementation((...args) => {
    const result = unlink(...args);
    unlinkEntered.resolve();
    return result;
  });
  const selecting = auth.rpc("users.selectModelAccount", { authProfileId });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        lookupEntered.promise,
        selecting,
        "Selection completed before its account lookup",
      ),
      signal,
    );
    const disconnecting = auth.rpc("users.unlinkAuthProfile", {
      profileId: "profile-1",
      provider: "openai",
    });
    await withinTest(
      awaitGateBeforeSettlement(
        unlinkEntered.promise,
        disconnecting,
        "Disconnect completed before reaching the service",
      ),
      signal,
    );
    const newerFlow = await auth.startFlow();
    releaseLookup.resolve({ provider: "openai", authProfileId });
    await Promise.all([selecting, disconnecting]);
    expect(auth.setUserProfileAuthLink.mock.invocationCallOrder[0]).toBeLessThan(
      auth.clearUserProfileAuthLink.mock.invocationCallOrder[0]!,
    );
    expect(auth.linksByOwner.get("profile-1")).toEqual([]);
    expect(await auth.status(newerFlow)).toMatchObject({ status: "pending" });
    await auth.complete(newerFlow);
    await auth.terminal(newerFlow, "connected");
    expect(auth.writes).toEqual([auth.credential]);
  } finally {
    releaseLookup.resolve({ provider: "openai", authProfileId });
  }
});

it.each([
  "disconnected",
  "agent caller",
  "synthetic system actor",
  "delegated operator actor",
  "system actor without a profile",
  "copied client",
  "agent tool caller",
] as const)(
  "refuses account links and selection for %s without changing the default",
  async (reason) => {
    const flow = await auth.startFlow();
    const links = [{ provider: "openai", authProfileId: "openai:saved", updatedAt: 1 }];
    auth.linksByOwner.set("profile-1", links);
    const admin = auth.createClient("profile-admin", ["operator.admin"]);
    let caller = admin;
    if (reason === "disconnected") {
      auth.clients.delete(admin);
    } else if (reason === "agent caller") {
      admin.internal = { syntheticClient: true };
    } else if (reason === "synthetic system actor") {
      admin.internal = { syntheticClient: true, operatorRoleActor: { kind: "system" } };
    } else if (reason === "delegated operator actor") {
      admin.internal = { operatorRoleActor: { kind: "operator", profileId: "profile-admin" } };
    } else if (reason === "system actor without a profile") {
      delete admin.authenticatedUserProfile;
      admin.internal = { operatorRoleActor: { kind: "system" } };
    } else if (reason === "copied client") {
      caller = { ...admin };
    } else if (reason === "agent tool caller") {
      admin.internal = { agentToolCaller: { agentId: "main", sessionKey: "agent:main:test" } };
    }
    const results = [];
    for (const [method, params] of [
      ["users.selectModelAccount", { authProfileId: savedId }],
      ["users.listAuthLinks", {}],
      ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
      ["users.unlinkAuthProfile", { provider: "openai" }],
    ] as const) {
      results.push(
        (await auth.rpc(method, { ...params, profileId: "profile-1" }, caller)).mock.calls,
      );
    }
    expect(results).toEqual(
      Array.from({ length: 4 }, () => [
        [false, undefined, expect.objectContaining({ code: "FORBIDDEN" })],
      ]),
    );
    expect(auth.linksByOwner.get("profile-1")).toEqual(links);
    expect(await auth.status(flow)).toMatchObject({ status: "pending" });
    expect(auth.setUserProfileAuthLink).not.toHaveBeenCalled();
    expect(auth.clearUserProfileAuthLink).not.toHaveBeenCalled();
    expect(auth.broadcast).not.toHaveBeenCalled();
    expect(auth.writes).toEqual([]);
  },
);

it.each(["shared", "personal", "config-declared"] as const)(
  "lets an identified administrator attach a %s credential and retire the old sign-in",
  async (source) => {
    const owner = randomUUID();
    const admin = auth.createClient("profile-admin", ["operator.admin"]);
    const provider = source === "config-declared" ? "amazon-bedrock" : "openai";
    const authProfileId =
      source === "personal" ? `personal:${owner}:${randomUUID()}` : `${provider}:shared`;
    if (source === "config-declared") {
      auth.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
        version: 1,
        profiles: {},
      });
      auth.setConfig({ auth: { profiles: { [authProfileId]: { provider, mode: "aws-sdk" } } } });
    }
    const flow = await auth.startFlow(owner, admin, provider);
    auth.readUserModelAccountSummary.mockReturnValue({ provider, authProfileId });
    await auth.expectReply(
      auth.rpc("users.linkAuthProfile", { profileId: owner, authProfileId }, admin),
      {
        links: [{ provider, authProfileId, updatedAt: 2 }],
      },
    );
    expect(await auth.status(flow, owner, admin)).toEqual({ status: "cancelled" });
    await auth.expectReply(auth.rpc("users.listAuthLinks", { profileId: owner }, admin), {
      links: auth.linksByOwner.get(owner),
    });
    await auth.expectReply(
      auth.rpc("users.unlinkAuthProfile", { profileId: owner, provider }, admin),
      {
        links: [],
      },
    );
    expect(auth.linksByOwner.get(owner)).toEqual([]);
    expect(auth.broadcast).toHaveBeenCalledTimes(2);
    expect(auth.writes).toEqual([]);
    if (source === "personal") {
      expectLookup(auth.readUserModelAccountSummary, {
        profileId: owner,
        authProfileId,
      });
      expect(auth.ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
    }
  },
);

it("keeps failed manual attachments from changing a default or cancelling its sign-in", async () => {
  const flow = await auth.startFlow();
  const params = { profileId: "profile-1", authProfileId: "openai:shared" };
  await auth.expectError(auth.rpc("users.linkAuthProfile", params), "FORBIDDEN");
  const admin = auth.createClient("profile-admin", ["operator.admin"]);
  await auth.expectError(
    auth.rpc("users.linkAuthProfile", { ...params, authProfileId: "missing" }, admin),
    "INVALID_REQUEST",
    { message: expect.stringContaining("openclaw models auth login") },
  );
  await auth.expectError(
    auth.rpc(
      "users.linkAuthProfile",
      {
        ...params,
        authProfileId: `personal:${randomUUID()}:${randomUUID()}`,
      },
      admin,
    ),
    "INVALID_REQUEST",
    { message: expect.stringContaining("your personal account list") },
  );
  expect(auth.setUserProfileAuthLink).not.toHaveBeenCalled();
  expect(await auth.status(flow)).toMatchObject({ status: "pending" });
  expect(auth.broadcast).not.toHaveBeenCalled();
});

it.each(["list", "status", "changed links"] as const)(
  "revalidates disclosure after the %s read settles",
  async (kind) => {
    const flow = kind === "status" ? await auth.startFlow() : undefined;
    if (flow) {
      await auth.complete(flow);
      await auth.terminal(flow, "connected");
    }
    const entered = createDeferredCore();
    const release = createDeferredCore<UserProfileAuthLink[]>();
    auth.listUserProfileAuthLinks.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const reading = flow ? auth.flowRpc("status", flow) : auth.rpc("users.listModelAccounts", {});
    await entered.promise;
    if (kind === "changed links") {
      auth.modelAccountLinksCurrent.mockReturnValue(false);
    } else {
      auth.self.invalidated = true;
    }
    release.resolve([]);
    await auth.expectError(reading, kind === "changed links" ? "UNAVAILABLE" : "FORBIDDEN");
  },
);
