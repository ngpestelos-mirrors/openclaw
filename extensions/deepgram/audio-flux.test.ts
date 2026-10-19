import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { isDeepgramFluxModel } from "./audio-flux.js";
import plugin from "./index.js";

const runCommandBuffered = vi.hoisted(() =>
  vi.fn<typeof import("openclaw/plugin-sdk/process-runtime").runCommandBuffered>(),
);
const prepareWebSocket = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("openclaw/plugin-sdk/media-ffmpeg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-ffmpeg")>()),
  resolveFfmpegBin: () => "/usr/bin/ffmpeg",
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandBuffered }));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>();
  return {
    ...actual,
    openProviderWebSocket: async (params: Parameters<typeof actual.openProviderWebSocket>[0]) => {
      await prepareWebSocket();
      return await actual.openProviderWebSocket(params);
    },
  };
});

const cleanups: Array<() => Promise<void>> = [];
const registeredProviders: MediaUnderstandingProvider[] = [];
plugin.register(
  createTestPluginApi({
    registerMediaUnderstandingProvider: (provider) => registeredProviders.push(provider),
  }),
);
const transcribeAudio = expectDefined(
  registeredProviders[0]?.transcribeAudio,
  "registered audio transcription callback",
);

async function createFluxServer(params: { onCloseStream: (socket: WebSocket) => void }) {
  const listener = createServer();
  const server = new WebSocketServer({ server: listener, maxPayload: 1024 * 1024 });
  const audioFrames: Buffer[] = [];
  const requests: Array<{ url: URL; headers: Record<string, string | string[] | undefined> }> = [];
  listener.on("upgrade", (request) => {
    requests.push({
      url: new URL(request.url ?? "/", "http://127.0.0.1"),
      headers: request.headers,
    });
  });
  server.on("connection", (client) => {
    client.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (isBinary) {
        audioFrames.push(bytes);
      } else if (asOptionalRecord(JSON.parse(bytes.toString()))?.type === "CloseStream") {
        params.onCloseStream(client);
      }
    });
  });
  await new Promise<void>((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as AddressInfo).port;
  cleanups.push(
    async () =>
      await new Promise<void>((resolve, reject) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => listener.close((error) => (error ? reject(error) : resolve())));
      }),
  );
  return { audioFrames, requests, baseUrl: `http://127.0.0.1:${port}/v1` };
}

function turn(transcript?: unknown): string {
  return JSON.stringify({ type: "TurnInfo", event: "EndOfTurn", transcript });
}

function fluxRequest(
  baseUrl: string,
  extra: Partial<AudioTranscriptionRequest> = {},
): AudioTranscriptionRequest {
  return {
    buffer: Buffer.from("source audio"),
    fileName: "note.ogg",
    apiKey: "default-key",
    baseUrl,
    model: "flux-general-multi",
    timeoutMs: 5000,
    request: { allowPrivateNetwork: true },
    ...extra,
  };
}

async function writeDecodedPcm(argv: string[], pcm: Buffer) {
  await writeFile(expectDefined(argv.at(-1), "decoder output path"), pcm);
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
    signal: null,
    killed: false,
    termination: "exit" as const,
  };
}

