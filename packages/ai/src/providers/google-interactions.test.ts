import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context, Model, ToolCall } from "../types.js";
import { streamGoogleInteractions } from "./google-interactions.js";

function makeInteractionsModel(provider = "google"): Model<"google-interactions"> {
  return {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    api: "google-interactions",
    provider,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

describe("google-interactions provider", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const basicContext: Context = {
    messages: [{ role: "user", content: "Hello" }],
  };

  it("terminates outer stream loop immediately and cancels reader upon receiving data: [DONE]", async () => {
    let cancelCalled = false;
    const encoder = new TextEncoder();

    // ReadableStream that delivers a text delta and [DONE], then hangs forever unless cancelled
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"event_type":"step.delta","delta":{"type":"text","text":"Hello world"}}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
      },
      cancel() {
        cancelCalled = true;
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    const events: unknown[] = [];
    for await (const event of eventStream) {
      events.push(event);
    }

    expect(cancelCalled).toBe(true);
    const doneEvent = events.find(
      (e): e is { type: "done"; message: { api: string; content: unknown[] } } =>
        Boolean(e && typeof e === "object" && (e as { type: string }).type === "done"),
    );
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.message.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("initializes assistant output with api='google-interactions' and emits events with matching api", async () => {
    const encoder = new TextEncoder();
    const ssePayload =
      'data: {"event_type":"step.delta","delta":{"type":"text","text":"Output test"}}\n\n' +
      "data: [DONE]\n\n";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(encoder.encode(ssePayload), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    const receivedEvents: Array<{ type: string; api?: string }> = [];
    for await (const event of eventStream) {
      if (event.type === "start") {
        receivedEvents.push({ type: "start", api: event.partial.api });
      } else if (event.type === "text_delta") {
        receivedEvents.push({ type: "text_delta", api: event.partial.api });
      } else if (event.type === "text_end") {
        receivedEvents.push({ type: "text_end", api: event.partial.api });
      } else if (event.type === "done") {
        receivedEvents.push({ type: "done", api: event.message.api });
      }
    }

    expect(receivedEvents.length).toBeGreaterThan(0);
    for (const event of receivedEvents) {
      expect(event.api).toBe("google-interactions");
    }
  });

  it("resolves apiKey via getEnvApiKey(model.provider) when not provided in options", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-resolved-gemini-key");

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(new TextEncoder().encode("data: [DONE]\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel("google");
    const eventStream = streamGoogleInteractions(model, basicContext, {});

    for await (const event of eventStream) {
      void event;
    }

    expect(capturedHeaders).toBeDefined();
    expect((capturedHeaders as Record<string, string>)["x-goog-api-key"]).toBe(
      "env-resolved-gemini-key",
    );
  });

  it("resolves apiKey from environment when model.provider is 'google-interactions'", async () => {
    vi.stubEnv("GEMINI_API_KEY", "interactions-provider-key");

    let capturedHeaders: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers;
        return new Response(new TextEncoder().encode("data: [DONE]\n\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel("google-interactions");
    const eventStream = streamGoogleInteractions(model, basicContext, {});

    for await (const event of eventStream) {
      void event;
    }

    expect(capturedHeaders).toBeDefined();
    expect((capturedHeaders as Record<string, string>)["x-goog-api-key"]).toBe(
      "interactions-provider-key",
    );
  });

  it("keeps thought signatures on thinking blocks and does not attach them to toolCall blocks in streaming", async () => {
    const encoder = new TextEncoder();
    const ssePayload = [
      'data: {"event_type":"step.start","step":{"type":"thought","summary":[{"type":"text","text":"Reasoning about tool..."}]}}\n\n',
      'data: {"event_type":"step.delta","delta":{"type":"thought_signature","signature":"sig_stream_thought=="}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      'data: {"event_type":"step.start","step":{"type":"function_call","id":"call_99","name":"search","arguments":{"q":"gemini"}}}\n\n',
      'data: {"event_type":"step.stop"}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(encoder.encode(ssePayload), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const model = makeInteractionsModel();
    const eventStream = streamGoogleInteractions(model, basicContext, {
      apiKey: "test-api-key",
    });

    let doneMessage: AssistantMessage | null = null;
    for await (const event of eventStream) {
      if (event.type === "done") {
        doneMessage = event.message;
      }
    }

    expect(doneMessage).toBeDefined();
    expect(doneMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: "Reasoning about tool...",
        thinkingSignature: "sig_stream_thought==",
      },
      {
        type: "toolCall",
        id: "call_99",
        name: "search",
        arguments: { q: "gemini" },
      },
    ]);
    const toolCall = doneMessage?.content.find((c): c is ToolCall => c.type === "toolCall");
    expect(toolCall?.thoughtSignature).toBeUndefined();
  });
});
