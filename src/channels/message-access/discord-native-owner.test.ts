import { expect, it, vi } from "vitest";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { linkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

installDiscordRegistryHooks();

function createInteraction() {
  return {
    user: { id: "123456789012345678", username: "ada", globalName: "Ada" },
    channel: { type: 0, id: "234567890123456789" },
    guild: { id: "345678901234567890", name: "Test Guild" },
    rawData: { id: "interaction-1", member: { roles: [] } },
    options: { getString: () => null, getNumber: () => null, getBoolean: () => null },
    responseState: "deferred",
    defer: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    client: {},
  };
}

it("carries current Team-admin authority through registered slash commands without bypassing admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      commands: { ownerAllowFrom: ["discord:999999999999999999"] },
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "345678901234567890": {
              channels: { "234567890123456789": { enabled: true, requireMention: false } },
            },
          },
        },
      },
      gateway: {
        auth: { identityScopes: { "ada@example.test": ["operator.admin"] } },
        roles: {
          default: "member",
          definitions: {
            admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
            member: {
              scopes: ["operator.read", "operator.write"],
              agents: "*",
              sessions: { others: "view" },
            },
          },
        },
      },
    };
    const profile = ensureProfileForEmail("ada@example.test");
    setUserProfileRole(profile.id, "admin");
    linkUserChannelIdentity(profile.id, {
      channelId: "discord",
      accountId: "default",
      senderId: "123456789012345678",
    });
    const gateway = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
    let live = true;
    const host = {
      channelId: "discord",
      record: {},
      epoch: {},
      isLive: () => live,
      resolveGatewayContext: () => gateway,
    };
    const dispatch = vi.fn<DispatchReplyFromConfig>(async ({ dispatcher }) => ({
      queuedFinal: dispatcher.sendFinalReply({ text: "accepted" }),
      counts: dispatcher.getQueuedCounts(),
    }));
    const createCommandOptions = (threadBindings: object) => ({
      command: { name: "ping", description: "Ping", acceptsArgs: false },
      cfg,
      discordConfig: cfg.channels?.discord ?? {},
      accountId: "default",
      sessionPrefix: "discord:slash",
      ephemeralDefault: true,
      threadBindings,
      buildContext: createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        host,
      ),
      dispatchReplyFromConfig: dispatch,
    });
    const { createDiscordNativeCommand, createNoopThreadBindingManager, setDiscordRuntime } =
      await loadBundledPluginFacade<{
        createDiscordNativeCommand: (options: ReturnType<typeof createCommandOptions>) => {
          run: (interaction: ReturnType<typeof createInteraction>) => Promise<void>;
        };
        createNoopThreadBindingManager: (accountId: string) => object;
        setDiscordRuntime: (runtime: PluginRuntime) => void;
      }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
    setDiscordRuntime(
      createPluginRuntimeMock({
        channel: {
          inbound: {
            ingress: createHostChannelIngressRuntime(host),
          },
        },
      }),
    );
    const run = async () => {
      setRuntimeConfigSnapshot(cfg, cfg);
      dispatch.mockClear();
      const command = createDiscordNativeCommand(
        createCommandOptions(createNoopThreadBindingManager("default")),
      );
      const interaction = createInteraction();
      await command.run(interaction);
      return interaction;
    };
    const expectDenied = async () => {
      expect((await run()).followUp).toHaveBeenCalledWith({
        content: "You are not authorized to use this command.",
        ephemeral: true,
      });
      expect(dispatch).not.toHaveBeenCalled();
    };
    try {
      await run();
      expect(dispatch).toHaveBeenCalledOnce();
      const ctx = dispatch.mock.calls[0]![0].ctx;
      expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true })).toMatchObject({
        senderIsOwner: true,
        isAuthorizedSender: true,
      });
      cfg.commands!.allowFrom = { discord: [] };
      await expectDenied();
      delete cfg.commands!.allowFrom;
      setUserProfileRole(profile.id, "member");
      await expectDenied();
      expect(resolveCommandAuthorization({ ctx, cfg, commandAuthorized: true }).senderIsOwner).toBe(
        false,
      );
    } finally {
      live = false;
    }
  });
});
