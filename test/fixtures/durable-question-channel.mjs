/** Synthetic platform transport, using only the normal native Channel Plugin SDK. */
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dispatchInboundDirectDm } from "openclaw/plugin-sdk/channel-inbound";

const channel = "durable-proof";
export default {
  id: channel,
  register(api) {
    const config = api.pluginConfig;
    const send = async (text, to = "sender") => {
      const response = await fetch(config.sinkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, to }),
      });
      if (!response.ok) throw new Error("Synthetic platform delivery failed");
      return { channel, messageId: `proof-${crypto.randomUUID()}`, to };
    };
    api.registerChannel({
      plugin: {
        id: channel,
        meta: {
          id: channel,
          label: "Durable proof",
          selectionLabel: "Durable proof",
          docsPath: "/channels/durable-proof",
          blurb: "Test platform",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["team"],
          resolveAccount: () => ({ accountId: "team" }),
          isEnabled: () => true,
          isConfigured: () => true,
          formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
        },
        outbound: {
          deliveryMode: "direct",
          deliveryCapabilities: { durableFinal: { text: true, messageSendingHooks: true } },
          sendText: async ({ text, to, assertDirectAdapterHandoff, onPlatformSendDispatch }) => {
            await onPlatformSendDispatch?.();
            assertDirectAdapterHandoff?.();
            return await send(text, to);
          },
        },
        gateway: {
          startAccount: async (ctx) => {
            const server = createServer((request, response) => {
              void (async () => {
                if (
                  request.url !== "/inbound" ||
                  request.headers.authorization !== `Bearer ${config.transportToken}`
                ) {
                  response.writeHead(403).end();
                  return;
                }
                const chunks = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const { text } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                await dispatchInboundDirectDm({
                  cfg: ctx.cfg,
                  channel,
                  channelLabel: "Durable proof",
                  accountId: "team",
                  peer: { kind: "direct", id: "sender" },
                  senderId: "sender",
                  senderAddress: `${channel}:sender`,
                  recipientAddress: `${channel}:bot`,
                  conversationLabel: "Proof sender",
                  rawBody: text,
                  messageId: crypto.randomUUID(),
                  channelRuntime: ctx.channelRuntime,
                  resolveChannelIngress: (contextBinding) =>
                    ctx.channelRuntime.inbound.ingress.resolveStable({
                      channelId: channel,
                      accountId: "team",
                      cfg: ctx.cfg,
                      identity: {
                        key: "proof-sender",
                        authentication: "verified",
                        normalizeEntry: String,
                        normalizeSubject: String,
                        sensitivity: "pii",
                        entryIdPrefix: "proof",
                      },
                      subject: { stableId: "sender" },
                      conversation: { kind: "direct", id: "sender" },
                      contextBinding,
                      dmPolicy: "allowlist",
                      groupPolicy: "disabled",
                      allowFrom: ["sender"],
                      useDefaultPairingStore: false,
                    }),
                  deliver: async (payload) => {
                    if (payload.text) await send(payload.text);
                  },
                  onRecordError: (error) => {
                    throw error;
                  },
                  onDispatchError: (error) => {
                    throw error;
                  },
                });
                response.writeHead(200).end("admitted");
              })().catch((error) => {
                response.writeHead(500).end(String(error));
              });
            });
            await new Promise((resolve, reject) => {
              server.once("error", reject);
              server.listen(0, "127.0.0.1", resolve);
            });
            await writeFile(config.readyPath, JSON.stringify({ port: server.address().port }));
            ctx.setStatus({ accountId: "team", running: true, connected: true });
            try {
              await new Promise((resolve) => {
                if (ctx.abortSignal.aborted) resolve();
                else ctx.abortSignal.addEventListener("abort", resolve, { once: true });
              });
            } finally {
              server.closeAllConnections();
              await new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
            }
          },
        },
      },
    });
  },
};
