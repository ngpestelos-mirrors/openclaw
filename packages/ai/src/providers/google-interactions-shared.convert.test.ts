import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import {
  buildGoogleInteractionsParams,
  resolveGoogleApiClientHeaders,
} from "./google-interactions-shared.js";
import { makeModel } from "./google-shared.test-helpers.js";

describe("buildGoogleInteractionsParams", () => {
  const model = makeModel("gemini-3-flash-preview");

  it("converts basic messages to user_input and model_output steps", () => {
    const context: Context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi there!" },
            { type: "thinking", thinking: "internal thoughts" },
          ],
        },
        { role: "user", content: "What is 2+2?" },
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.model).toBe("gemini-3-flash-preview");
    expect(params.system_instruction).toBe("You are a helpful assistant.");
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        type: "model_output",
        content: [{ type: "text", text: "Hi there!" }],
      },
      {
        type: "user_input",
        content: [{ type: "text", text: "What is 2+2?" }],
      },
    ]);
  });

  it("converts tools and tool calls/results", () => {
    const tools: Tool[] = [
      {
        name: "getWeather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const context: Context = {
      messages: [
        { role: "user", content: "Weather in Tokyo?" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_123",
              name: "getWeather",
              arguments: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_123",
          toolName: "getWeather",
          content: JSON.stringify({ temp: "20C" }),
        },
      ],
      tools,
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.tools).toEqual([
      {
        type: "function",
        name: "getWeather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Weather in Tokyo?" }],
      },
      {
        type: "function_call",
        id: "call_123",
        name: "getWeather",
        arguments: { city: "Tokyo" },
        signature: "skip_thought_signature_validator",
      },
      {
        type: "function_result",
        call_id: "call_123",
        name: "getWeather",
        result: JSON.stringify({ temp: "20C" }),
      },
    ]);
  });

  it("recirculates thinking blocks with thought signatures as thought steps", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "Solve this problem" },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me break down the steps.",
              thinkingSignature: "sig_step_1234==",
            },
            { type: "text", text: "Here is the answer." },
          ],
        },
        { role: "user", content: "Tell me more" },
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Solve this problem" }],
      },
      {
        type: "thought",
        signature: "sig_step_1234==",
        summary: [{ type: "text", text: "Let me break down the steps." }],
      },
      {
        type: "model_output",
        content: [{ type: "text", text: "Here is the answer." }],
      },
      {
        type: "user_input",
        content: [{ type: "text", text: "Tell me more" }],
      },
    ]);
  });

  it("attaches explicit thought signatures to function_call steps", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "Weather in Tokyo?" },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_123",
              name: "getWeather",
              arguments: { city: "Tokyo" },
              thoughtSignature: "sig_tool_call_token==",
            },
          ],
        },
      ],
    };

    const params = buildGoogleInteractionsParams(model, context, {});

    expect(params.input).toEqual([
      {
        type: "user_input",
        content: [{ type: "text", text: "Weather in Tokyo?" }],
      },
      {
        type: "function_call",
        id: "call_123",
        name: "getWeather",
        arguments: { city: "Tokyo" },
        signature: "sig_tool_call_token==",
      },
    ]);
  });

  it("resolves the documented Gemini API partner client header x-goog-api-client", () => {
    const headers = resolveGoogleApiClientHeaders({
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(headers["x-goog-api-client"]).toMatch(/^openclaw\//u);
  });

  it("rejects unsupported explicit prompt caching locally", () => {
    const context: Context = {
      messages: [{ role: "user", content: "Hello" }],
    };

    expect(() =>
      buildGoogleInteractionsParams(model, context, {
        cachedContent: "cachedContents/123",
      } as Record<string, unknown>),
    ).toThrow(/Explicit prompt caching/);
  });
});
