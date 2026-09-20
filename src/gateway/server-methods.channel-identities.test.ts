import { expect, it, vi } from "vitest";
import {
  validateUsersLinkChannelIdentityResult,
  validateUsersListChannelIdentitiesResult,
  validateUsersUnlinkChannelIdentityResult,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "./server-methods.js";

const identity = { channelId: "discord", accountId: "team-bot", senderId: "100000000000000001" };
async function dispatch(method: string, params: unknown, scopes: string[], profileId: string) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    respond,
    client: {
      connId: "channel-identity-test",
      authenticatedUserId: "admin@example.test",
      authenticatedUserProfile: { profileId, displayName: "Admin", hasAvatar: false, updatedAt: 1 },
      connect: {
        role: "operator",
        scopes,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
  });
  return respond.mock.calls[0];
}

it("serves administrator link/list/unlink through registered Gateway methods and rejects ordinary operators", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const admin = ensureProfileForEmail("admin@example.test");
    const person = ensureProfileForEmail("person@example.test");
    const link = { profileId: person.id, identity };
    for (const method of [
      "users.linkChannelIdentity",
      "users.listChannelIdentities",
      "users.unlinkChannelIdentity",
    ]) {
      const denied = await dispatch(
        method,
        method === "users.listChannelIdentities" ? { profileId: person.id } : link,
        ["operator.read", "operator.write"],
        admin.id,
      );
      expect(denied).toEqual([false, undefined, expect.objectContaining({ code: "FORBIDDEN" })]);
    }
    expect(resolveUserChannelIdentity(identity)).toBeUndefined();
    const linked = await dispatch("users.linkChannelIdentity", link, ["operator.admin"], admin.id);
    expect(linked).toEqual([true, link]);
    expect(validateUsersLinkChannelIdentityResult(linked?.[1])).toBe(true);
    expect(resolveUserChannelIdentity(identity)?.profileId).toBe(person.id);
    const listed = await dispatch(
      "users.listChannelIdentities",
      { profileId: person.id },
      ["operator.admin"],
      admin.id,
    );
    expect(listed).toEqual([true, { links: [link] }]);
    expect(validateUsersListChannelIdentitiesResult(listed?.[1])).toBe(true);
    const removed = await dispatch(
      "users.unlinkChannelIdentity",
      link,
      ["operator.admin"],
      admin.id,
    );
    expect(removed).toEqual([true, { removed: true }]);
    expect(validateUsersUnlinkChannelIdentityResult(removed?.[1])).toBe(true);
    expect(resolveUserChannelIdentity(identity)).toBeUndefined();
  });
});

it("rejects malformed or conflicting assignments without changing the saved binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const admin = ensureProfileForEmail("admin@example.test");
    const other = ensureProfileForEmail("other@example.test");
    const link = { profileId: admin.id, identity };
    await dispatch("users.linkChannelIdentity", link, ["operator.admin"], admin.id);
    for (const params of [
      { ...link, identity: { ...identity, senderId: " " } },
      { ...link, unexpected: true },
      { ...link, profileId: other.id },
    ]) {
      const denied = await dispatch(
        "users.linkChannelIdentity",
        params,
        ["operator.admin"],
        admin.id,
      );
      expect(denied?.[0]).toBe(false);
      expect(denied?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
      expect(resolveUserChannelIdentity(identity)?.profileId).toBe(admin.id);
    }
  });
});
