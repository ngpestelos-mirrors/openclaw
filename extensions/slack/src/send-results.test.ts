import { describe, expect, it } from "vitest";
import {
  createSlackSendReceipt,
  mergeSlackSendResults,
  toSlackOutboundResult,
} from "./send-results.js";

function sent(teamId: string | undefined, channelId: string, messageId: string) {
  return {
    channelId,
    ...(teamId ? { teamId } : {}),
    messageId,
    receipt: createSlackSendReceipt({
      platformMessageIds: [messageId],
      channelId,
      teamId,
      kind: "text",
      threadTs: "123.456",
    }),
  };
}

describe("Slack physical delivery scope", () => {
  it("retains each part's actual destination and workspace through aggregation", () => {
    const result = toSlackOutboundResult(
      mergeSlackSendResults([
        sent("T123", "C123", "first"),
        sent("T123", "C999", "other-channel"),
        sent("T999", "C123", "other-workspace"),
      ]),
    );
    expect(result.target).toEqual({ kind: "channel", id: "team:T999:channel:C123" });
    expect(result.receipt.parts.map((part) => part.raw?.channelId)).toEqual([
      "team:T123:channel:C123",
      "team:T123:channel:C999",
      "team:T999:channel:C123",
    ]);
    expect(result.receipt.raw?.map((part) => part.channelId)).toEqual([
      "team:T123:channel:C123",
      "team:T123:channel:C999",
      "team:T999:channel:C123",
    ]);
    expect(result.receipt.platformMessageIds).toEqual([
      "first",
      "other-channel",
      "other-workspace",
    ]);
    expect(result.receipt.parts.map((part) => part.threadId)).toEqual([
      "123.456",
      "123.456",
      "123.456",
    ]);
  });

  it("preserves an explicitly contradictory receipt workspace", () => {
    const result = toSlackOutboundResult(sent("T123", "team:T999:channel:C123", "wrong-team"));
    expect(result.target).toEqual({ kind: "channel", id: "team:T999:channel:C123" });
    expect(result.receipt.parts[0]?.raw?.channelId).toBe("team:T999:channel:C123");
  });

  it("keeps legacy unscoped send results and receipts unqualified", () => {
    const result = toSlackOutboundResult(sent(undefined, "C123", "legacy"));
    expect(result.target).toEqual({ kind: "channel", id: "C123" });
    expect(result.receipt.parts[0]?.raw?.channelId).toBe("C123");
    expect(result).not.toHaveProperty("teamId");
  });
});
