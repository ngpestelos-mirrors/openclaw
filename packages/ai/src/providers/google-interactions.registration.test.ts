import { afterEach, expect, it, vi } from "vitest";
import { createApiRegistry } from "../api-registry.js";
import { configureAiTransportHost } from "../host.js";
import { createLlmRuntime } from "../stream.js";
import type { Model } from "../types.js";
import { registerBuiltInApiProviders } from "./register-builtins.js";

afterEach(() => {
  configureAiTransportHost({});
  vi.restoreAllMocks();
});

it("dispatches the opt-in API through the registry without replacing Google or Vertex", async () => {
  const registry = createApiRegistry();
  registerBuiltInApiProviders(registry);
  expect(registry.getApiProvider("google-generative-ai")).toBeDefined();
  expect(registry.getApiProvider("google-vertex")).toBeDefined();
  const model: Model<"google-interactions"> = {
    id: "gemini-3.8-flash",
    name: "Gemini",
    api: "google-interactions",
    provider: "google-interactions",
    baseUrl: "https://generativelanguage.googleapis.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 65536,
  };
  const guardedFetch = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse");
    expect(new Headers(init?.headers).get("Api-Revision")).toBe("2026-05-20");
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized Interactions request body");
    }
    const body: unknown = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: model.id,
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty("previous_interaction_id");
    return new Response(
      'data: {"event_type":"interaction.completed","interaction":{"status":"completed"}}\n\ndata: [DONE]\n\n',
    );
  });
  configureAiTransportHost({ buildModelFetch: () => guardedFetch as typeof fetch });
  const result = await createLlmRuntime(registry).completeSimple(
    model,
    {
      messages: [{ role: "user", content: "Synthetic registration proof", timestamp: 0 }],
    },
    { apiKey: "synthetic-test-key", reasoning: "low" },
  );
  expect(result).toMatchObject({ api: "google-interactions", stopReason: "stop" });
  expect(guardedFetch).toHaveBeenCalledOnce();
});
