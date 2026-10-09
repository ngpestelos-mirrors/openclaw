import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { createSlackSendReceipt } from "./send-results.js";

afterEach(() => vi.restoreAllMocks());

describe("Slack action physical receipts", () => {
  it.each([
    { action: "sendMessage", content: "answer" },
    { action: "uploadFile", filePath: "/tmp/synthetic-attachment.png" },
  ])("keeps the sender's attested scope for $action", async (action) => {
    const receipt = createSlackSendReceipt({
      platformMessageIds: ["123.456"],
      channelId: "C999",
      teamId: "T999",
      kind: action.action === "uploadFile" ? "media" : "text",
      threadTs: "100.000",
    });
    const sender = vi.spyOn(slackActionRuntime, "sendSlackMessage").mockResolvedValue({
      channelId: "C999",
      teamId: "T999",
      messageId: "123.456",
      receipt,
    });
    const result = await handleSlackAction(
      { ...action, to: "team:T123:channel:C123", threadTs: "100.000" },
      { channels: { slack: { botToken: "synthetic-test-token" } } },
      {
        currentChannelProvider: "slack",
        currentChannelId: "team:T123:channel:C123",
        requesterAccountId: "default",
      },
    );
    expect(sender).toHaveBeenCalledOnce();
    // A requested route cannot overwrite independently reported physical facts.
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        channelId: "team:T999:channel:C999",
        receipt: { parts: [{ raw: { channelId: "team:T999:channel:C999" } }] },
      },
    });
  });
});
