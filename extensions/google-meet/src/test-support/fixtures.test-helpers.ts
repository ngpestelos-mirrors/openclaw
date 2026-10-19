import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  MeetingRealtimeAudioEngineHealth,
  MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import { vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { GoogleMeetRuntime } from "../runtime.js";
import type { GoogleMeetSession } from "../transports/types.js";

export const MEET_URL = "https://meet.google.com/abc-defg-hij";
export const MEET_URL_EN = `${MEET_URL}?hl=en`;

const record = "conferenceRecords/rec-1";
const times = { startTime: "2026-04-25T10:00:00Z", endTime: "2026-04-25T10:30:00Z" };
const conferenceRecord = {
  name: record,
  space: "spaces/abc-defg-hij",
  ...times,
};

function resourceList(key: string, name: string, fields: Record<string, unknown>) {
  return { [key]: [{ name: `${record}/${name}`, ...fields }] };
}

export function meetApiFixtures(cli?: { participantDisplayName?: string }) {
  return {
    "/v2/spaces/abc-defg-hij": {
      name: "spaces/abc-defg-hij",
      meetingCode: "abc-defg-hij",
      meetingUri: MEET_URL,
    },
    "/calendar/v3/calendars/primary/events": {
      items: [
        {
          id: "event-1",
          summary: "Project sync",
          hangoutLink: MEET_URL,
          start: { dateTime: times.startTime },
          end: { dateTime: times.endTime },
        },
      ],
    },
    "/v2/conferenceRecords": { conferenceRecords: [conferenceRecord] },
    [`/v2/${record}`]: conferenceRecord,
    [`/v2/${record}/participants`]: resourceList("participants", "participants/p1", {
      ...(!cli ? { earliestStartTime: times.startTime, latestEndTime: times.endTime } : {}),
      signedinUser: { user: "users/alice", displayName: cli?.participantDisplayName ?? "Alice" },
    }),
    [`/v2/${record}/participants/p1/participantSessions`]: resourceList(
      "participantSessions",
      "participants/p1/participantSessions/s1",
      { ...times, ...(cli ? { endTime: "2026-04-25T10:10:00Z" } : {}) },
    ),
    [`/v2/${record}/recordings`]: resourceList("recordings", "recordings/r1", {
      ...(cli ? { state: "FILE_GENERATED" } : {}),
      driveDestination: { file: cli ? "drive-file-1" : "drive/file-1" },
    }),
    [`/v2/${record}/transcripts`]: resourceList("transcripts", "transcripts/t1", {
      ...(cli ? { state: "FILE_GENERATED" } : {}),
      docsDestination: { document: cli ? "doc-1" : "docs/doc-1" },
    }),
    [`/v2/${record}/transcripts/t1/entries`]: resourceList(
      "transcriptEntries",
      "transcripts/t1/entries/e1",
      {
        participant: `${record}/participants/p1`,
        text: "Hello from the transcript.",
        startTime: "2026-04-25T10:01:00Z",
        ...(!cli ? { languageCode: "en-US", endTime: "2026-04-25T10:01:05Z" } : {}),
      },
    ),
    [`/v2/${record}/smartNotes`]: resourceList("smartNotes", "smartNotes/sn1", {
      ...(cli ? { state: "FILE_GENERATED" } : {}),
      docsDestination: { document: cli ? "notes-1" : "docs/doc-2" },
    }),
  } satisfies Record<string, unknown>;
}

export function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return { output: () => output, restore: () => writeSpy.mockRestore() };
}

