import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createGeminiEmbeddingProvider: vi.fn(),
  runGeminiEmbeddingBatches: vi.fn(async () => new Map([["0", [1, 0]]])),
}));

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return {
    ...actual,
    createGeminiEmbeddingProvider: mocks.createGeminiEmbeddingProvider,
  };
});

vi.mock("./embedding-batch.js", () => ({
  runGeminiEmbeddingBatches: mocks.runGeminiEmbeddingBatches,
}));

import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const MODEL = "gemini-embedding-2";
const VERSION = "openclaw/2026.7.1-beta.5";
const provider: MemoryEmbeddingProvider = {
  id: "gemini",
  model: MODEL,
  embed: async () => [1, 0],
  embedBatch: async (inputs) => inputs.map(() => [1, 0]),
};

const clientBase = {
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  model: MODEL,
  modelPath: "models/gemini-embedding-2",
  outputDimensionality: 768,
};

async function createAdapter(headers: Record<string, string>, version?: string) {
  mocks.createGeminiEmbeddingProvider.mockResolvedValueOnce({
    provider,
    client: {
      ...clientBase,
      headers: { ...headers, ...(version ? { "x-goog-api-client": version } : {}) },
    },
  });
  return await geminiMemoryEmbeddingProviderAdapter.create({
    config: {} as never,
    provider: "gemini",
    model: MODEL,
    fallback: "none",
  });
}

describe("Gemini memory embedding adapter", () => {
  beforeEach(() => {
    mocks.createGeminiEmbeddingProvider.mockReset();
    mocks.runGeminiEmbeddingBatches.mockClear();
  });

  it.each(["gemini-embedding-2", "gemini-embedding-2-preview"])(
    "accepts multimodal memory for %s",
    (model) => {
      expect(supportsMultimodal(model)).toBe(true);
    },
  );

  it("keeps legacy Gemini embeddings text-only", () => {
    expect(supportsMultimodal("gemini-embedding-001")).toBe(false);
  });

  it("formats stable Gemini asynchronous batch documents without a task type", async () => {
    const result = await createAdapter({});

    await result.runtime?.batchEmbed?.({
      agentId: "main",
      chunks: [{ text: "remember this" }],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      debug: () => {},
    });

    expect(mocks.runGeminiEmbeddingBatches).toHaveBeenCalledWith(
      expect.objectContaining({
        requests: [
          {
            custom_id: "0",
            request: {
              content: { parts: [{ text: "title: none | text: remember this" }] },
              model: "models/gemini-embedding-2",
              outputDimensionality: 768,
            },
          },
        ],
      }),
    );
  });

  it("keeps durable identity stable across generated client-version changes", async () => {
    const sharedHeaders = {
      "Content-Type": "application/json",
      "x-goog-api-key": "secret-key",
      Authorization: "Bearer token",
      "X-Custom-Region": "us-central1",
    };
    const older = await createAdapter(sharedHeaders, "openclaw/2026.6.11");
    const newer = await createAdapter(sharedHeaders, VERSION);

    expect(older.runtime?.cacheKeyData).toEqual(newer.runtime?.cacheKeyData);
    expect(older.runtime?.cacheKeyData?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["X-Custom-Region", "us-central1"],
    ]);
  });

  it("still invalidates identity when a semantic custom header changes", async () => {
    const first = await createAdapter(
      { "x-custom-endpoint": "https://example.invalid/a" },
      VERSION,
    );
    const second = await createAdapter(
      { "x-custom-endpoint": "https://example.invalid/b" },
      VERSION,
    );

    expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
  });
});

function supportsMultimodal(model: string) {
  return geminiMemoryEmbeddingProviderAdapter.supportsMultimodalEmbeddings?.({ model });
}
