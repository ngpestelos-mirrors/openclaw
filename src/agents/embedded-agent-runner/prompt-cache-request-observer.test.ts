import * as cryptoDigest from "@openclaw/normalization-core/node-crypto";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { withEnv } from "../../test-utils/env.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";

let testScope = 0;
let currentTestScope = "";

function scopedKey(value: string): string {
  return `request-observer:${value}:${currentTestScope}`;
}

describe("prompt cache request observer", () => {
  beforeEach(() => {
    currentTestScope = String(++testScope);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps concurrent review and foreground usage in their own diagnostic sessions", () => {
    const promptCacheKey = scopedKey("shared-provider-affinity");
    const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;
    const context = { systemPrompt: "stable", messages: [] };
    const foregroundResult = vi.fn();
    const reviewResult = vi.fn();
    const foreground = createPromptCacheRequestObserver(
      { sessionId: scopedKey("foreground"), promptCacheKey, streamStrategy: "test" },
      foregroundResult,
    );
    const review = createPromptCacheRequestObserver(
      { sessionId: scopedKey("review"), promptCacheKey, streamStrategy: "test" },
      reviewResult,
    );
    review.onModelRequest(model, context);
    foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 9_000 });
    review.onModelUsage({ cacheRead: 0, input: 1_000 });
    expect(review.getObservation()).toMatchObject({ broke: false });
    foreground.onModelRequest(model, context);
    foreground.onModelUsage({ cacheRead: 2_000 });
    expect(foreground.getObservation()).toMatchObject({
      broke: true,
      previousCacheRead: 9_000,
      cacheRead: 2_000,
    });
  });

  it.each([
    ["system", { instructions: "provider rewritten system" }],
    ["tools", { tools: [{ type: "function", name: "changed" }] }],
    ["tools", { tools: [{ name: "read", type: "function" }] }],
    ["message:0.content", { input: [{ role: "user", content: "private rewritten history" }] }],
    ["message:0.role", { input: [{ role: "assistant", content: "first" }] }],
    ["message:0.id", { input: [{ role: "user", content: "first", id: "private-id" }] }],
    [
      "message:0.encrypted_content",
      { input: [{ role: "user", content: "first", encrypted_content: "private-ciphertext" }] },
    ],
    ["message:0.order", { input: [{ content: "first", role: "user" }] }],
    [
      "message:0.other",
      { input: [{ role: "user", content: "first", "private-field-name": "private-value" }] },
    ],
    ["message:0.removed", { input: [] }],
    ["parameters:reasoning", { reasoning: { effort: "high" } }],
    ["parameters:prompt_cache_key", { prompt_cache_key: "private-affinity" }],
    ["parameters:prompt_cache_retention", { prompt_cache_retention: "24h" }],
    ["parameters:prompt_cache_options", { prompt_cache_options: { ttl: "30m" } }],
    ["parameters:store", { store: false }],
    ["parameters:include", { include: ["reasoning.encrypted_content"] }],
    ["parameters:truncation", { truncation: "disabled" }],
    ["parameters:service_tier", { service_tier: "default" }],
    ["parameters:metadata", { metadata: { "private-name": "private-value" } }],
    ["parameters:other", { "private-parameter-name": "private-value" }],
    ["continuation:parameters:previous_response_id", { previous_response_id: "private-response" }],
    [
      "continuation:wire-input:0.content,parameters:previous_response_id",
      {
        previous_response_id: "private-response",
        input: [{ role: "user", content: "private-delta" }],
      },
    ],
    [
      "prefix-match",
      {
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "appended" },
        ],
      },
    ],
  ] as const)(
    "identifies final encoded %s changes despite unchanged assembled context",
    (expected, replacement) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const observer = createPromptCacheRequestObserver(
        { sessionId: scopedKey(`wire-${expected}`), streamStrategy: "test" },
        () => {},
      );
      const payload = {
        instructions: "original system",
        tools: [{ type: "function", name: "read" }],
        input: [{ role: "user", content: "first" }],
        reasoning: { effort: "low" },
      };
      const request = (body: unknown, cacheRead: number) => {
        observer.onModelRequest(
          { provider: "openai", id: "test-model", api: "openai-responses" },
          { systemPrompt: "original system", messages: [] },
        );
        const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
          payload: body,
          encode: true,
        });
        observer.onModelUsage(
          {
            cacheRead,
            contextUsage: { state: "available", promptTokens: 10_000, totalTokens: 10_100 },
          },
          { scopeDigest: "same-provider-scope", ...fingerprint },
        );
        expect(JSON.stringify(fingerprint)).not.toContain("private");
      };
      request(payload, 9_000);
      clock.mockReturnValue(3_000);
      request({ ...payload, ...replacement }, 2_000);
      expect(observer.getObservation()).toMatchObject({
        broke: true,
        changes: null,
        providerPrefix: expected,
        requestGapMs: 2_000,
        promptTokens: 10_000,
      });
      expect(JSON.stringify(observer.getObservation())).not.toContain("private");
    },
  );

  it("keeps a two-turn tool loop append-only with bounded block hashing", () => {
    withEnv({ OPENCLAW_PROMPT_CACHE_ASSERT: "1" }, () => {
      const sessionId = scopedKey("two-turn-loop");
      const source: AgentMessage[] = [
        { role: "user", content: [{ type: "text", text: "Read the fixture" }], timestamp: 1 },
        {
          role: "custom",
          customType: "fixture-context",
          content: [{ type: "text", text: "Fixture context" }],
          display: false,
          timestamp: 2,
        },
      ];
      const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
      const observed = vi.fn();
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        observed,
      );
      const request = () => {
        const messages = convertToLlm(source);
        observer.onModelRequest(
          { provider: "openai", id: "test-model", api: "openai-responses" },
          { messages },
        );
        observer.onModelUsage({ cacheRead: 8_000 });
        return messages;
      };
      const first = request();
      source.push(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
          stopReason: "toolUse",
          timestamp: 3,
        }),
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "fixture result" }],
          isError: false,
          timestamp: 4,
        },
      );
      const loop = request();
      source.push(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "Read complete" }],
          timestamp: 5,
        }),
        { role: "user", content: "Summarize it", timestamp: 6 },
      );
      request();
      expect(loop[0]).toBe(first[0]);
      expect(loop[1]).not.toBe(first[1]);
      expect(loop[1]?.content).toBe(first[1]?.content);
      for (const text of ["Read the fixture", "Fixture context", "fixture result"]) {
        expect(
          hashes.mock.calls.filter(([value]) => typeof value === "string" && value.includes(text)),
        ).toHaveLength(1);
      }
      expect(observed).toHaveBeenCalledTimes(3);
      for (const [observation] of observed.mock.calls) {
        expect(observation.changes).toBeNull();
      }
    });
  });

  it.each([
    {
      name: "three healthy calls then one",
      turns: [[10_000, 10_000, 10_000], [10_000]],
      misses: [],
    },
    {
      name: "one call then a miss and two hits",
      turns: [[10_000], [0, 10_000, 10_000]],
      misses: ["2:1"],
    },
    { name: "a complete miss below the drop threshold", turns: [[500], [0]], misses: ["2:1"] },
  ])("observes each request: $name", ({ turns, misses }) => {
    const sessionId = scopedKey("request-usage");
    const observed: Array<{ request: string; cacheRead: number | undefined; broke: boolean }> = [];
    for (const [turnIndex, reads] of turns.entries()) {
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        (observation) =>
          observed.push({
            request: `${turnIndex + 1}:${observation.requestIndex}`,
            cacheRead: observation.cacheRead,
            broke: observation.broke,
          }),
      );
      for (const cacheRead of reads) {
        observer.onModelRequest(
          { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
          {
            messages: [],
            systemPrompt: "stable prefix",
            tools: [{ name: "read", description: "Read text", parameters: Type.Object({}) }],
          },
        );
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
      }
    }
    expect(observed.map((entry) => entry.cacheRead)).toEqual(turns.flat());
    expect(observed.filter((entry) => entry.broke).map((entry) => entry.request)).toEqual(misses);
  });
});
