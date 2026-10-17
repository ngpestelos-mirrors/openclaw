/** Tests diagnostic cache-trace event writing, redaction, and stream wrapping. */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
  const bareAwsKey = "AKIAIOSFODNN7EXAMPLE"; // pragma: allowlist secret
  const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
  const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret
  const barePerplexityKey = "pplx-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret

  function createMemoryTraceForTest(
    overrides: Partial<Parameters<typeof createCacheTrace>[0]> = {},
  ) {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: { diagnostics: { cacheTrace: { enabled: true } } },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
      ...overrides,
    });
    return { lines, trace };
  }

  function readEvent(lines: string[], index = 0): Record<string, unknown> {
    return JSON.parse(lines[index]?.trim() ?? "{}");
  }

  function expectNoSecrets(event: unknown, secrets: string[]) {
    const serialized = JSON.stringify(event);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  }

  it("returns null when diagnostics cache tracing is disabled", () => {
    const { trace } = createMemoryTraceForTest({ cfg: {} });
    expect(trace).toBeNull();
  });

  it.each(["dashboard"])(
    "does not record Incognito %s prompts even when content tracing is enabled",
    (surface) => {
      const { lines, trace } = createMemoryTraceForTest({
        env: { OPENCLAW_CACHE_TRACE: "1" },
        sessionKey: `agent:main:${surface}:incognito-private`,
      });
      trace?.recordStage("prompt:before", { prompt: "synthetic private prompt" });
      expect(lines).toEqual([]);
      expect(trace).toBeNull();
    },
  );

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const { lines, trace } = createMemoryTraceForTest();

    const wrapped = trace?.wrapStreamFn(((model: unknown, context: unknown, options: unknown) => ({
      model,
      context,
      options,
    })) as never);

    void wrapped?.(
      {
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-responses",
      } as never,
      {
        systemPrompt: "system prompt text",
        messages: [],
      } as never,
      {},
    );

    expect(readEvent(lines)).toMatchObject({
      stage: "stream:context",
      system: "system prompt text",
      systemDigest: expect.any(String),
    });
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("stream:context", {
      system: {
        provider: {
          apiKey: "sk-system-secret",
          baseUrl: "https://api.example.com",
          diagnosticText: bareAwsKey,
        },
      },
      model: {
        id: "test-model",
        apiKey: "sk-model-secret",
        tokenCount: 8192,
        diagnosticText: bareGoogleKey,
      },
      options: {
        apiKey: "sk-options-secret",
        diagnosticText: bareGithubKey,
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
        images: [{ type: "image", mimeType: "image/png", data: "QUJDRA==" }],
      },
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: {
            secretKey: "message-secret-key",
            label: "preserve-me",
          },
          content: [
            {
              type: "text",
              text: barePerplexityKey,
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "visible" }],
          providerReplay: {
            type: "openai-responses-compaction",
            data: "opaque-cache-trace-compaction",
          },
        },
      ] as unknown as [],
    });

    const event = readEvent(lines);
    const systemProvider =
      (event.system as { provider?: Record<string, unknown> } | undefined)?.provider ?? {};
    expect(systemProvider).toMatchObject({
      baseUrl: "https://api.example.com",
      diagnosticText: expect.any(String),
    });
    expect(event.model).toEqual({
      id: "test-model",
      tokenCount: 8192,
      diagnosticText: expect.any(String),
    });
    expect(event.options).toEqual({
      diagnosticText: expect.any(String),
      nested: {
        safe: "keep-me",
        tokenCount: 42,
      },
      images: "<redacted>",
    });

    const firstMessage = ((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0];
    expect(firstMessage).not.toHaveProperty("token");
    expect(firstMessage).not.toHaveProperty("metadata.secretKey");
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.metadata).toEqual({
      label: "preserve-me",
    });
    const content = (firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(content[0]).toEqual({
      type: "text",
      text: expect.any(String),
    });
    const source = (content[1]?.source ?? {}) as Record<string, unknown>;
    expect(source).toMatchObject({
      data: "<redacted>",
      bytes: 6,
      sha256: crypto.createHash("sha256").update("U0VDUkVU").digest("hex"),
    });
    expectNoSecrets(event, [
      "providerReplay",
      "opaque-cache-trace-compaction",
      bareAwsKey,
      bareGoogleKey,
      bareGithubKey,
      barePerplexityKey,
    ]);
  });

  it("redacts bare vendor keys from cache-trace prompt, note, and error fields", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("prompt:before", {
      prompt: `prompt ${bareAnthropicKey}`,
      note: `note ${bareGithubKey}`,
      error: `error ${bareGoogleKey}`,
    });

    const event = readEvent(lines);
    expect(event).toMatchObject({
      prompt: expect.any(String),
      note: expect.any(String),
      error: expect.any(String),
    });
    expectNoSecrets(event, [bareAnthropicKey, bareGithubKey, bareGoogleKey]);
  });

  it("handles circular references in messages without stack overflow", () => {
    const { lines, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    // Cache tracing must fingerprint cyclic prompt payloads instead of recursing forever.
    parent.child = child;

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const fingerprint = crypto
      .createHash("sha256")
      .update('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}')
      .digest("hex");
    const event = readEvent(lines);
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });

  it("fingerprints malformed and transport-normalized text identically", () => {
    const { lines, trace } = createMemoryTraceForTest();
    const high = String.fromCharCode(0xd83d);

    trace?.recordStage("prompt:before", {
      messages: [{ role: "user", content: `left${high}right`, timestamp: 1 }],
    });
    trace?.recordStage("prompt:images", {
      messages: [{ role: "user", content: "leftright", timestamp: 1 }],
    });

    expect(readEvent(lines).messageFingerprints).toEqual(readEvent(lines, 1).messageFingerprints);
  });
});