export function stubMeetArtifactsApi() {
  const fixtures: Record<string, unknown> = meetApiFixtures();
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      .pathname;
    const fixture = fixtures[path];
    if (fixture) {
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const document = {
      "/drive/v3/files/doc-1/export": "Transcript document body.",
      "/drive/v3/files/doc-2/export": "Smart note document body.",
    }[path];
    return new Response(document ?? `unexpected ${path}`, {
      status: document ? 200 : 404,
      ...(document ? { headers: { "Content-Type": "text/plain" } } : {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function meetBrowserState(overrides: Record<string, unknown> = {}) {
  return {
    inCall: true,
    micMuted: false,
    audioInputRouted: true,
    audioOutputRouted: true,
    title: "Meet call",
    url: MEET_URL,
    ...overrides,
  };
}

type SessionOverrides = Omit<Partial<GoogleMeetSession>, "chrome" | "realtime"> & {
  chrome?: Partial<NonNullable<GoogleMeetSession["chrome"]>>;
  realtime?: Partial<NonNullable<GoogleMeetSession["realtime"]>>;
};

export function meetSession(overrides: SessionOverrides = {}): GoogleMeetSession {
  const { chrome, realtime, ...session } = overrides;
  const mode = session.mode ?? "agent";
  return {
    id: "meet_1",
    url: MEET_URL,
    transport: "chrome",
    mode,
    agentId: "main",
    state: "active",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    participantIdentity: "signed-in Google Chrome profile",
    realtime: {
      enabled: mode !== "transcribe",
      strategy: mode === "bidi" ? "bidi" : "agent",
      ...(mode === "bidi" ? { provider: "openai" } : {}),
      ...(mode === "agent" ? { transcriptionProvider: "openai" } : {}),
      toolPolicy: "safe-read-only",
      ...realtime,
    },
    chrome: {
      audioBackend: "blackhole-2ch",
      launched: true,
      ...chrome,
    },
    notes: [],
    ...session,
  };
}

function emptyRealtimeAudioHealth(): MeetingRealtimeAudioEngineHealth {
  return {
    providerConnected: false,
    realtimeReady: false,
    audioInputActive: false,
    audioOutputActive: false,
    lastInputBytes: 0,
    lastOutputBytes: 0,
    suppressedInputBytes: 0,
    realtimeTranscriptLines: 0,
    recentRealtimeTranscript: [],
    recentTalkEvents: [],
    bridgeClosed: false,
  };
}

export function meetAudioBridge(stop = vi.fn(async () => {})) {
  return {
    type: "command-pair" as const,
    providerId: "openai",
    inputCommand: ["capture-meet"],
    outputCommand: ["play-meet"],
    speak: vi.fn(),
    getHealth: vi.fn(emptyRealtimeAudioHealth),
    stop,
  };
}

export function createTestMeetRealtimeAudioTransport() {
  let inputHandler: ((audio: Buffer) => void) | undefined;
  const writeOutput = vi.fn(async () => {});
  const transport: MeetingRealtimeAudioTransport = {
    onFatal: vi.fn(),
    startInput: vi.fn((handler) => {
      inputHandler = handler;
    }),
    stop: vi.fn(async () => {}),
    writeOutput,
    clearOutput: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return {
    transport,
    writeOutput,
    deliverInput: (audio: Buffer) => {
      if (!inputHandler) {
        throw new Error("Expected Google Meet realtime input to be started");
      }
      inputHandler(audio);
    },
  };
}

export function meetRuntime(
  config: Parameters<typeof resolveGoogleMeetConfig>[0],
  logger: ConstructorParameters<typeof GoogleMeetRuntime>[0]["logger"],
  fullConfig: OpenClawConfig = {},
) {
  return new GoogleMeetRuntime({
    config: resolveGoogleMeetConfig(config),
    fullConfig,
    runtime: {} as never,
    logger,
  });
}

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: PassThrough | null;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
  emit: EventEmitter["emit"];
};

export function testBridgeProcess(stdio: {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: PassThrough | null;
  stderr?: PassThrough;
}): TestBridgeProcess {
  const proc = new EventEmitter() as unknown as TestBridgeProcess;
  proc.stdin = stdio.stdin;
  proc.stdout = stdio.stdout;
  proc.stderr = stdio.stderr ?? new PassThrough();
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.killed = true;
    proc.signalCode = signal ?? "SIGTERM";
    return true;
  });
  return proc;
}
