import { describe, expect, it, vi } from "vitest";
import { createSlackSendReceipt } from "./send-results.js";

const sender = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({ sendMessageSlack: sender }));
const { slackOutbound } = await import("./outbound-adapter.js");

describe("Slack outbound physical receipts", () => {
  it.each(["sendText", "sendMedia"] as const)(
    "preserves scoped physical targets through %s",
    async (method) => {
      sender.mockResolvedValue({
        messageId: "123.456",
        channelId: "C999",
        teamId: "T999",
        receipt: createSlackSendReceipt({
          platformMessageIds: ["123.456"],
          channelId: "C999",
          teamId: "T999",
          kind: method === "sendMedia" ? "media" : "text",
          threadTs: "100.000",
        }),
      });
      const result = await slackOutbound[method]!({
        cfg: { channels: { slack: { botToken: "synthetic-test-token" } } },
        to: "team:T123:channel:C123",
        text: "answer",
        threadId: "100.000",
        mediaUrl: "https://example.invalid/synthetic.png",
      });
      expect(result).toMatchObject({
        channel: "slack",
        target: { kind: "channel", id: "team:T999:channel:C999" },
        receipt: { parts: [{ raw: { channelId: "team:T999:channel:C999" } }] },
      });
      expect(result).not.toHaveProperty("channelId");
    },
  );
});
