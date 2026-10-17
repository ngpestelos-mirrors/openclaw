import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { consumeReplyUsageState } from "../auto-reply/reply/reply-usage-state.js";
import type { SessionEntry } from "../config/sessions.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createApiKeyCredential } from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { executePreparedCliRunMock } from "./btw.mocks.test-support.js";
import * as btw from "./btw.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
} from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarness, AgentHarnessSideQuestionParams } from "./harness/types.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

function createSeedTranscript() {
  const userEntry = btw.createTranscriptEntry({
    id: "user-seed",
    message: btw.createUserTranscriptMessage(),
  });
  const assistantEntry = assistantTranscript("assistant-seed", "seed answer", "user-seed");
  return { userEntry, assistantEntry };
}

function assistantTranscript(id: string, text: string, parentId?: string) {
  return btw.createTranscriptEntry({
    id,
    parentId,
    message: btw.createAssistantTranscriptMessage([{ type: "text", text }]),
  });
}

async function expectMathBranch(entries: unknown[], once = false) {
  btw.mockDoneAnswer(btw.MATH_ANSWER);
  await expect(btw.runMathSideQuestion()).resolves.toEqual({ text: btw.MATH_ANSWER });
  expect(btw.buildSessionContextMock).toHaveBeenCalledWith(entries);
  if (once) {
    expect(btw.buildSessionContextMock).toHaveBeenCalledOnce();
  }
}

function createOpenAIModel(subscription = false) {
  return {
    provider: "openai",
    id: "gpt-5.5",
    api: subscription ? ("openai-chatgpt-responses" as const) : ("openai-responses" as const),
    baseUrl: subscription ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
  };
}

function authStore(
  profiles: AuthProfileStore["profiles"],
  order?: AuthProfileStore["order"],
): AuthProfileStore {
  return { version: 1, profiles, ...(order ? { order } : {}) };
}

function oauth(provider: string, access: string, refresh: string) {
  return { type: "oauth" as const, provider, access, refresh, expires: Date.now() + 60_000 };
}

function subscriptionToken(value: string) {
  return { type: "token" as const, provider: "openai", token: value, expires: Date.now() + 60_000 };
}

function authResult(
  apiKey: string | undefined,
  mode: ResolvedProviderAuth["mode"],
  source: string,
  profileId?: string,
): ResolvedProviderAuth {
  return { apiKey, mode, source, ...(profileId ? { profileId } : {}) };
}

function expectCallFields(mock: unknown, fields: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields));
}

function expectUncalled(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function sideQuestionArgs(mock: Parameters<typeof btw.mockArg>[0]) {
  return btw.mockArg(mock, 0, 0) as AgentHarnessSideQuestionParams;
}

function expectPreparedAuth(mock: unknown, preparedAuth: Record<string, unknown>) {
  expectCallFields(mock, { modelProvider: expect.objectContaining({ preparedAuth }) });
}

function harnessConfig(id: "codex" | "openclaw") {
  return { agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id } } } } } };
}

function runOpenAISideQuestion(overrides: Parameters<typeof btw.runSideQuestion>[0] = {}) {
  return btw.runSideQuestion({ provider: "openai", model: "gpt-5.5", ...overrides });
}

function runCliSideQuestion(overrides: Parameters<typeof btw.runSideQuestion>[0] = {}) {
  return btw.runSideQuestion({
    cfg: btw.createCliRuntimeConfig(),
    model: "claude-opus-4-7",
    ...overrides,
  });
}

