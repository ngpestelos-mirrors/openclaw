import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { CodexHistoryRejection } from "./history-rejection.js";
import { projectSettledCodexMessages } from "./settled-turn-projection.js";
import { attachUpstreamUserText } from "./upstream-prompt-provenance.js";

function message(value: unknown): AgentMessage {
  return value as AgentMessage;
}

function toolCall(id = "call-1", name = "message"): AgentMessage {
  return message({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id, name, arguments: { action: "send" } },
    ],
  });
}

function toolResult(
  id = "call-1",
  content: unknown = [{ type: "text", text: "Message sent." }],
  name = "message",
): AgentMessage {
  return message({
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content,
  });
}

describe("projectSettledCodexMessages", () => {
  it.each([
    {
      kind: "string",
      content: "This turn ended before a reply: connection interrupted.",
    },
    {
      kind: "text blocks",
      content: [{ type: "text", text: "This turn ended before a reply: connection interrupted." }],
    },
  ])("preserves durable custom notes as historical user context ($kind)", ({ content }) => {
    expect(
      projectSettledCodexMessages([
        message({
          role: "custom",
          customType: "run-failed-before-reply",
          content,
          display: true,
          __openclaw: { upstreamUserText: "User prompt metadata is not custom-note content." },
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "This turn ended before a reply: connection interrupted.",
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "Message sent." },
    ]);
  });

  it("projects a canonical completed tool exchange without exposing reasoning", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "Send the update." }),
        message({
          role: "assistant",
          content: [{ type: "text", text: "I’ll send it now." }],
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Send the update." }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll send it now." }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "message",
        arguments: '{"action":"send"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Message sent.",
      },
    ]);
  });

  it("accepts Codex's enriched mirrored tool-result block", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          {
            type: "toolResult",
            toolCallId: "call-1",
            content: "Telegram delivery complete.",
          },
        ]),
      ]),
    ).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Telegram delivery complete.",
      },
    ]);
  });

  it.each([
    "codex_apps.slack.slack_read_thread",
    "codex_apps.slack.slack_send",
    `server.${"x".repeat(121)}`,
  ])("projects API-safe history with the original identity for %s", (name) => {
    const messages = [
      message({
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name, arguments: { channel: "C1" } }],
      }),
      message({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: name,
        content: [{ type: "text", text: "Sent." }],
      }),
    ];
    const projected = projectSettledCodexMessages(messages);
    expect(projected).toEqual([
      {
        type: "function_call",
        call_id: "call-1",
        name: expect.stringMatching(/^[a-zA-Z0-9_-]{1,128}$/u),
        arguments: '{"channel":"C1"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: `[Recorded tool: ${name}]\nSent.`,
      },
    ]);
    expect(projected[0]).toMatchObject({
      name: expect.stringMatching(/^openclaw_history_[a-zA-Z0-9_-]+_[a-f0-9]{64}$/u),
    });
    expect(projectSettledCodexMessages(messages)).toEqual(projected);
  });

  it("keeps distinct identities when readable aliases collide or a source name matches an alias", () => {
    const names = ["a.b", "a..b", "a_.b", "a_b"];
    const firstCall = projectSettledCodexMessages([
      toolCall("first", names[0]),
      toolResult("first", undefined, names[0]),
    ])[0];
    if (
      !firstCall ||
      typeof firstCall !== "object" ||
      Array.isArray(firstCall) ||
      typeof firstCall.name !== "string"
    ) {
      throw new Error("Expected a projected function call.");
    }
    names.push(firstCall.name);
    const projected = projectSettledCodexMessages(
      names.flatMap((name, index) => [
        toolCall(`call-${index}`, name),
        toolResult(`call-${index}`, undefined, name),
      ]),
    );
    expect(projected).toEqual(
      names.flatMap((name, index) => [
        {
          type: "function_call",
          call_id: `call-${index}`,
          name: name === "a_b" ? name : expect.stringMatching(/^[a-zA-Z0-9_-]{1,128}$/u),
          arguments: '{"action":"send"}',
        },
        {
          type: "function_call_output",
          call_id: `call-${index}`,
          output: name === "a_b" ? "Message sent." : `[Recorded tool: ${name}]\nMessage sent.`,
        },
      ]),
    );
    const projectedNames = projected.flatMap((item) =>
      item && typeof item === "object" && !Array.isArray(item) && item.type === "function_call"
        ? [item.name]
        : [],
    );
    expect(new Set(projectedNames).size).toBe(names.length);
  });

  it("rejects invalid tool names without including transcript text", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bad tool", arguments: {} }],
        }),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bad tool",
          content: [{ type: "text", text: "failed" }],
        }),
      ]),
    ).toThrowError(new CodexHistoryRejection("invalid_content"));
  });

  it("preserves failed tool-result status in the projected output", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [{ type: "text", text: "Delivery failed." }],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nDelivery failed.",
    });
  });

  it("preserves an empty failed tool result as failure evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "message",
          isError: true,
          content: [],
        }),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "[Tool result status: error]\nTool failed without textual output.",
    });
  });

  it.each(["message", "codex_apps.slack.slack_read_thread"])(
    "preserves maximum-size failed evidence with projection metadata for %s",
    (name) => {
      const resultText = "x".repeat(64 * 1024);
      const output = projectSettledCodexMessages([
        toolCall("call-1", name),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: name,
          isError: true,
          content: [{ type: "text", text: resultText }],
        }),
      ]).at(-1) as { output?: string };

      const identity = name === "message" ? "" : `[Recorded tool: ${name}]\n`;
      expect(output.output).toBe(`[Tool result status: error]\n${identity}${resultText}`);
    },
  );

  it("preserves exact whitespace in projected transcript text", () => {
    expect(
      projectSettledCodexMessages([
        message({ role: "user", content: "  user input\n" }),
        message({ role: "assistant", content: [{ type: "text", text: "\tassistant output\n" }] }),
        toolCall(),
        toolResult("call-1", [{ type: "text", text: "  tool output\n" }]),
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "  user input\n" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "\tassistant output\n" }],
      },
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "  tool output\n",
      },
    ]);
  });

  it.each([
    { count: 205, text: "old", error: "item_limit" },
    { count: 9, text: "x".repeat(60 * 1024), error: "byte_limit" },
  ])("stops acquiring later payloads after $error", ({ count, text, error }) => {
    let laterReads = 0;
    const later = message({
      role: "user",
      get content() {
        laterReads += 1;
        return "must not acquire this later payload";
      },
    });
    const oldMessages = Array.from({ length: count }, () =>
      message({ role: "user", content: text }),
    );
    expect(() =>
      projectSettledCodexMessages([...oldMessages, later, toolCall(), toolResult()]),
    ).toThrow(error);
    expect(laterReads).toBe(0);
  });

  it("prefers the undecorated upstream user text", () => {
    expect(
      projectSettledCodexMessages([
        message({
          role: "user",
          content: "[Telegram metadata] decorated prompt",
          __openclaw: { upstreamUserText: "Send the Aurora notice to Erin." },
        }),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Send the Aurora notice to Erin." }],
    });
  });

  it("preserves upstream user text above the ordinary message limit", () => {
    const upstreamUserText = "x".repeat(64 * 1024 + 1);

    expect(
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          upstreamUserText,
        ),
        toolCall(),
        toolResult(),
      ])[0],
    ).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: upstreamUserText }],
    });
  });

  it("rejects upstream user text above the projection limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "[Telegram metadata] decorated prompt" }),
          "x".repeat(512 * 1024 + 1),
        ),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("field_limit");
  });

  it("charges upstream user text against the aggregate byte limit", () => {
    expect(() =>
      projectSettledCodexMessages([
        attachUpstreamUserText(
          message({ role: "user", content: "decorated" }),
          "x".repeat(400 * 1024),
        ),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        message({ role: "user", content: "x".repeat(60 * 1024) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("byte_limit");
  });

  it("does not let provenance hide non-text user content", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({
          role: "user",
          content: [
            { type: "text", text: "Send the notice." },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
          __openclaw: { upstreamUserText: "Send the notice." },
        }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("unsupported_user_image");
  });

  it.each([
    { name: "orphan result", messages: [toolResult()] },
    { name: "missing result", messages: [toolCall()] },
    { name: "duplicate call id", messages: [toolCall(), toolCall(), toolResult()] },
    {
      name: "different source names with the same sanitized spelling",
      messages: [toolCall("call-1", "a.b"), toolResult("call-1", undefined, "a_b")],
    },
    {
      name: "tool-name mismatch",
      messages: [
        toolCall(),
        message({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "different",
          content: [{ type: "text", text: "done" }],
        }),
      ],
    },
  ])("fails closed for $name", ({ messages }) => {
    expect(() => projectSettledCodexMessages(messages)).toThrowError(CodexHistoryRejection);
  });

  it("preserves valid image tool results as bounded non-vision evidence", () => {
    expect(
      projectSettledCodexMessages([
        toolCall(),
        toolResult("call-1", [
          { type: "text", text: "Generated the requested asset." },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ]),
      ]).at(-1),
    ).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "Generated the requested asset.\n[Image tool result: image/png]",
    });
  });

  it("rejects oversized text instead of truncating it", () => {
    expect(() =>
      projectSettledCodexMessages([
        message({ role: "user", content: "x".repeat(64 * 1024 + 1) }),
        toolCall(),
        toolResult(),
      ]),
    ).toThrow("field_limit");
  });

  it("rejects a complete transcript above the aggregate byte limit", () => {
    const messages = Array.from({ length: 9 }, () =>
      message({ role: "user", content: "x".repeat(60 * 1024) }),
    );
    expect(() => projectSettledCodexMessages([...messages, toolCall(), toolResult()])).toThrow(
      "byte_limit",
    );
  });
});
