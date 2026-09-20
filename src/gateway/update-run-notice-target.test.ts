import { expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeUpdateRunNoticeTarget } from "./update-run-notice-target.js";

it("authorizes linked admins through Discord's direct-recipient grammar and current grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
      pluginId: "discord",
      artifactBasename: "api.js",
    });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
      null,
      "default",
    );
    try {
      const cfg: OpenClawConfig = {
        gateway: {
          auth: { identityScopes: { "ada@example.test": ["operator.admin"] } },
          roles: {
            default: "member",
            definitions: {
              admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
              member: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      const senderId = "123456789012345678";
      const profile = ensureProfileForEmail("ada@example.test");
      setUserProfileRole(profile.id, "admin");
      linkUserChannelIdentity(profile.id, { channelId: "discord", accountId: "team", senderId });
      const target = {
        kind: "route",
        route: {
          channel: "discord",
          accountId: "team",
          to: `user:${senderId}`,
          chatType: "direct",
        },
      } as const;
      for (const to of [`user:${senderId}`, `discord:user:${senderId}`, `<@${senderId}>`]) {
        const direct = { ...target, route: { ...target.route, to } };
        expect(authorizeUpdateRunNoticeTarget(cfg, direct)).toBe(direct);
      }
      for (const route of [
        { ...target.route, accountId: "another" },
        { ...target.route, to: `channel:${senderId}` },
        { ...target.route, chatType: "group" as const },
        { ...target.route, to: senderId, chatType: "channel" as const },
      ]) {
        expect(authorizeUpdateRunNoticeTarget(cfg, { kind: "route", route }).kind).toBe("none");
      }
      setUserProfileRole(profile.id, "member");
      expect(authorizeUpdateRunNoticeTarget(cfg, target).kind).toBe("none");
      setUserProfileRole(profile.id, "admin");
      expect(authorizeUpdateRunNoticeTarget(cfg, target)).toBe(target);
      cfg.gateway!.auth!.identityScopes = {};
      expect(authorizeUpdateRunNoticeTarget(cfg, target).kind).toBe("none");
    } finally {
      rollbackStagedPluginRegistry(previous);
    }
  });
});
