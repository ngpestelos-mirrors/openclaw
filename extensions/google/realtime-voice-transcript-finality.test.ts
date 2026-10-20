import {
  LiveServerMessage,
  type LiveConnectParameters,
  type LiveServerContent,
  type Session,
} from "@google/genai";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createRealtimeVoiceSessionHarness,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ as PCM,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type Connect = (p: LiveConnectParameters) => Promise<Pick<Session, "close" | "sendRealtimeInput">>;
const connect = vi.hoisted(() => vi.fn<Connect>());
vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: () => ({ live: { connect } }),
}));

function emitContent(serverContent: LiveServerContent): void {
  const params = expectDefined(connect.mock.calls.at(-1)?.[0], "Google Live connection");
  params.callbacks.onmessage(Object.assign(new LiveServerMessage(), { serverContent }));
}

beforeEach(() => {
  connect.mockImplementation(async ({ callbacks }: LiveConnectParameters) => {
    callbacks.onopen?.();
    callbacks.onmessage(Object.assign(new LiveServerMessage(), { setupComplete: {} }));
    return { close: vi.fn(), sendRealtimeInput: vi.fn() };
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

it.each(["completed", "cancelled"] as const)(
  "reports %s only after the native model turn completes",
  async (status) => {
    const delivered: string[] = [];
    const onResponseDone = vi.fn((outcome: { status: string }) => {
      delivered.push(`done:${outcome.status}`);
    });
    const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      audioFormat: PCM,
      onAudio: () => delivered.push("audio"),
      onClearAudio: () => delivered.push("clear"),
      onTranscript: (_role, _text, isFinal) => isFinal && delivered.push("transcript"),
      onResponseDone,
    });
    await bridge.connect();
    try {
      emitContent({
        outputTranscription: { text: "Hello." },
        modelTurn: {
          parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
        },
      });
      emitContent(status === "cancelled" ? { interrupted: true } : { generationComplete: true });
      expect(onResponseDone).not.toHaveBeenCalled();
      emitContent({ turnComplete: true });
      expect(onResponseDone.mock.calls).toEqual([[{ status }]]);
      expect(delivered).toEqual(
        status === "cancelled"
          ? ["audio", "clear", "transcript", "done:cancelled"]
          : ["audio", "transcript", "done:completed"],
      );

      bridge.sendUserMessage?.("Continue when ready.");
      emitContent({ waitingForInput: true, turnComplete: true });
      expect(onResponseDone.mock.calls).toEqual([[{ status }], [{ status: "completed" }]]);
    } finally {
      await bridge.close();
    }
  },
);
it("releases successive empty text responses through the shared voice harness", async () => {
  const onResponseDone = vi.fn();
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: "google-empty-response",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: () => ({}),
      inputAudioDelta: () => ({}),
      outputAudioStarted: () => ({}),
      outputAudioDelta: () => ({}),
      outputAudioDone: () => ({}),
    },
  });
  const session = harness.createBridge({
    provider: buildGoogleRealtimeVoiceProvider(),
    providerConfig: { apiKey: "test-key" },
    audioSink: { sendAudio: vi.fn() },
    onResponseDone,
  });
  try {
    await session.connect();
    for (const text of ["Wait for more input.", "Keep waiting."]) {
      session.sendUserMessage(text);
      emitContent({ waitingForInput: true, turnComplete: true });
    }
    expect(onResponseDone.mock.calls).toEqual([
      [{ status: "completed" }],
      [{ status: "completed" }],
    ]);
  } finally {
    await session.close();
    harness.close();
  }
});
