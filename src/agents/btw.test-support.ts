import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { AssistantMessage, AssistantMessageEvent } from "../llm/types.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import * as mocks from "./btw.mocks.test-support.js";
import { guardModelFixtureWorkspace } from "./embedded-agent-runner/model.fixture.test-support.js";
import { resetModelGenerationFixtureState } from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness } from "./harness/types.js";
export let state: OpenClawTestState;
let workspaceGuard: ReturnType<typeof guardModelFixtureWorkspace>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "btw-model" });
});
beforeEach(() => {
  workspaceGuard = guardModelFixtureWorkspace(state.root);
});
afterEach(() => {
  try {
    workspaceGuard.verify();
  } finally {
    workspaceGuard.spy.mockRestore();
  }
});
afterAll(async () => {
  defaultPluginMetadataSnapshot = undefined;
  await state.cleanup();
});

const { runBtwSideQuestion } = await import("./btw.js");
const { clearAgentHarnesses, registerAgentHarness } = await import("./harness/registry.js");
type RunBtwSideQuestionParams = Parameters<typeof runBtwSideQuestion>[0];

export const DEFAULT_AGENT_DIR = "/tmp/agent";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_SESSION_KEY = "agent:main:main";
export const DEFAULT_QUESTION = "What changed?";
export const MATH_ANSWER = "323";
let defaultPluginMetadataSnapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;

const DEFAULT_USAGE = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function makeAsyncEvents(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

export function createSessionEntry(overrides: Partial<SessionEntry> = {}) {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function createDoneEvent(text: string): Extract<AssistantMessageEvent, { type: "done" }> {
  return {
    type: "done",
    reason: "stop",
    message: createAssistantTranscriptMessage<AssistantMessage["content"]>(
      [{ type: "text", text }],
      { timestamp: Date.now() },
    ),
  };
}

export function mockDoneAnswer(text: string) {
  mocks.streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

export function createCliRuntimeConfig(): Parameters<typeof runBtwSideQuestion>[0]["cfg"] {
  return {
    agents: {
      defaults: {
        models: { "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } } },
      },
    },
  };
}

export function mockCliOutput(output: { text: string; rawText?: string }) {
  const cleanup = vi.fn(async () => undefined);
  const prepared = { prepared: true, preparedBackend: { cleanup } };
  mocks.prepareCliRunContextMock.mockResolvedValueOnce(prepared);
  mocks.executePreparedCliRunMock.mockResolvedValueOnce(output);
  return { cleanup, prepared };
}

export function registerCodexSideQuestionHarness(
  overrides: Partial<Pick<AgentHarness, "authBootstrap" | "supports">> = {},
) {
  const runHarnessSideQuestion = vi.fn().mockResolvedValue({ text: "Codex side answer." });
  registerAgentHarness({
    id: "codex",
    label: "Codex test harness",
    supports: () => ({ supported: true, priority: 100 }),
    runAttempt: vi.fn(),
    runSideQuestion: runHarnessSideQuestion,
    ...overrides,
  });
  return runHarnessSideQuestion;
}

export function supportsPreparedOpenAIAuth(ctx: Parameters<AgentHarness["supports"]>[0]) {
  if (ctx.provider !== "openai") {
    return { supported: false as const, reason: "Codex only supports OpenAI providers" };
  }
  const preparedAuth = ctx.modelProvider?.preparedAuth;
  if (preparedAuth?.requirement === "subscription") {
    return preparedAuth.source === "profile" &&
      (preparedAuth.mode === "oauth" || preparedAuth.mode === "token")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "subscription auth is not reproducible" };
  }
  if (preparedAuth?.requirement === "api-key") {
    return preparedAuth.source !== "none" &&
      preparedAuth.source !== "harness" &&
      (preparedAuth.mode === "api-key" || preparedAuth.mode === "api_key")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "Platform auth is not reproducible" };
  }
  return { supported: true as const, priority: 100 };
}

export function createSideQuestionParams(
  overrides: Partial<RunBtwSideQuestionParams> = {},
): RunBtwSideQuestionParams {
  return {
    cfg: { agents: { entries: { main: {} } } },
    agentId: "main",
    agentDir: DEFAULT_AGENT_DIR,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    question: DEFAULT_QUESTION,
    sessionEntry: createSessionEntry(),
    sessionKey: DEFAULT_SESSION_KEY,
    storePath: "/tmp/sessions.json",
    resolvedReasoningLevel: "off",
    opts: {},
    isNewSession: false,
    ...overrides,
  };
}

export function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion(createSideQuestionParams(overrides));
}

export function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({
    question: "What is 17 * 19?",
    ...overrides,
  });
}

export function clearBuiltSessionMessages() {
  mocks.buildSessionContextMock.mockReturnValue({ messages: [] });
}

export function createUserTranscriptMessage(content: unknown[] = [{ type: "text", text: "seed" }]) {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

export function createAssistantTranscriptMessage<Content>(
  content: Content,
  overrides: {
    stopReason?: AssistantMessage["stopReason"];
    output?: number;
    timestamp?: number;
  } = {},
) {
  return {
    role: "assistant" as const,
    content,
    provider: DEFAULT_PROVIDER,
    api: "anthropic-messages" as const,
    model: DEFAULT_MODEL,
    stopReason: overrides.stopReason ?? "stop",
    usage: {
      ...DEFAULT_USAGE,
      output: overrides.output ?? DEFAULT_USAGE.output,
      totalTokens: 1 + (overrides.output ?? DEFAULT_USAGE.output),
    },
    timestamp: overrides.timestamp ?? 2,
  };
}

export function createTranscriptEntry(params: {
  id: string;
  parentId?: string | null;
  message: unknown;
}) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    message: params.message,
  };
}

