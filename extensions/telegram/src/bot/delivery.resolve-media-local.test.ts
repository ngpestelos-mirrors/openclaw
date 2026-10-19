import type * as Dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { Bot, Context } from "grammy";
import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "../bot.create-telegram-bot.test-support.js";
import { useTelegramHttpFixture } from "../send.telegram-http.test-support.js";
import { resolveMedia } from "./delivery.resolve-media.js";
import { makeCtx, requireResolvedMedia } from "./delivery.resolve-media.test-helpers.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof Dns>()),
  lookup,
}));

describe("Telegram media acquisition through grammY and the media store", () => {
  const fixture = useTelegramHttpFixture();
  let state: OpenClawTestState;
  let api: Api;
  let bytes: Buffer;
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "telegram-media-acquisition" });
    api = new Bot(fixture.cfg.channels.telegram.botToken, {
      client: { apiRoot: fixture.cfg.channels.telegram.apiRoot },
    }).api;
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    fixture.responseFor = (method) =>
      method === "getFile" ? { file_id: "file", file_path: "photos/file.png" } : undefined;
    bytes = await readFile(fixture.photoPath);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await state.cleanup();
  });
  const context = () => {
    const ctx = new Context(
      {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1736380800,
          chat: { id: 123, type: "private", first_name: "Ada" },
          from: { id: 123, is_bot: false, first_name: "Ada" },
          document: { file_id: "file", file_unique_id: "unique", file_name: "original.png" },
        },
      },
      api,
      telegramBotInfoForTest,
    );
    if (!ctx.has("message")) {
      throw new Error("Expected Telegram media message");
    }
    return ctx;
  };
  const pngFetch = async () =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
  const transport = (sourceFetch: typeof fetch = pngFetch) => ({
    fetch: sourceFetch,
    sourceFetch,
    close: async () => {},
  });
  const acquire = (overrides: Partial<Parameters<typeof resolveMedia>[0]> = {}) =>
    resolveMedia({
      ctx: context(),
      token: "fixture",
      apiRoot: fixture.cfg.channels.telegram.apiRoot,
      maxBytes: 1024,
      transport: transport(),
      ...overrides,
    });
  function onGetFile(callback: (ok: boolean) => void) {
    api.config.use(async (previous, method, payload, signal) => {
      const result = await previous(method, payload, signal);
      if (method === "getFile") {
        callback(result.ok);
      }
      return result;
    });
  }

  it("preserves actual bytes and the original filename after getFile recovery", async () => {
    const responses = [createDeferred<void>(), createDeferred<void>()];
    let attempts = 0;
    onGetFile(() => {
      responses[attempts++]?.resolve();
    });
    fixture.rejections.push(
      { error_code: 502, description: "Bad Gateway" },
      { error_code: 400, description: "Bad Request: file is temporarily unavailable" },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const acquiring = acquire({
      token: fixture.cfg.channels.telegram.botToken,
    });
    await responses[0]!.promise;
    await vi.advanceTimersByTimeAsync(1000);
    await responses[1]!.promise;
    await vi.advanceTimersByTimeAsync(2000);
    const media = await acquiring;
    expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile", "getFile", "getFile"]);
    expect(await readFile(media!.path)).toEqual(bytes);
    expect(media?.fileName).toBe("original.png");
  });

  it("does not retry a getFile size rejection", async () => {
    fixture.rejections.push({ error_code: 400, description: "Bad Request: file is too big" });
    await expect(acquire({ apiRoot: undefined, transport: undefined })).rejects.toMatchObject({
      code: "max_bytes",
      status: 400,
    });
    expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile"]);
  });

  it.each(["retry", "shutdown", "deadline"] as const)(
    "retains Telegram flood-wait custody through %s",
    async (mode) => {
      const response = createDeferred<void>();
      onGetFile((ok) => {
        if (!ok) {
          response.resolve();
        }
      });
      fixture.rejections.push({
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: mode === "deadline" ? 1200 : 60 },
      });
      const abort = new AbortController();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const acquiring = acquire({ abortSignal: abort.signal });
      const outcome = acquiring.then(
        (media) => ({ media }),
        (error: unknown) => ({ error }),
      );
      await response.promise;
      if (mode === "retry") {
        await vi.advanceTimersByTimeAsync(59999);
        expect(fixture.requests).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await outcome).toMatchObject({
          media: { contentType: "image/png" },
        });
        expect(fixture.requests).toHaveLength(2);
      } else {
        if (mode === "shutdown") {
          abort.abort();
        } else {
          await vi.advanceTimersByTimeAsync(1200000);
        }
        expect(await outcome).toMatchObject({ error: { code: "http_error", status: 429 } });
        expect(fixture.requests).toHaveLength(1);
      }
    },
  );

  it("cancels an in-progress media body rather than saving partial bytes", async () => {
    const reading = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
    const abort = new AbortController();
    const sourceFetch = vi.fn<typeof fetch>(async (_url, init) => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([137, 80, 78, 71]));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
            reading.resolve(controller);
          },
        }),
        { headers: { "content-type": "image/png" } },
      );
    });
    const acquiring = acquire({ abortSignal: abort.signal, transport: transport(sourceFetch) });
    const failure = expect(acquiring).rejects.toMatchObject({ code: "fetch_failed" });
    await reading.promise;
    abort.abort(new Error("session stopped"));
    await failure;
    expect(sourceFetch).toHaveBeenCalledTimes(1);
    expect(fixture.requests.map(({ method }) => method)).toEqual(["getFile"]);
  });

  it.each(["default", "private-opt-in", "explicit-proxy"] as const)(
    "enforces private-address trust at the real fetch guard (%s)",
    async (policy) => {
      const sourceFetch = vi.fn(pngFetch);
      const acquiring = acquire({
        apiRoot: undefined,
        ...(policy === "private-opt-in" ? { dangerouslyAllowPrivateNetwork: true } : {}),
        transport: {
          ...transport(sourceFetch),
          dispatcherAttempts:
            policy === "explicit-proxy"
              ? [
                  {
                    dispatcherPolicy: {
                      mode: "explicit-proxy" as const,
                      proxyUrl: "http://localhost:8888",
                      allowPrivateProxy: true,
                    },
                  },
                ]
              : undefined,
        },
      });
      if (policy === "default") {
        await expect(acquiring).rejects.toThrow(/private|blocked/i);
        expect(sourceFetch).not.toHaveBeenCalled();
      } else {
        const media = await acquiring;
        expect(await readFile(media!.path)).toEqual(bytes);
        expect(sourceFetch).toHaveBeenCalledTimes(1);
      }
    },
  );
});

describe("Telegram downloaded image documents", () => {
  it("detects JPEG bytes in a document with generic metadata", async () => {
    const JPEG = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
      "base64",
    );
    await withOpenClawTestState({ label: "telegram-image-document" }, async (state) => {
      const sourcePath = state.path("upload.bin");
      await writeFile(sourcePath, JPEG);
      const fileId = "document-fixture";
      const ctx = makeCtx(
        "document",
        async () => ({
          file_id: fileId,
          file_unique_id: fileId,
          file_path: sourcePath,
        }),
        { file_name: "upload.bin", mime_type: "application/octet-stream" },
      );
      const result = requireResolvedMedia(
        await resolveMedia({
          ctx,
          token: "12345:fixture-token",
          maxBytes: 1_024,
          trustedLocalFileRoots: [state.root],
        }),
        "image document",
      );
      expect(result.path).not.toBe(sourcePath);
      expect(await readFile(result.path)).toEqual(JPEG);
      expect(result).toMatchObject({
        contentType: "image/jpeg",
        fileName: "upload.bin",
        size: JPEG.length,
        kind: "image",
      });
    });
  });
});
