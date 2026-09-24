import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-outbound";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import type { ChannelPlugin, PluginRuntime } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import type { ResolvedFeishuAccount } from "./types.js";

export const feishuGatewayAdapter: NonNullable<ChannelPlugin<ResolvedFeishuAccount>["gateway"]> = {
  startAccount: async (ctx) => {
    const { monitorFeishuProvider } = await import("./monitor.js");
    const account = resolveFeishuRuntimeAccount(
      { cfg: ctx.cfg, accountId: ctx.accountId },
      { requireEventSecrets: true },
    );
    const port = account.config?.connectionMode === "webhook" ? resolveGatewayPort(ctx.cfg) : null;
    ctx.setStatus({ accountId: ctx.accountId, port });
    ctx.log?.info(
      `starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`,
    );
    const statusSink = createAccountStatusSink({
      accountId: ctx.accountId,
      setStatus: ctx.setStatus,
    });
    return monitorFeishuProvider({
      config: ctx.cfg,
      runtime: ctx.runtime,
      // Gateway provides the full channel runtime here; the public SDK type
      // stays context-only for external compatibility.
      channelRuntime: ctx.channelRuntime as PluginRuntime["channel"] | undefined,
      abortSignal: ctx.abortSignal,
      accountId: ctx.accountId,
      statusSink,
    });
  },
};