export function mockTranscriptEntries(entries: unknown[]) {
  mocks.parseSessionEntriesMock.mockReturnValue(entries);
  mocks.loadTranscriptEventsMock.mockResolvedValue(entries);
}

export function mockActiveTranscript(messages: unknown[]) {
  mocks.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
    transcriptLeafId: "assistant-1",
    messages,
  });
}

type RecordedMock = { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } };
export function mockCall(mockFn: RecordedMock, callIndex = 0): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex + 1}`);
  }
  return call;
}

export function mockArg(mockFn: RecordedMock, callIndex: number, argIndex: number): unknown {
  return mockCall(mockFn, callIndex)[argIndex];
}

export async function runMathSideQuestionAndCaptureContext() {
  mockDoneAnswer(MATH_ANSWER);
  await runMathSideQuestion();
  return mockArg(mocks.streamSimpleMock, 0, 1);
}

export function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

type StreamContext = {
  messages?: Array<Record<string, unknown>>;
  systemPrompt?: unknown;
};
export function streamContext(callIndex = 0): StreamContext {
  return (mockArg(mocks.streamSimpleMock, callIndex, 1) ?? {}) as StreamContext;
}

export function contextMessages(context: unknown): Array<Record<string, unknown>> {
  const messages = (context as StreamContext).messages;
  if (!messages) {
    throw new Error("Expected BTW context messages");
  }
  return messages;
}

export function expectTextBlockContains(block: unknown, text: string): void {
  const record = expectRecordFields(block, { type: "text" });
  expect(typeof record.text).toBe("string");
  expect(record.text).toContain(text);
}

export function expectNoAssistantMessages(context: unknown) {
  expect(
    (context as { messages?: Array<{ role?: string }> }).messages?.filter(
      (message) => message.role === "assistant",
    ),
  ).toHaveLength(0);
}

export function expectSanitizedAssistantContext(context: unknown, text: string) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(3);
  expectRecordFields(messages[0], { role: "user" });
  expectRecordFields(messages[1], {
    role: "assistant",
    content: [{ type: "text", text }],
  });
  expectRecordFields(messages[2], { role: "user" });
}

export function expectSeedOnlyUserContext(context: unknown) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(2);
  expectRecordFields(messages[0], {
    role: "user",
    content: [{ type: "text", text: "seed" }],
  });
  expectRecordFields(messages[1], { role: "user" });
}

export function mockOpenAIPlatformProfile(): void {
  mocks.ensureAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      "profile-1": createApiKeyCredential("openai", "platform-key"),
    },
    order: { openai: ["profile-1"] },
  });
}

export function setupBtwTestHooks() {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelGenerationFixtureState();
  });

  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
    mocks.snapshotResources.acquire = undefined;
    mocks.getModelRegistryRuntimeMock.mockReturnValue({
      apiRegistry: {},
      llmRuntime: { streamSimple: mocks.streamSimpleMock },
    });
    mocks.listSessionEntriesCoreMock.mockReturnValue([]);
    mocks.shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    mocks.hasUsableCustomProviderApiKeyMock.mockReturnValue(false);
    mocks.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "none" });
    clearAgentHarnesses();
    if (!defaultPluginMetadataSnapshot) {
      defaultPluginMetadataSnapshot = resolvePluginMetadataSnapshot({
        config: {},
        workspaceDir: state.workspaceDir,
        allowCurrent: false,
      });
      expect(workspaceGuard.spy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: state.workspaceDir }),
      );
    }
    mocks.preparedRuntimeSnapshotState.snapshot = {
      metadataSnapshot: defaultPluginMetadataSnapshot,
    };
    mocks.preparedRuntimeSnapshotState.useSnapshotPluginRegistry = false;

    mockTranscriptEntries([
      createTranscriptEntry({
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      }),
      createTranscriptEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          timestamp: 2,
        },
      }),
    ]);
    mocks.buildSessionContextMock.mockImplementation(
      (entries: Array<{ message?: unknown }> = []) => {
        return { messages: entries.flatMap((entry) => (entry.message ? [entry.message] : [])) };
      },
    );
    mocks.resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    mocks.resolveModelAsyncMock.mockImplementation(async () => ({
      model: mocks.resolveModelWithRegistryMock(),
    }));
    mocks.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    mocks.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({
      version: 1,
      profiles: {},
    });
    mocks.getApiKeyForModelMock.mockImplementation(async (params: { profileId?: string } = {}) => ({
      apiKey: "secret",
      mode: "api-key",
      source: params.profileId ? `profile:${params.profileId}` : "test",
      ...(params.profileId ? { profileId: params.profileId } : {}),
    }));
    mocks.requireApiKeyMock.mockReturnValue("secret");
    mocks.resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-1",
      source: "auto",
      routeRequirement: undefined,
    });
    mocks.resolveSessionAgentIdMock.mockReturnValue("main");
    mocks.resolveSessionAgentIdsMock.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
    mocks.resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    mocks.listAgentEntriesMock.mockReturnValue([]);
    mocks.prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
    mocks.resolveEmbeddedAgentStreamMock.mockImplementation(
      (params: { currentStreamFn: unknown; providerStreamFn?: unknown }) => {
        return {
          streamFn: params.providerStreamFn ?? params.currentStreamFn,
          strategy: "session-custom",
        };
      },
    );
  });
}

export { runBtwSideQuestion, registerAgentHarness };
export * from "./btw.mocks.test-support.js";
