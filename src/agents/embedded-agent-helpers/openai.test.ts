import type { AssistantMessage, ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { normalizeOpenAIResponsesToolCallIds as normalizeIds } from "./openai.js";

function buildAssistantToolCall(rawId: string): AssistantMessage {
  return makeAssistantMessageFixture({
    provider: "openrouter",
    model: "moonshotai/kimi-k2.5",
    stopReason: "toolUse",
    errorMessage: undefined,
    content: [{ type: "toolCall", id: rawId, name: "gateway", arguments: {} }],
  });
}

function buildToolResult(rawId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: rawId,
    toolName: "gateway",
    content: [],
    isError: false,
    timestamp: 0,
  };
}

function toolCallId(message: AgentMessage | undefined): string {
  const call =
    message?.role === "assistant"
      ? message.content.find((block) => block.type === "toolCall")
      : undefined;
  if (call?.type !== "toolCall") {
    throw new Error("expected assistant tool call id");
  }
  return call.id;
}

function expectResult(message: AgentMessage | undefined, id: string, alias = false) {
  expect(message).toMatchObject({
    role: "toolResult",
    toolCallId: id,
    ...(alias ? { toolUseId: id } : {}),
  });
}

describe("normalizeOpenAIResponsesToolCallIds", () => {
  it("passes canonical Responses ids through without allocating new messages", () => {
    const id = "call_gateway_0|fc_gateway_0";
    const messages = [buildAssistantToolCall(id), buildToolResult(id)];
    expect(normalizeIds(messages)).toBe(messages);
  });

  it("assigns distinct call ids to repeated native Kimi calls across turns", () => {
    const first = "functions.gateway:0|fc_tmp_kegospxl46";
    const second = "functions.gateway:0|fc_tmp_btw21n10glg";
    const [firstCall, firstResult, , secondCall, secondResult] = normalizeIds([
      buildAssistantToolCall(first),
      buildToolResult(first),
      { role: "user", content: "check again", timestamp: 1 },
      buildAssistantToolCall(second),
      buildToolResult(second),
    ]);
    const firstCallId = toolCallId(firstCall);
    const secondCallId = toolCallId(secondCall);
    expect(firstCallId).not.toBe(secondCallId);
    expectResult(firstResult, firstCallId);
    expectResult(secondResult, secondCallId);
  });

  it("strips a checkpoint when rekeying a pre-checkpoint tool call", () => {
    const rawId = "functions.gateway:0|fc_tmp_checkpoint";
    const owner = buildAssistantToolCall(rawId);
    owner.content.push({ type: "text", text: "after checkpoint" });
    owner.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_replay",
      data: "opaque-checkpoint",
      replayIndex: 1,
      provider: "openrouter",
      api: "openai-responses",
      model: "moonshotai/kimi-k2.5",
    };
    const [rewrittenOwner, rewrittenResult] = normalizeIds([owner, buildToolResult(rawId)]);

    expect(rewrittenOwner).not.toHaveProperty("providerReplay");
    expectResult(rewrittenResult, toolCallId(rewrittenOwner));
  });

  it("normalizes mixed result aliases and incomplete persisted pairings independently", () => {
    const pairedId = "functions.gateway:0|fc_tmp_paired";
    const assistantOnlyId = "functions.read:0|fc_tmp_assistant_only";
    const resultOnlyId = "functions.exec:0|fc_tmp_result_only";
    const aliasedResult = {
      ...buildToolResult(pairedId),
      toolUseId: pairedId,
    };
    const untouchedUser: AgentMessage = { role: "user", content: "continue", timestamp: 1 };

    const out = normalizeIds([
      aliasedResult,
      buildAssistantToolCall(pairedId),
      untouchedUser,
      buildAssistantToolCall(assistantOnlyId),
      buildToolResult(resultOnlyId),
    ]);

    const normalizedPairedId = toolCallId(out[1]);
    expectResult(out[0], normalizedPairedId, true);
    expect(out[2]).toBe(untouchedUser);
    expect(toolCallId(out[3])).toMatch(/^call_[A-Za-z0-9_-]+\|fc_[A-Za-z0-9_-]+$/);
    expect(out[4]).toMatchObject({
      role: "toolResult",
      toolCallId: expect.stringMatching(/^call_[A-Za-z0-9_-]+\|fc_[A-Za-z0-9_-]+$/),
    });
    expect(out[4]).not.toHaveProperty("toolCallId", toolCallId(out[3]));
  });

  it("backfills and normalizes the toolUseId tool-result alias", () => {
    const rawId = "functions.gateway:0|fc_tmp_gateway";
    const { toolCallId: _toolCallId, ...result } = buildToolResult(rawId);
    const [assistant, rewritten] = normalizeIds([
      buildAssistantToolCall(rawId),
      { ...result, toolUseId: rawId } as AgentMessage,
    ]);
    const expectedId = toolCallId(assistant);

    expectResult(rewritten, expectedId, true);
  });
});