describe("runBtwSideQuestion", () => {
  btw.setupBtwTestHooks();

  it.each(["off", "stream"] as const)(
    "keeps admitted %s reasoning visibility when caller input changes",
    async (mode) => {
      const onReasoningStream = vi.fn();
      const onReasoningEnd = vi.fn();
      const input = btw.createSideQuestionParams({
        resolvedReasoningLevel: mode,
        opts: {
          onAssistantMessageStart: async () => {
            input.resolvedReasoningLevel = mode === "off" ? "on" : "off";
          },
          onReasoningStream,
          onReasoningEnd,
        },
      });
      const done = btw.createDoneEvent("Final answer.");
      btw.streamSimpleMock.mockReturnValue(
        btw.makeAsyncEvents([
          { type: "start", partial: done.message },
          { type: "thinking_delta", delta: "One " },
          { type: "thinking_delta", delta: "two" },
          { type: "thinking_end" },
          done,
        ]),
      );

      await expect(btw.runBtwSideQuestion(input)).resolves.toEqual({ text: "Final answer." });
      expect(onReasoningStream.mock.calls).toEqual(
        mode === "off"
          ? []
          : [[{ text: "One ", isReasoning: true }], [{ text: "One two", isReasoning: true }]],
      );
      expect(onReasoningEnd).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    },
  );

  it.each([
    { harness: "openclaw", sandboxSessionKey: undefined },
    { harness: "codex", sandboxSessionKey: "agent:main:policy" },
  ])(
    "retains the selected global agent for $harness with policy $sandboxSessionKey",
    async ({ harness, sandboxSessionKey }) => {
      // Gateway-published owners require the binding flag to match their owner key.
      btw.mockDoneAnswer("Final answer.");
      btw.resolveSessionAgentIdMock.mockImplementation(
        (await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js"))
          .resolveSessionAgentId,
      );
      const sideQuestion = harness === "codex" ? btw.registerCodexSideQuestionHarness() : undefined;

      await btw.runSideQuestion({
        agentId: "work",
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "global" },
        },
        sessionKey: "global",
        sandboxSessionKey,
        allowGatewaySubagentBinding: true,
      });

      expect(btw.mockCall(btw.loadPreparedModelRuntimeSnapshotMock)?.[0]).toMatchObject({
        agentDir: btw.DEFAULT_AGENT_DIR,
        agentId: "work",
        allowGatewaySubagentBinding: true,
      });
      expectCallFields(btw.resolveSessionAuthSelectionMock, { agentId: "work" });
      if (sideQuestion) {
        expectCallFields(sideQuestion, { agentId: "work", sessionKey: "global" });
      }
    },
  );

  it("keeps gateway subagent binding off for local callers such as the embedded TUI", async () => {
    // Direct TUI calls must not borrow Gateway subagent/node capabilities.
    btw.mockDoneAnswer("Final answer.");

    await btw.runSideQuestion();

    expect(btw.mockCall(btw.loadPreparedModelRuntimeSnapshotMock)?.[0]).not.toHaveProperty(
      "allowGatewaySubagentBinding",
    );
  });

  it.each(["harness cleanup", "harness error", "stream output and transport"] as const)(
    "keeps the source database through %s after its publication retires",
    async (mode) => {
      const file = btw.state.path(`btw-${mode.replaceAll(" ", "-")}.sqlite`);
      const database = new DatabaseSync(file);
      database.exec("CREATE TABLE answer (value INTEGER); INSERT INTO answer VALUES (42)");
      const source = new PluginRegistryInspectionResources(async () => {});
      source.attach(createEmptyPluginRegistry());
      let disposals = 0;
      source.runRegistration("btw-fixture", () =>
        source.register("btw-fixture", {
          id: "database",
          dispose: () => {
            disposals++;
            database.close();
          },
        }),
      );
      btw.snapshotResources.acquire = () => source.retain();
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const tailEntered = createDeferredCore();
      const finishTail = createDeferredCore();
      const owner = new AsyncWorkScope();
      let operation: Promise<unknown> | undefined;
      let tailValue: unknown;
      try {
        if (mode !== "stream output and transport") {
          const runHarness = btw.registerCodexSideQuestionHarness();
          runHarness.mockImplementationOnce(async () => {
            try {
              entered.resolve();
              await finish.promise;
              if (mode === "harness error") {
                throw new Error("side question failed");
              }
              return { text: String(database.prepare("SELECT value FROM answer").get()?.value) };
            } finally {
              tailEntered.resolve();
              await finishTail.promise;
              tailValue = database.prepare("SELECT value FROM answer").get()?.value;
            }
          });
          operation = owner.track(() => btw.runSideQuestion());
        } else {
          btw.streamSimpleMock.mockImplementationOnce(() => {
            void trackAsyncWork(async () => {
              tailEntered.resolve();
              await finishTail.promise;
              tailValue = database.prepare("SELECT value FROM answer").get()?.value;
            });
            return btw.makeAsyncEvents([
              { type: "text_start" },
              btw.createDoneEvent("The answer is 42."),
            ]);
          });
          operation = owner.track(() =>
            btw.runSideQuestion({
              opts: {
                onAssistantMessageStart: async () => {
                  entered.resolve();
                  await finish.promise;
                  expect(database.prepare("SELECT value FROM answer").get()?.value).toBe(42);
                },
              },
            }),
          );
        }
        const outcome = operation.catch((error: unknown) => error);
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error("Side question completed before its controlled operation");
          }),
        ]);
        await source.release();
        expect(database.isOpen).toBe(true);
        expect(disposals).toBe(0);
        finish.resolve();
        await tailEntered.promise;
        if (mode === "stream output and transport") {
          expect(await outcome).toEqual({ text: "The answer is 42." });
        }
        expect(database.isOpen).toBe(true);
        finishTail.resolve();
        if (mode === "harness cleanup") {
          expect(await outcome).toEqual({ text: "42" });
        } else if (mode === "harness error") {
          expect(await outcome).toEqual(new Error("side question failed"));
        }
        await owner.drain();
        expect(tailValue).toBe(42);
        await expect.poll(() => disposals).toBe(1);
        expect(database.isOpen).toBe(false);
        const reopened = new DatabaseSync(file, { readOnly: true });
        try {
          expect(reopened.prepare("SELECT value FROM answer").get()?.value).toBe(42);
        } finally {
          reopened.close();
        }
      } finally {
        finish.resolve();
        finishTail.resolve();
        await Promise.allSettled([operation, owner.drain(), source.release()]);
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("keeps model, runtime auth, and stream selection on prepared A after current advances to B", async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const generation = (label: string) =>
      createModelGenerationFixture({
        agentDir: btw.state.agentDir(),
        workspaceDir: btw.state.workspaceDir,
        config: cfg,
        label,
        provider: "local-proxy",
        requestProvider: "local-proxy",
        modelId: "side-model",
      });
    const generationA = generation("btw-a");
    const generationB = generation("btw-b");
    btw.preparedRuntimeSnapshotState.snapshot = generationA.preparedModelRuntime;
    btw.preparedRuntimeSnapshotState.useSnapshotPluginRegistry = true;
    btw.resolveAgentWorkspaceDirMock.mockReturnValue(btw.state.workspaceDir);
    publishCurrentModelGeneration(generationB);
    const runtimeAuthA = vi.fn(async () => ({ apiKey: "runtime-auth-a" }));
    const runtimeAuthB = vi.fn(async () => ({ apiKey: "runtime-auth-b" }));
    const streamA = vi.fn(
      (model: { name?: string }, _context: unknown, options?: { apiKey?: string }) => {
        const apiKey = options?.apiKey;
        const resolvedApiKey =
          apiKey && looksLikeSecretSentinel(apiKey) ? resolveSecretSentinel(apiKey) : apiKey;
        return btw.makeAsyncEvents([
          btw.createDoneEvent(`${model.name ?? "missing model"} / ${resolvedApiKey} / Stream A`),
        ]);
      },
    );
    const streamB = vi.fn(() =>
      btw.makeAsyncEvents([btw.createDoneEvent("Generation B / runtime-auth-b / Stream B")]),
    );
    const activeGenerationRegistry = () =>
      getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
    btw.resolveModelWithRegistryMock.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: btw.state.workspaceDir,
      });
      const label = snapshot === generationA.metadataSnapshot ? "A" : "B";
      return {
        provider: "local-proxy",
        id: "side-model",
        name: `Generation ${label}`,
        api: "openai-responses",
        baseUrl: `https://generation-${label.toLowerCase()}.example.test/v1`,
      };
    });
    btw.prepareProviderRuntimeAuthMock.mockImplementation(async () =>
      activeGenerationRegistry() === generationA.pluginRegistry
        ? await runtimeAuthA()
        : await runtimeAuthB(),
    );
    btw.registerProviderStreamForModelMock.mockImplementation(() =>
      activeGenerationRegistry() === generationA.pluginRegistry ? streamA : streamB,
    );

    await expect(
      btw.runSideQuestion({ cfg, provider: "local-proxy", model: "side-model" }),
    ).resolves.toEqual({ text: "Generation A / runtime-auth-a / Stream A" });
    expect(runtimeAuthA).toHaveBeenCalledOnce();
    expectUncalled(runtimeAuthB);
    expect(streamA).toHaveBeenCalledOnce();
    expect(streamA).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Generation A" }),
      expect.any(Object),
      expect.any(Object),
    );
    expectUncalled(streamB, btw.streamSimpleMock);
    expectCallFields(btw.registerProviderStreamForModelMock, { wrapProviderStream: true });
  });

  it.each(["token", "legacy-oauth"] as const)(
    "routes %s subscription auth through the Codex side-question hook",
    async (mode) => {
      const legacy = mode === "legacy-oauth";
      const profileId = legacy ? "openai-codex:user@example.test" : "openai:work";
      const supports = vi.fn(
        legacy
          ? (ctx: Parameters<AgentHarness["supports"]>[0]) =>
              ctx.provider === "openai"
                ? { supported: true as const, priority: 100 }
                : { supported: false as const, reason: "openai only" }
          : btw.supportsPreparedOpenAIAuth,
      );
      const sideQuestion = btw.registerCodexSideQuestionHarness({ supports });
      btw.resolveModelWithRegistryMock.mockReturnValue(createOpenAIModel());
      btw.resolveSessionAuthSelectionMock.mockResolvedValue({
        profileId,
        source: "auto",
        routeRequirement: "subscription",
      });
      btw.ensureAuthProfileStoreMock.mockReturnValue(
        authStore(
          {
            [profileId]: legacy
              ? oauth("openai", "subscription-token", "refresh-token")
              : subscriptionToken("subscription-token"),
          },
          { openai: [profileId] },
        ),
      );
      btw.resolveModelAsyncMock.mockImplementation(
        async (
          _provider: string,
          _modelId: string,
          _agentDir: string,
          _config: unknown,
          options?: { authProfileMode?: string },
        ) => ({
          model:
            legacy || options?.authProfileMode === "token"
              ? createOpenAIModel(true)
              : btw.resolveModelWithRegistryMock(),
        }),
      );
      btw.getApiKeyForModelMock.mockResolvedValue({
        apiKey: "subscription-token",
        mode: legacy ? "oauth" : "token",
        source: `profile:${profileId}`,
        profileId,
      });
      const origin = {
        agentAccountId: "account-1",
        groupId: "group-1",
        groupChannel: "#ops",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        senderId: "sender-1",
        senderName: "Rosita",
        senderUsername: "rosita",
        senderE164: "+15550001",
        sandboxSessionKey: "agent:main:runtime-policy",
      };
      await expect(
        btw.runSideQuestion({
          provider: legacy ? "openai-codex" : "openai",
          model: "gpt-5.5",
          sessionKey: btw.DEFAULT_SESSION_KEY,
          ...(legacy
            ? { cfg: { auth: { order: { openai: [profileId] } }, ...harnessConfig("codex") } }
            : {
                ...origin,
                authorityRunId: "btw-side-authority",
                opts: { runId: "parent-correlation" },
              }),
        }),
      ).resolves.toEqual({ text: "Codex side answer." });
      expect(sideQuestion).toHaveBeenCalledOnce();
      const handed = sideQuestionArgs(sideQuestion);
      expect(handed).toMatchObject({
        provider: "openai",
        authProfileId: profileId,
        runtimeModel: createOpenAIModel(true),
      });
      expectUncalled(btw.streamSimpleMock, btw.registerProviderStreamForModelMock);
      if (legacy) {
        expect(handed.preparedRuntimeAuth.plan.modelRoute).toMatchObject({
          api: handed.runtimeModel?.api,
          baseUrl: handed.runtimeModel?.baseUrl,
          authRequirement: "subscription",
        });
        expect(Object.keys(handed.preparedRuntimeAuth.authProfileStore.profiles)).toEqual([
          profileId,
        ]);
      } else {
        expectCallFields(sideQuestion, {
          ...origin,
          model: "gpt-5.5",
          question: btw.DEFAULT_QUESTION,
          sessionId: "session-1",
          agentId: "main",
          workspaceDir: "/tmp/workspace",
          opts: { runId: "btw-side-authority" },
        });
        expect(handed).toHaveProperty("hostCapabilities", btw.agentHarnessHostCapabilitiesMock);
        expectCallFields(btw.createAgentHarnessHostCapabilitiesMock, {
          attempt: expect.objectContaining({
            admittedRunContext: expect.objectContaining({
              operationalRunInstance: expect.objectContaining({ runId: "btw-side-authority" }),
            }),
            runId: "btw-side-authority",
          }),
        });
        expect(btw.closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
        expect(btw.resolveModelAsyncMock).toHaveBeenCalledWith(
          "openai",
          "gpt-5.5",
          btw.DEFAULT_AGENT_DIR,
          expect.any(Object),
          expect.objectContaining({
            authProfileMode: "token",
            preparedModelRuntime: expect.objectContaining({
              configuredRuntimeModels: [],
              inlineProviderModels: [],
            }),
          }),
        );
        expect(handed).toHaveProperty(
          "preparedModelRuntime",
          btw.expectRecordFields(btw.mockArg(btw.resolveModelAsyncMock, 0, 4), {})
            .preparedModelRuntime,
        );
        expect(handed.sessionFile).toContain("session-1.jsonl");
        expectPreparedAuth(supports, {
          source: "profile",
          mode: "token",
          requirement: "subscription",
        });
      }
    },
  );

  it("exposes block-streamed side-question usage without mutating the parent session", async () => {
    const tokens = { input: 13, output: 9, cacheRead: 7, cacheWrite: 3 };
    const usage = { ...tokens, total: 41 };
    const cost = { input: 0.1, output: 0.1, cacheRead: 0.03, cacheWrite: 0.02, total: 0.25 };
    const text = "Side answer.";
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    const done = btw.createDoneEvent(text);
    done.message.usage = { ...tokens, totalTokens: 41, cost };
    btw.streamSimpleMock.mockReturnValue(
      btw.makeAsyncEvents([
        { type: "text_delta", delta: text },
        { type: "text_end", content: text, contentIndex: 0 },
        done,
      ]),
    );
    const runId = "btw-usage-reply-direct-block";
    const authorityRunId = "btw-usage-authority-direct-block";
    const sessionEntry = btw.createSessionEntry({ inputTokens: 200, cacheRead: 100 });
    const originalEntry = structuredClone(sessionEntry);
    const diagnostics: unknown[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        diagnostics.push(event);
      }
    });
    try {
      await expect(
        btw.runSideQuestion({
          cfg: { diagnostics: { enabled: undefined } },
          sessionEntry,
          authorityRunId,
          blockReplyChunking: { minChars: 1, maxChars: 200, breakPreference: "paragraph" },
          resolvedBlockStreamingBreak: "text_end",
          opts: { runId, onBlockReply },
        }),
      ).resolves.toEqual(undefined);
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text,
        btw: { question: btw.DEFAULT_QUESTION },
      });
      expect
        .soft(consumeReplyUsageState(runId))
        .toMatchObject({ usage, sessionId: "session-1", turnUsd: 0.25 });
      expect(consumeReplyUsageState(authorityRunId)).toBeUndefined();
      expect(sessionEntry).toEqual(originalEntry);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(diagnostics).toEqual([
        expect.objectContaining({
          type: "model.usage",
          sessionId: "session-1",
          usage: { ...usage, promptTokens: 23 },
          costUsd: 0.25,
        }),
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("keeps an unprofiled subscription token on the OpenClaw BTW path", async () => {
    const supports = vi.fn(btw.supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({ supports });
    const subscriptionModel = createOpenAIModel(true);
    btw.resolveModelWithRegistryMock.mockReturnValue(subscriptionModel);
    btw.resolveModelAsyncMock.mockResolvedValue({ model: subscriptionModel });
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    btw.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    btw.getApiKeyForModelMock.mockResolvedValue(
      authResult("subscription-token", "token", "models.json"),
    );
    btw.requireApiKeyMock.mockReturnValue("subscription-token");
    btw.mockDoneAnswer("OpenClaw side answer.");

    await expect(
      runOpenAISideQuestion({
        cfg: {
          models: {
            providers: {
              openai: { auth: "token", apiKey: "subscription-token" },
            },
          },
        } as never,
      }),
    ).resolves.toEqual({ text: "OpenClaw side answer." });

    expect(codexSideQuestionMock).not.toHaveBeenCalled();
    expect(btw.streamSimpleMock).toHaveBeenCalled();
    expectPreparedAuth(supports, { source: "direct", mode: "token", requirement: "subscription" });
  });

  it("lets native Codex bootstrap auth without a host profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) => {
      if (ctx.modelProvider?.preparedAuth?.source !== "harness") {
        return btw.supportsPreparedOpenAIAuth(ctx);
      }
      return ctx.modelProvider.requestTransportOverrides === "none" &&
        ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "deferred route support is missing" };
    });
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      authBootstrap: "harness",
      supports,
    });
    const platformModel = createOpenAIModel();
    btw.resolveModelWithRegistryMock.mockReturnValue(platformModel);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    btw.getApiKeyForModelMock.mockResolvedValue(authResult(undefined, "api-key", "none"));

    await expect(runOpenAISideQuestion()).resolves.toEqual({
      text: "Codex side answer.",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    const preparedRuntimeAuth = sideQuestionArgs(codexSideQuestionMock).preparedRuntimeAuth;
    expect(preparedRuntimeAuth?.plan).toMatchObject({
      harnessAuthProvider: "openai",
    });
    expect(preparedRuntimeAuth?.plan?.forwardedAuthProfileId).toBeUndefined();
    expect(preparedRuntimeAuth?.resolvedApiKey).toBeUndefined();
    expect(Object.keys(preparedRuntimeAuth?.authProfileStore?.profiles ?? {})).toEqual([]);
    expectPreparedAuth(supports, { source: "harness" });
  });

  it("hands a Codex side question the resolved Platform backup after subscription failure", async () => {
    const supports = vi.fn(btw.supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness({
      supports,
    });
    const subscriptionModel = createOpenAIModel(true);
    const platformModel = createOpenAIModel();
    btw.ensureAuthProfileStoreMock.mockReturnValue(
      authStore(
        {
          "openai:subscription": subscriptionToken("unresolved-token"),
          "openai:platform": createApiKeyCredential("openai", "platform-key"),
        },
        { openai: ["openai:subscription", "openai:platform"] },
      ),
    );
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.resolveModelWithRegistryMock.mockReturnValue(platformModel);
    btw.resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileId?: string },
      ) => ({
        model: options?.authProfileId === "openai:subscription" ? subscriptionModel : platformModel,
      }),
    );
    btw.getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string }) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      return {
        apiKey: "platform-key",
        mode: "api-key",
        source: "profile:openai:platform",
        profileId: "openai:platform",
      };
    });

    await expect(
      runOpenAISideQuestion({
        cfg: {
          auth: { order: { openai: ["openai:subscription", "openai:platform"] } },
          ...harnessConfig("codex"),
        } as never,
        sessionKey: btw.DEFAULT_SESSION_KEY,
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    const sideQuestionParams = sideQuestionArgs(codexSideQuestionMock);
    expect(sideQuestionParams.runtimeModel).toMatchObject(platformModel);
    expect(sideQuestionParams.authProfileId).toBeUndefined();
    expect(sideQuestionParams.preparedRuntimeAuth).toMatchObject({
      resolvedApiKey: "platform-key",
      plan: { modelRoute: { authRequirement: "api-key" } },
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual([]);
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
    expectPreparedAuth(supports, { source: "profile", mode: "api-key", requirement: "api-key" });
  });

  it("uses registry ownership and closes host capabilities when a BTW hook rejects", async () => {
    btw.registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed BTW harness",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
        runSideQuestion: vi.fn().mockRejectedValue(new Error("side question failed")),
      },
      { ownerPluginId: "actual-owner" },
    );

    await expect(btw.runSideQuestion()).rejects.toThrow("side question failed");

    expectCallFields(btw.createAgentHarnessHostCapabilitiesMock, { pluginId: "actual-owner" });
    expect(btw.closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = btw.registerCodexSideQuestionHarness();
    btw.mockOpenAIPlatformProfile();
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    btw.resolveModelAsyncMock.mockResolvedValue({ model: createOpenAIModel() });
    await btw.runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": {
                toolsBySender: {
                  "id:restricted-sender": { deny: ["*"] },
                },
              },
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(btw.mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({ toolsAllow: [] });
  });

  it("does not fall back to the direct provider call when Codex lacks BTW support", async () => {
    btw.registerAgentHarness({
      id: "codex",
      label: "Codex test harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    await expect(runOpenAISideQuestion({ sessionKey: btw.DEFAULT_SESSION_KEY })).rejects.toThrow(
      'Selected agent harness "codex" does not support /btw side questions.',
    );
    expectUncalled(btw.streamSimpleMock, btw.registerProviderStreamForModelMock);
  });

  it("rejects CLI session forks before backend preparation or provider I/O", async () => {
    btw.mockCliOutput({ text: "CLI side answer." });
    const params = {
      cfg: btw.createCliRuntimeConfig(),
      model: "claude-opus-4-7",
    };

    await expect(btw.runSideQuestion({ ...params, toolCalls: "deny" })).rejects.toThrow(
      "Session forks are not supported for CLI runtime claude-cli",
    );
    expectUncalled(
      btw.prepareCliRunContextMock,
      executePreparedCliRunMock,
      btw.streamSimpleMock,
      btw.registerProviderStreamForModelMock,
    );

    await expect(btw.runSideQuestion(params)).resolves.toEqual({ text: "CLI side answer." });
    expect(executePreparedCliRunMock).toHaveBeenCalledOnce();
  });

  it("answers ordinary CLI BTW without a side-question tool mode when the backend has no native tools", async () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "no-tools-cli",
          modelProvider: "anthropic",
          config: { command: "no-tools-cli" },
          nativeToolMode: "none",
          ownsNativeCompaction: false,
        },
      ],
    });
    try {
      const { cleanup } = mockCliOutput({ text: "No-tools CLI side answer." });

      await expect(
        runSideQuestion({
          cfg: createCliRuntimeConfig(),
          model: "claude-opus-4-7",
        }),
      ).resolves.toEqual({ text: "No-tools CLI side answer." });

      expect(prepareCliRunContextMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "side-question", disableTools: true }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
      expect(streamSimpleMock).not.toHaveBeenCalled();
    } finally {
      cliBackendsTesting.resetDepsForTest();
    }
  });

  it.each([
    { options: { timeoutOverrideSeconds: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideMs: 0 }, expected: MAX_TIMER_TIMEOUT_MS },
    { options: { timeoutOverrideSeconds: 1800, timeoutOverrideMs: 1500 }, expected: 1500 },
  ])(
    "preserves the timeout override $options for CLI-runtime BTW",
    async ({ options, expected }) => {
      btw.mockCliOutput({ text: "CLI side answer." });

      await runCliSideQuestion({
        opts: options,
        sessionKey: btw.DEFAULT_SESSION_KEY,
      });

      btw.expectRecordFields(btw.mockArg(btw.prepareCliRunContextMock, 0, 0), {
        timeoutMs: expected,
        runTimeoutOverrideMs: expected,
      });
    },
  );

  it("does not expose raw CLI BTW output when transformed text is empty", async () => {
    const { cleanup } = btw.mockCliOutput({
      text: "   ",
      rawText: "raw untransformed answer",
    });

    await expect(runCliSideQuestion({ sessionKey: btw.DEFAULT_SESSION_KEY })).rejects.toThrow(
      "/btw side question via claude-cli produced no answer",
    );

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
  });

  it("preserves auto-selected session CLI BTW routing before resolving runtime auth", async () => {
    const { cleanup } = btw.mockCliOutput({ text: "Session Claude CLI answer." });
    const sessionEntry = btw.createSessionEntry({
      authProfileOverride: "anthropic:auto-cli",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [btw.DEFAULT_SESSION_KEY]: sessionEntry };
    btw.resolveSessionAuthSelectionMock.mockImplementation(
      async (params: { sessionEntry?: SessionEntry }) => {
        if (params.sessionEntry) {
          params.sessionEntry.authProfileOverride = "anthropic:api";
          params.sessionEntry.authProfileOverrideSource = "auto";
        }
        return {
          profileId: "anthropic:api",
          source: "auto",
          routeRequirement: "api-key",
        };
      },
    );
    btw.mockDoneAnswer("Generic fallback answer.");

    const result = await btw.runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:auto-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry,
      sessionStore,
      sessionKey: btw.DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Session Claude CLI answer." });
    btw.expectRecordFields(btw.mockArg(btw.prepareCliRunContextMock, 0, 0), {
      provider: "claude-cli",
      executionMode: "side-question",
      authProfileId: "anthropic:auto-cli",
    });
    expect(btw.resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(btw.getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(btw.streamSimpleMock).not.toHaveBeenCalled();
  });

  it("loads Claude CLI auth for BTW from persisted auth-store order", async () => {
    const staticAuthStore = authStore({}, { anthropic: ["anthropic:claude-cli"] });
    const claudeAuthStore = authStore({
      "anthropic:claude-cli": oauth("claude-cli", "claude-cli-access", "claude-cli-refresh"),
    });
    btw.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValueOnce(staticAuthStore);
    btw.ensureAuthProfileStoreMock.mockReturnValueOnce(claudeAuthStore);
    btw.getApiKeyForModelMock.mockResolvedValueOnce(
      authResult(
        "claude-cli-access",
        "oauth",
        "profile:anthropic:claude-cli",
        "anthropic:claude-cli",
      ),
    );
    btw.requireApiKeyMock.mockReturnValueOnce("claude-cli-access");
    btw.resolveSessionAuthSelectionMock.mockResolvedValueOnce(undefined);
    btw.resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: btw.DEFAULT_PROVIDER,
        id: btw.DEFAULT_MODEL,
        api: "anthropic-messages",
      },
    });
    btw.mockDoneAnswer("Claude CLI answer.");

    const result = await btw.runSideQuestion();

    expect(result).toEqual({ text: "Claude CLI answer." });
    expect(btw.ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledWith(
      btw.DEFAULT_AGENT_DIR,
      { allowKeychainPrompt: false },
    );
    expect(btw.ensureAuthProfileStoreMock).toHaveBeenCalledWith(btw.DEFAULT_AGENT_DIR, {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(btw.getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:claude-cli",
        store: claudeAuthStore,
      }),
    );
  });

  it("rematerializes the direct model when automatic auth rotates to a SecretRef backup", async () => {
    const authStorage = { id: "btw-auth-storage" };
    const modelRegistry = { id: "btw-model-registry" };
    const store = authStore(
      {
        "anthropic:primary": createApiKeyCredential("anthropic", "primary-key"),
        "anthropic:backup": {
          type: "api_key" as const,
          provider: "anthropic",
          keyRef: {
            source: "file" as const,
            provider: "vault",
            id: "/anthropic/backup",
          },
        },
      },
      { anthropic: ["anthropic:primary", "anthropic:backup"] },
    );
    const rotatedModel = {
      provider: "anthropic",
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages" as const,
      baseUrl: "https://backup.example.test",
      name: "Backup profile model",
    };
    btw.discoverAuthStorageMock.mockReturnValue(authStorage);
    btw.discoverModelsMock.mockReturnValue(modelRegistry);
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: btw.DEFAULT_MODEL,
      api: "anthropic-messages",
      baseUrl: "https://primary.example.test",
      name: "Primary profile model",
    });
    btw.resolveModelAsyncMock.mockResolvedValue({
      model: rotatedModel,
      authStorage,
      modelRegistry,
    });
    btw.ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(store);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string } = {}) => {
        if (authParams.profileId === "anthropic:primary") {
          throw new Error("primary credential resolution failed");
        }
        if (authParams.profileId === "anthropic:backup") {
          return {
            apiKey: mintSecretSentinel("backup-secret", { label: "btw-backup" }),
            mode: "api-key",
            source: "profile:anthropic:backup",
            profileId: "anthropic:backup",
          };
        }
        throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
      },
    );
    btw.requireApiKeyMock.mockReturnValue("backup-secret");
    btw.mockDoneAnswer("Backup answer.");

    await expect(
      btw.runSideQuestion({
        cfg: {
          secrets: {
            providers: {
              vault: { source: "file", path: "/tmp/btw-secrets.json", mode: "json" },
            },
          },
        } as never,
      }),
    ).resolves.toEqual({ text: "Backup answer." });

    expect(
      btw.getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["anthropic:primary", "anthropic:backup"]);
    expect(btw.resolveModelAsyncMock).toHaveBeenCalledWith(
      "anthropic",
      btw.DEFAULT_MODEL,
      btw.DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "anthropic:backup",
        authProfileMode: "api_key",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
        skipAgentDiscovery: true,
      }),
    );
    btw.expectRecordFields(
      (btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        provider: "anthropic",
        modelId: btw.DEFAULT_MODEL,
        model: rotatedModel,
        profileId: "anthropic:backup",
        apiKey: "backup-secret",
      },
    );
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 0), {
      name: "Backup profile model",
      baseUrl: "https://backup.example.test",
    });
  });

  it("uses a same-route literal fallback only after its prepared profile tier fails", async () => {
    const platformModel = { ...createOpenAIModel(), name: "Platform model" };
    const store = authStore(
      { "openai:broken": createApiKeyCredential("openai", "broken-profile-key") },
      { openai: ["openai:broken"] },
    );
    btw.resolveModelWithRegistryMock.mockReturnValue(platformModel);
    btw.resolveModelAsyncMock.mockResolvedValue({ model: platformModel });
    btw.ensureAuthProfileStoreMock.mockReturnValue(store);
    btw.resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    btw.resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    btw.getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string; allowAuthProfileFallback?: boolean }) => {
        if (authParams.profileId === "openai:broken") {
          throw new Error("profile key could not be resolved");
        }
        if (authParams.profileId === undefined && authParams.allowAuthProfileFallback === false) {
          return {
            apiKey: "literal-key",
            mode: "api-key",
            source: "models.json",
          };
        }
        throw new Error("unexpected auth lookup");
      },
    );
    btw.requireApiKeyMock.mockReturnValue("literal-key");
    btw.mockDoneAnswer("Literal fallback answer.");

    await expect(
      btw.runSideQuestion({
        cfg: {
          auth: { order: { openai: ["openai:broken"] } },
          models: {
            providers: {
              openai: { apiKey: "literal-key" },
            },
          },
          ...harnessConfig("openclaw"),
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Literal fallback answer." });

    expect(
      btw.getApiKeyForModelMock.mock.calls.map(([authParams]) => {
        const lookup = authParams as {
          profileId?: string;
          allowAuthProfileFallback?: boolean;
        };
        return {
          profileId: lookup.profileId,
          allowAuthProfileFallback: lookup.allowAuthProfileFallback,
        };
      }),
    ).toEqual([
      { profileId: "openai:broken", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
    btw.expectRecordFields(btw.mockArg(btw.streamSimpleMock, 0, 0), {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it.each([{ label: "legacy source-less", source: undefined }])(
    "keeps $label user-pinned static Anthropic auth first for BTW",
    async ({ source }) => {
      const staticAuthStore = authStore({
        "anthropic:api": createApiKeyCredential("anthropic", "static-key"),
      });
      btw.ensureAuthProfileStoreMock.mockReturnValueOnce(staticAuthStore);
      btw.getApiKeyForModelMock.mockResolvedValueOnce(
        authResult("static-key", "api-key", "profile:anthropic:api", "anthropic:api"),
      );
      btw.requireApiKeyMock.mockReturnValueOnce("static-key");
      btw.resolveSessionAuthSelectionMock.mockResolvedValueOnce({
        profileId: "anthropic:api",
        source: "user",
        routeRequirement: "api-key",
      });
      btw.mockDoneAnswer("Static answer.");

      await btw.runSideQuestion({
        cfg: {
          auth: {
            order: { anthropic: ["anthropic:claude-cli"] },
            profiles: {
              "anthropic:api": { provider: "anthropic", mode: "api_key" },
              "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
            },
          },
        } as never,
        sessionEntry: btw.createSessionEntry({
          authProfileOverride: "anthropic:api",
          authProfileOverrideSource: source,
        }),
      });

      expect(btw.ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
      expect(btw.ensureAuthProfileStoreMock).toHaveBeenCalledWith(btw.DEFAULT_AGENT_DIR, {
        profileId: "anthropic:api",
        externalCliProviderIds: ["claude-cli"],
        allowKeychainPrompt: false,
      });
      btw.expectRecordFields(btw.mockArg(btw.getApiKeyForModelMock, 0, 0), {
        profileId: "anthropic:api",
        store: staticAuthStore,
      });
      btw.expectRecordFields(
        (btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
        {
          profileId: "anthropic:api",
          authMode: "api-key",
        },
      );
    },
  );

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    const model = {
      provider: "github-copilot",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    };
    btw.resolveModelWithRegistryMock.mockReturnValue(model);
    btw.resolveModelAsyncMock.mockResolvedValue({ model });
    btw.getApiKeyForModelMock.mockResolvedValue(
      authResult("github-token", "token", "profile", "github-copilot:github"),
    );
    btw.requireApiKeyMock.mockReturnValue("github-token");
    btw.prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    btw.mockDoneAnswer("Copilot answer.");

    const result = await btw.runSideQuestion({
      provider: "github-copilot",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    const runtimeAuthParams = btw.expectRecordFields(
      btw.mockArg(btw.prepareProviderRuntimeAuthMock, 0, 0),
      {
        provider: "github-copilot",
        workspaceDir: "/tmp/workspace",
      },
    );
    btw.expectRecordFields(runtimeAuthParams.context, {
      provider: "github-copilot",
      modelId: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      apiKey: "github-token",
      authMode: "token",
      profileId: "github-copilot:github",
    });
    const [streamModel, , streamOptions] = btw.mockCall(btw.streamSimpleMock);
    btw.expectRecordFields(streamModel, {
      provider: "github-copilot",
      id: "gpt-5.4",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const streamKey = (streamOptions as { apiKey?: string }).apiKey ?? "";
    expect(looksLikeSecretSentinel(streamKey)).toBe(true);
    expect(streamKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(streamKey)).toBe("copilot-runtime-token");
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    btw.mockDoneAnswer("Final answer.");

    await btw.runSideQuestion();

    const options = btw.mockArg(btw.streamSimpleMock, 0, 2);
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    btw.resolveModelWithRegistryMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      api: "anthropic-messages",
    });
    btw.getApiKeyForModelMock.mockResolvedValue(
      authResult(undefined, "aws-sdk", "aws-sdk default chain"),
    );
    btw.streamSimpleMock.mockReturnValue(
      btw.makeAsyncEvents([btw.createDoneEvent("Bedrock answer.")]),
    );

    const result = await btw.runSideQuestion({
      cfg: {},
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(btw.requireApiKeyMock).not.toHaveBeenCalled();
    const options = btw.streamSimpleMock.mock.calls.at(-1)?.[2];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    btw.clearBuiltSessionMessages();
    btw.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    btw.mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await btw.runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    const [message] = btw.contextMessages(btw.streamContext());
    btw.expectRecordFields(message, { role: "user" });
    btw.expectTextBlockContains(
      expectDefined(
        (expectDefined(message, "message test invariant").content as Array<unknown>)[0],
        "(message.content as Array<unknown>)[0] test invariant",
      ),
      "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
    );
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    const assistantEntry = assistantTranscript("assistant-1", "seed answer");
    const trailingUserEntry = btw.createTranscriptEntry({
      id: "user-2",
      parentId: "assistant-1",
      message: btw.createUserTranscriptMessage([{ type: "text", text: "unfinished task" }]),
    });
    btw.mockTranscriptEntries([assistantEntry, trailingUserEntry]);
    await expectMathBranch([assistantEntry], true);
  });

  it("rejects a supplied session key that disagrees with an incomplete SQLite marker target", async () => {
    const markerStorePath = "/tmp/marker-sessions.sqlite";
    btw.listSessionEntriesCoreMock.mockReturnValue([
      {
        sessionKey: "agent:main:matching",
        entry: btw.createSessionEntry(),
      },
    ]);
    btw.loadSessionEntryMock.mockReturnValue(
      btw.createSessionEntry({ sessionId: "different-session" }),
    );

    await expect(
      btw.runMathSideQuestion({
        sessionEntry: btw.createSessionEntry({
          sessionFile: `sqlite:main:session-1:${markerStorePath}`,
        }),
        storePath: undefined,
      }),
    ).rejects.toThrow("No active session context.");

    expect(btw.listSessionEntriesCoreMock).toHaveBeenCalledWith({
      agentId: "main",
      storePath: markerStorePath,
    });
    expect(btw.loadSessionEntryMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: btw.DEFAULT_SESSION_KEY,
      storePath: markerStorePath,
    });
    expect(btw.loadTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    btw.mockTranscriptEntries([userEntry, assistantEntry]);
    btw.getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    await expectMathBranch([userEntry, assistantEntry], true);
    expect(btw.diagDebugMock).toHaveBeenCalledWith(
      "btw snapshot leaf unavailable: sessionId=session-1 leaf=assistant-gone",
    );
  });

  it("keeps visible history after continuing from a disjoint opaque append cursor", async () => {
    const { userEntry, assistantEntry } = createSeedTranscript();
    const sideEntry = assistantTranscript("side-delivery", "side delivery", "assistant-seed");
    const metadataEntry = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: "side-delivery",
    };
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
      appendParentId: "plugin-metadata",
    };
    const continuationEntry = assistantTranscript(
      "assistant-continuation",
      "continued answer",
      "plugin-metadata",
    );
    btw.mockTranscriptEntries([
      userEntry,
      assistantEntry,
      sideEntry,
      metadataEntry,
      leafEntry,
      continuationEntry,
    ]);
    await expectMathBranch([
      userEntry,
      assistantEntry,
      { ...continuationEntry, parentId: "assistant-seed" },
    ]);
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
      {
        role: "toolResult",
        content: [{ type: "text", text: "sensitive tool output" }],
        details: { raw: "secret" },
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 3,
      },
    ]);
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    await btw.runMathSideQuestion();

    const messages = btw.contextMessages(btw.streamContext());
    expect(messages).toMatchObject([{ role: "user" }, { role: "assistant" }, { role: "user" }]);
  });

  it("strips assistant tool calls from fallback BTW context so stale calls are not replayed", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
      btw.createAssistantTranscriptMessage(
        [
          { type: "text", text: "Let me check." },
          { type: "thinking", thinking: "Hidden chain of thought" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
          { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    btw.mockDoneAnswer(btw.MATH_ANSWER);

    await btw.runMathSideQuestion();

    const context = btw.streamContext();
    btw.expectSanitizedAssistantContext(context, "Let me check.");
  });

  it.each([
    [
      "embedded tool results",
      [
        { type: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "secret" }] },
        { type: "tool_result", toolUseId: "call_2", content: [{ type: "text", text: "secret-2" }] },
      ],
    ],
    ["malformed image", [{ type: "image", mimeType: "image/png" }]],
  ] as const)("strips %s from user context", async (_label, blocks) => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage([{ type: "text", text: "seed" }, ...blocks]),
    ]);
    btw.expectSeedOnlyUserContext(await btw.runMathSideQuestionAndCaptureContext());
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    btw.mockActiveTranscript([
      btw.createUserTranscriptMessage(),
      btw.createAssistantTranscriptMessage(
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await btw.runMathSideQuestionAndCaptureContext();

    btw.expectNoAssistantMessages(context);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