describe("Deepgram Flux audio", () => {
  beforeEach(() => {
    runCommandBuffered.mockImplementationOnce((argv) => writeDecodedPcm(argv, Buffer.alloc(10, 1)));
  });
  afterEach(async () => {
    runCommandBuffered.mockReset();
    prepareWebSocket.mockReset();
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("keeps decoding, connection preparation, and transcription within one deadline", async () => {
    const decodeStarted = createDeferred<void>();
    const releaseDecode = createDeferred<void>();
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    const flushed = createDeferred<void>();
    const server = await createFluxServer({ onCloseStream: () => flushed.resolve() });
    runCommandBuffered.mockReset().mockImplementationOnce(async (argv) => {
      decodeStarted.resolve();
      await releaseDecode.promise;
      return await writeDecodedPcm(argv, Buffer.alloc(10, 1));
    });
    prepareWebSocket.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let failure: unknown;
    const transcription = transcribeAudio(fluxRequest(server.baseUrl, { timeoutMs: 1000 })).catch(
      (error: unknown) => {
        failure = error;
      },
    );

    await decodeStarted.promise;
    await vi.advanceTimersByTimeAsync(200);
    releaseDecode.resolve();
    await preparationStarted.promise;
    await vi.advanceTimersByTimeAsync(300);
    releasePreparation.resolve();
    await flushed.promise;
    await vi.advanceTimersByTimeAsync(499);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await transcription;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: expect.stringContaining("timed out") });
  });

  it("routes documented Flux models only", () => {
    expect(isDeepgramFluxModel("flux-general-en")).toBe(true);
    expect(isDeepgramFluxModel(" Flux-General-Multi ")).toBe(true);
    expect(isDeepgramFluxModel("flux")).toBe(false);
    expect(isDeepgramFluxModel("reflux-general-en")).toBe(false);
    expect(isDeepgramFluxModel("nova-3")).toBe(false);
  });

  it.each([
    { model: "flux-general-multi", language: " en ", queryLanguage: undefined, expectedHint: "en" },
    { model: "flux-general-multi", language: "en", queryLanguage: "fr", expectedHint: "fr" },
    { model: "flux-general-en", language: " en ", queryLanguage: "fr", expectedHint: null },
  ])(
    "uses valid protocol fields for $model with language=$language and query=$queryLanguage",
    async ({ model, language, queryLanguage, expectedHint }) => {
      const pcm = Buffer.alloc(6000, 1);
      runCommandBuffered.mockReset().mockImplementationOnce((argv) => writeDecodedPcm(argv, pcm));
      const server = await createFluxServer({
        onCloseStream: (socket) => {
          socket.send(turn("life moves"));
          socket.send(turn("pretty fast"));
          socket.close();
        },
      });

      const result = await transcribeAudio(
        fluxRequest(server.baseUrl, {
          model,
          language,
          query: {
            ...(queryLanguage === undefined ? {} : { language_hint: queryLanguage }),
            eot_threshold: 0.7,
            keyterm: ["OpenClaw", "Deepgram"],
            numerals: true,
            profanity_filter: true,
            smart_format: true,
          },
          request: {
            allowPrivateNetwork: true,
            auth: { mode: "header", headerName: "authorization", value: "Token configured-key" },
          },
        }),
      );

      const { url: requestUrl, headers } = expectDefined(server.requests[0], "Flux request");
      expect(result).toEqual({ model, text: "life moves pretty fast" });
      expect(headers.authorization).toBe("Token configured-key");
      expect(requestUrl.pathname).toBe("/v2/listen");
      expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
        encoding: "linear16",
        sample_rate: "16000",
        eot_threshold: "0.7",
        numerals: "true",
        profanity_filter: "true",
      });
      expect(requestUrl.searchParams.get("language_hint")).toBe(expectedHint);
      expect(requestUrl.searchParams.getAll("keyterm")).toEqual(["OpenClaw", "Deepgram"]);
      expect(requestUrl.searchParams.has("smart_format")).toBe(false);
      expect(server.audioFrames.map((frame) => frame.byteLength)).toEqual([2560, 2560, 880]);
      expect(Buffer.concat(server.audioFrames)).toEqual(pcm);
    },
  );

  it("returns an empty transcript when the flushed stream has no turns", async () => {
    const server = await createFluxServer({ onCloseStream: (socket) => socket.close() });

    await expect(transcribeAudio(fluxRequest(server.baseUrl))).resolves.toMatchObject({
      text: "",
    });
  });

  it.each([
    ["non-object server JSON", "[]", "malformed JSON response"],
    ["a turn without transcript text", turn(), "missing transcript"],
    ["a turn with a non-string transcript", turn(42), "missing transcript"],
    ["oversized transcript", turn("x".repeat(256 * 1024 + 1)), "transcript exceeds size limit"],
  ])("rejects %s", async (_name, payload, error) => {
    const server = await createFluxServer({
      onCloseStream: (socket) => socket.send(payload),
    });
    await expect(transcribeAudio(fluxRequest(server.baseUrl))).rejects.toThrow(error);
  });

  it("does not open a private socket without the request-policy opt-in", async () => {
    const server = await createFluxServer({
      onCloseStream: () => undefined,
    });
    await expect(
      transcribeAudio(fluxRequest(server.baseUrl, { request: { allowPrivateNetwork: false } })),
    ).rejects.toThrow(/private|loopback|blocked/iu);
    expect(server.requests).toEqual([]);
  });
});
