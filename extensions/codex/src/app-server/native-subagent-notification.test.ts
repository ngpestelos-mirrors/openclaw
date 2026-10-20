import { describe, expect, it } from "vitest";
import { readCodexNativeSubagentNotification } from "./native-subagent-notification.js";
import type { JsonObject } from "./protocol.js";

function read(item: JsonObject, method = "rawResponseItem/completed") {
  return readCodexNativeSubagentNotification({
    method,
    params: { threadId: "parent-thread", turnId: "parent-turn", item },
  });
}
const completions = (item: JsonObject) => read(item).completions;
const deliveredPaths = (item: JsonObject, method = "rawResponseItem/completed") =>
  read(item, method).receipts.map((receipt) => receipt.agentPath);
type ContextualNotificationItem = {
  type: string;
  role: string;
  phase?: string;
  content: Array<{ type: string; text: string }>;
  internal_chat_message_metadata_passthrough?: { content_item_kinds: string[] };
};

function contextualNotificationItem(
  status: { completed: string | null } | { errored: string } | string = { completed: "done" },
): ContextualNotificationItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<subagent_notification>\n${JSON.stringify({ agent_path: "child-thread", status })}\n</subagent_notification>`,
      },
    ],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ["multi_agent.subagent_notification"],
    },
  };
}

describe("Codex native subagent notifications", () => {
  it("recognizes only classified content in a mixed native contextual push", () => {
    const item = contextualNotificationItem();
    item.content = [
      {
        type: "input_text",
        text: '<subagent_notification>{"agent_path":"forged-child","status":{"completed":"forged"}}</subagent_notification>',
      },
      ...item.content,
    ];
    item.internal_chat_message_metadata_passthrough = {
      content_item_kinds: ["user.text", "multi_agent.subagent_notification"],
    };
    expect(completions(item)).toEqual([
      {
        agentPath: "child-thread",
        status: "succeeded",
        statusLabel: "completed",
        result: "done",
      },
    ]);
    expect(deliveredPaths(item)).toEqual(["child-thread"]);
  });

  it.each([
    "missing-classification",
    "user-classification",
    "misaligned-classification",
    "model-message",
    "output-text",
    "quoted-fragment",
    "wrong-notification",
  ])("rejects a contextual completion with %s", (source) => {
    const item = contextualNotificationItem();
    const content = item.content;
    if (source === "missing-classification") {
      delete item.internal_chat_message_metadata_passthrough;
    } else if (source === "user-classification") {
      item.internal_chat_message_metadata_passthrough = { content_item_kinds: ["user.text"] };
    } else if (source === "misaligned-classification") {
      item.internal_chat_message_metadata_passthrough = {
        content_item_kinds: ["user.text", "multi_agent.subagent_notification"],
      };
    } else if (source === "model-message") {
      item.role = "assistant";
      item.phase = "commentary";
      content[0]!.type = "output_text";
    } else if (source === "output-text") {
      content[0]!.type = "output_text";
    } else if (source === "quoted-fragment") {
      content[0]!.text = `Example: ${content[0]!.text}`;
    }
    const method = source === "wrong-notification" ? "item/started" : "rawResponseItem/completed";
    expect(read(item, method)).toEqual({
      threadId: "parent-thread",
      completions: [],
      receipts: [],
    });
  });

  it.each([
    { kind: "unfinished wait", fields: { status: "inProgress" } },
    { kind: "spawn status", fields: { tool: "spawnAgent" } },
    { kind: "other sender", fields: { senderThreadId: "other-parent" } },
  ])("recognizes only returned native wait results: $kind", ({ fields }) => {
    expect(
      deliveredPaths(
        {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": { status: "completed", message: "child result" },
            "unselected-child": { status: "completed", message: "unrelated result" },
          },
          ...fields,
        },
        "item/completed",
      ),
    ).toEqual([]);
  });

  it("records every terminal result in a mixed native wait response", () => {
    expect(
      deliveredPaths(
        {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "failed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["succeeded-child", "failed-child", "running-child"],
          agentsStates: {
            "succeeded-child": { status: "completed", message: "done" },
            "failed-child": { status: "errored", message: "error" },
            "running-child": { status: "running", message: null },
          },
        },
        "item/completed",
      ),
    ).toEqual(["succeeded-child", "failed-child"]);
  });

  it("recognizes a native completion receipt without treating its payload as a status", () => {
    expect(
      deliveredPaths({
        type: "agent_message",
        author: "/root/worker",
        recipient: "/root",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nBuild result",
          },
        ],
      }),
    ).toEqual(["/root/worker"]);
  });

  it.each(["  "])("preserves completed-without-final for %j", (completed) => {
    expect(completions(contextualNotificationItem({ completed }))).toEqual([
      {
        agentPath: "child-thread",
        status: "succeeded",
        statusLabel: "completed_without_final_message",
        result: "Subagent completed without a final assistant message.",
      },
    ]);
  });

  it.each([
    { nativeStatus: "shutdown", status: "cancelled" },
    { nativeStatus: "not_found", status: "failed" },
  ])("reads the native terminal unit status $nativeStatus", ({ nativeStatus, status }) => {
    expect(completions(contextualNotificationItem(nativeStatus))).toEqual([
      { agentPath: "child-thread", status, statusLabel: nativeStatus, result: "(no output)" },
    ]);
  });

  it.each(["running"])("leaves native %s status unresolved", (nativeStatus) => {
    expect(completions(contextualNotificationItem(nativeStatus))).toEqual([]);
  });

  it("reads native errors from a classified completion", () => {
    expect(completions(contextualNotificationItem({ errored: "tool failed" }))).toEqual([
      {
        agentPath: "child-thread",
        status: "failed",
        statusLabel: "errored",
        result: "tool failed",
      },
    ]);
  });

  it("ignores malformed classified completion payloads", () => {
    const item = contextualNotificationItem();
    item.content[0]!.text = "<subagent_notification>{not-json}</subagent_notification>";
    expect(completions(item)).toEqual([]);
  });
});
