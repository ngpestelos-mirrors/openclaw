import "./system-agent.mocks.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { applyWizardMetadata } from "../../commands/onboard-helpers.js";
import { createConfigIO, readConfigFileSnapshot } from "../../config/config.js";
import {
  hashRuntimeConfigValue,
  setRuntimeConfigAppliedHash,
} from "../../config/runtime-snapshot.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import * as hostedSetup from "../../system-agent/hosted-setup.runtime.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { detectSetupInference } from "../../system-agent/setup-inference-detect.js";
import type { ActivateSetupInferenceParams } from "../../system-agent/setup-inference.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { WizardSession } from "../../wizard/session.js";
import * as setupAdmission from "./setup-admission.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import {
  callChat,
  defaultClient,
  inferenceFallbackMocks,
  makeContext,
  makeRespond,
  setupInferenceDetectionMocks,
  setupInferenceMocks,
  systemAgentHandler,
  systemAgentLane,
  transcriptStoreMocks,
  useSystemAgentGatewayTestFixture,
  verifiedConfig,
} from "./system-agent.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const {
  systemAgentTempDirs,
  requireVerifiedInferenceFixture,
  requireVerifiedInferenceDeps,
  makeVerifiedEngine,
  seededSession,
} = useSystemAgentGatewayTestFixture();

function makeWizardContext() {
  const wizardSessions = new Map<string, WizardSession>();
  return {
    wizardSessions,
    context: {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

function request(
  method: Parameters<typeof systemAgentHandler>[0],
  params: Record<string, unknown> = {},
  options: Omit<Partial<Parameters<ReturnType<typeof systemAgentHandler>>[0]>, "context"> & {
    context?: Partial<GatewayRequestContext>;
  } = {},
) {
  const { calls, respond } = makeRespond();
  const pending = systemAgentHandler(method)({ params, respond, ...options } as never);
  return { calls, pending };
}

const reply = (payload: unknown) => ({ ok: true, payload, error: undefined });
const busyReply = {
  ok: false,
  payload: undefined,
  error: {
    code: "UNAVAILABLE",
    message: "OpenClaw setup is already in progress; try again when it finishes.",
    details: { code: "SETUP_ADMISSION_BUSY" },
    retryable: true,
  },
};

async function whileSetupBusy(check: () => Promise<void>) {
  const started = createDeferred();
  const release = createDeferred();
  const owner = setupAdmission.runExclusiveSystemAgentSetupActivation(async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  try {
    await check();
  } finally {
    release.resolve();
    await owner;
  }
}

function chatSession(engine = makeVerifiedEngine()) {
  const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
  const context = makeContext(sessions);
  return {
    sessions,
    chat: (params: Record<string, unknown>) => callChat(context, { sessionId: "s1", ...params }),
  };
}

function makeEngine(
  options: Omit<
    ConstructorParameters<typeof SystemAgentChatEngine>[0],
    "verifiedInference" | "deps"
  >,
) {
  return new SystemAgentChatEngine({
    verifiedInference: requireVerifiedInferenceFixture(),
    deps: requireVerifiedInferenceDeps(),
    ...options,
  });
}

const activationResult = (modelRef = "openai/gpt-5.6-luna", latencyMs = 1, lines: string[] = []) =>
  ({ ok: true, modelRef, latencyMs, lines }) as const;
const examplePlugin = { id: "example", name: "Example" };
const accountSetting = { path: ["accounts", "name.with.dots"], label: "Account" };

const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function configLocation() {
  const stateDir = systemAgentTempDirs.make("openclaw-setup-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  return { stateDir, configPath };
}

async function makeVerificationContext() {
  const { configPath } = configLocation();
  fs.writeFileSync(configPath, "{}\n");
  const snapshot = await readConfigFileSnapshot();
  setRuntimeConfigAppliedHash(hashRuntimeConfigValue(snapshot.sourceConfig));
  return {
    configPath,
    getRuntimeConfig: vi.fn(() => snapshot.runtimeConfig ?? snapshot.config),
    isConfigReloadSettled: vi.fn(() => true),
  };
}

async function runSensitiveChannelSetup(_channel: string, prompter: WizardPrompter) {
  await prompter.text({ message: "Bot token", sensitive: true });
  return "applied" as const;
}

function stubEngineOverview() {
  return vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockResolvedValue({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { available: false },
      claude: { available: false },
      gemini: { available: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  } as never);
}

describe("openclaw.setup", () => {
  it.each([undefined, false, true])(
    "uses verified client locality for custom auth (%s)",
    async (isLocalClient) => {
      setupInferenceMocks.activateSetupInference.mockResolvedValue({
        ok: false,
        status: "unavailable",
        error: "Synthetic end of setup",
      });
      const { wizardSessions, context } = makeWizardContext();
      const sessionId = `custom-auth-${String(isLocalClient)}`;
      const { calls, pending } = request(
        "openclaw.setup.auth.start",
        { sessionId, authChoice: "custom-api-key" },
        { client: { ...defaultClient, internal: { isLocalClient } }, context },
      );
      await pending;
      expect(calls).toMatchObject([{ ok: true, payload: { sessionId } }]);
      const session = expectDefined(wizardSessions.get(sessionId), "admitted setup session");
      await session.next();
      expect(setupInferenceMocks.activateSetupInference).toHaveBeenLastCalledWith(
        expect.objectContaining({
          authChoice: "custom-api-key",
          isRemoteProviderAuth: isLocalClient !== true,
        }),
      );
    },
  );

  it("delivers activation completion only after setup admission settles", async () => {
    const taskFinished = createDeferred();
    const admissionSettled = createDeferred();
    const admission = vi.spyOn(setupAdmission, "runExclusiveSystemAgentSetupActivation");
    admission.mockImplementation(async <T>(task: () => Promise<T>) => {
      const result = await task();
      taskFinished.resolve();
      await admissionSettled.promise;
      return result;
    });
    const result = activationResult("openai/fixture");
    setupInferenceMocks.activateSetupInference.mockResolvedValue(result);
    const { calls, pending } = request("openclaw.setup.activate", { kind: "claude-cli" });
    try {
      await taskFinished.promise;
      expect(calls).toEqual([]);
    } finally {
      admissionSettled.resolve();
      await pending;
      admission.mockRestore();
    }
    expect(calls).toEqual([reply(result)]);
  });

  it.each([
    ["openclaw.setup.activate" as const, { kind: "claude-cli" }],
    ["openclaw.setup.activate.start" as const, { sessionId: "busy-activation", kind: "codex-cli" }],
    [
      "openclaw.setup.auth.start" as const,
      { sessionId: "busy-auth", authChoice: "github-copilot" },
    ],
    ["openclaw.setup.prepare.start" as const, { sessionId: "busy-prepare", authChoice: "ollama" }],
  ])("rejects %s before creating a wizard session when setup is busy", async (method, params) => {
    const { wizardSessions, context } = makeWizardContext();
    await whileSetupBusy(async () => {
      const { calls, pending } = request(method, params, { context });
      await pending;
      expect(calls).toEqual([busyReply]);
      expect(wizardSessions.size).toBe(0);
    });
  });
});

describe("openclaw.chat", () => {
  let pendingDiscovery: Promise<void> | undefined;

  afterEach(async () => {
    // A timeout does not cancel the body. Join it before the outer fixture resets
    // mocks and env, so its lazy RPC import cannot overlap the next case's import.
    if (pendingDiscovery) {
      await Promise.allSettled([pendingDiscovery]);
      pendingDiscovery = undefined;
    }
  });

  it("refuses to create a session before inference is available", async () => {
    inferenceFallbackMocks.verify.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "OpenClaw requires working inference: no configured model",
        details: {
          code: "system_agent_inference_unavailable",
        },
      },
    });
    expect(sessions.size).toBe(0);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
  });

  it("coalesces concurrent initialization for the same session", async () => {
    stubEngineOverview();
    const started = createDeferred();
    const release = createDeferred();
    inferenceFallbackMocks.verify.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await waitOneTask();
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect([firstCall.ok, secondCall.ok]).toEqual([true, true]);
  });

  it.each(["none", "doctor"])(
    "returns unchecked discovery through selected-agent detection after %s metadata",
    (metadataCommand) => {
      pendingDiscovery = (async () => {
        const { stateDir, configPath } = configLocation();
        const io = createConfigIO({
          env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: stateDir },
          homedir: () => stateDir,
        });
        // Exercise first-write privacy separately from roster arrangement: the
        // ownership-transition writer also runs unrelated legacy cron migration.
        await io.writeConfigFile(
          metadataCommand === "doctor"
            ? applyWizardMetadata({}, { command: "doctor", mode: "local" })
            : {},
        );
        const { sourceConfig } = await io.readConfigFileSnapshot();
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            ...sourceConfig,
            agents: {
              ...sourceConfig.agents,
              ownership: "explicit",
              entries: { main: {}, research: {} },
            },
          }),
        );
        const before = fs.readFileSync(configPath, "utf8");
        const backends = await import("../../commands/onboard-inference.js");
        const providerChoices = await import("../../plugins/provider-auth-choices.js");
        const detectInferenceBackends = vi
          .spyOn(backends, "detectInferenceBackends")
          .mockResolvedValue([]);
        vi.spyOn(providerChoices, "resolveManifestProviderAuthChoices").mockReturnValue([]);
        setupInferenceDetectionMocks.detectSetupInferenceIsolated.mockImplementation(
          async (params) => detectSetupInference(params?.agentId),
        );
        const { calls, pending } = request("openclaw.setup.detect", { agentId: "research" });
        await pending;
        expect(calls).toMatchObject([
          {
            ok: true,
            payload: {
              nativeSessionCatalogPreferenceRequired: true,
              nativeSessionCatalogs: expect.arrayContaining([
                expect.objectContaining({ pluginId: "anthropic" }),
                expect.objectContaining({ pluginId: "codex" }),
              ]),
            },
          },
        ]);
        expect(detectInferenceBackends).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "research" }),
        );
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
        expect(setupInferenceMocks.activateSetupInference).not.toHaveBeenCalled();
      })();
      return pendingDiscovery;
    },
  );

  it("keeps read-only setup detection outside the serialized system-agent lane", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceDetectionMocks.detectSetupInferenceIsolated.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { setupComplete: false } as never;
    });
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.detect")({
      params: { agentId: "research" },
      respond: () => {
        activeAtResponse.push(systemAgentLane().activeCount);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(0);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([0]);
    const [detectOptions] =
      setupInferenceDetectionMocks.detectSetupInferenceIsolated.mock.calls[0]!;
    expect(detectOptions?.agentId).toBe("research");
  });

  it.each([
    { change: "unapplied revision", when: "before" },
    { change: "unknown revision", when: "before" },
    { change: "restart with unchanged config", when: "before" },
    { change: "unapplied revision", when: "during" },
    { change: "restart with unchanged config", when: "during" },
    { change: "replaced runtime", when: "during" },
  ])("rejects $change $when verification without false readiness", async ({ change, when }) => {
    const context = await makeVerificationContext();
    const changeRuntime = () => {
      if (change === "unapplied revision") {
        fs.writeFileSync(context.configPath, JSON.stringify({ logging: { level: "debug" } }));
      } else if (change === "unknown revision") {
        setRuntimeConfigAppliedHash(null);
      } else if (change === "replaced runtime") {
        context.getRuntimeConfig.mockReturnValue({ ...verifiedConfig });
      } else {
        context.isConfigReloadSettled.mockReturnValue(false);
      }
    };
    if (when === "before") {
      changeRuntime();
    } else {
      setupInferenceMocks.verifySetupInference.mockImplementationOnce(async () => {
        changeRuntime();
        return { ok: true, modelRef: "openai/gpt-5.6-luna", latencyMs: 1 };
      });
    }
    const { calls, pending } = request("openclaw.setup.verify", {}, { context });
    await pending;
    expect(calls).toEqual([
      reply({
        ok: false,
        status: "unavailable",
        error: expect.stringContaining("not active"),
      }),
    ]);
    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledTimes(
      when === "before" ? 0 : 1,
    );
  });

  it("keeps activation progress through application without relabeling the connection test", async () => {
    const installing = createDeferred();
    const startVerification = createDeferred();
    const verifying = createDeferred();
    const finishVerification = createDeferred();
    const applying = createDeferred();
    const finishApplication = createDeferred();
    let visibleProgress: string | undefined;
    const stopped: string[] = [];
    const prompter = createWizardPrompter({
      progress: (label) => {
        visibleProgress = label;
        return {
          update: (message) => {
            visibleProgress = message;
          },
          stop: () => {
            stopped.push(label);
          },
        };
      },
    });
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(
      async (params: ActivateSetupInferenceParams) => {
        params.onActivationStarted?.();
        installing.resolve();
        await startVerification.promise;
        const verification = params.prompter?.progress("Testing your AI connection…");
        verifying.resolve();
        await finishVerification.promise;
        verification?.stop();
        params.onActivationStarted?.();
        params.onActivationCompletion?.(async () => {
          applying.resolve();
          await finishApplication.promise;
          return false;
        });
        return activationResult("meta/muse-spark-1.3");
      },
    );
    const pending = activateGatewaySetupInference({
      kind: "provider-auth",
      authChoice: "meta/muse-code",
      surface: "gateway",
      runtime: defaultRuntime,
      prompter,
    });
    try {
      await installing.promise;
      expect(visibleProgress).toBe("Turning on your AI connection…");
      startVerification.resolve();
      await verifying.promise;
      expect(visibleProgress).toBe("Testing your AI connection…");
      finishVerification.resolve();
      await applying.promise;
      expect(visibleProgress).toBe("Turning on your AI connection…");
      expect(stopped).toEqual(["Testing your AI connection…"]);
    } finally {
      startVerification.resolve();
      finishVerification.resolve();
      finishApplication.resolve();
      await pending;
    }
    expect(stopped).toEqual(["Testing your AI connection…", "Turning on your AI connection…"]);
  });

  it.each(["applied", "restart-required", "failed"] as const)(
    "settles setup completion without holding its lane: %s",
    async (outcome) => {
      const release = createDeferred();
      const failure = new Error("activation completion failed");
      const result = activationResult();
      setupInferenceMocks.activateSetupInference.mockImplementation(
        async (params: ActivateSetupInferenceParams) => {
          params.onActivationCompletion?.(async () => {
            await release.promise;
            if (outcome === "failed") {
              throw failure;
            }
            return outcome === "restart-required";
          });
          return result;
        },
      );
      const { calls, pending } = request("openclaw.setup.activate", { kind: "codex-cli" });
      try {
        await vi.waitFor(() =>
          expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledOnce(),
        );
        await waitOneTask();
        expect(calls).toEqual([]);
        expect(systemAgentLane().activeCount).toBe(0);
        await request(
          "openclaw.setup.verify",
          { agentId: "research" },
          {
            context: await makeVerificationContext(),
          },
        ).pending;
        expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledOnce();
        expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledWith({
          agentId: "research",
          runtime: defaultRuntime,
        });
      } finally {
        release.resolve();
        if (outcome === "failed") {
          await expect(pending).rejects.toBe(failure);
        } else {
          await pending;
        }
      }
      expect(calls).toEqual(
        outcome === "failed"
          ? []
          : [
              reply(
                outcome === "restart-required"
                  ? { ...result, gatewayRestartRequired: true }
                  : result,
              ),
            ],
      );
    },
  );

  it.each([
    { outcome: "success", modelTarget: undefined },
    { outcome: "task error", modelTarget: undefined },
    { outcome: "response error", modelTarget: undefined },
    { outcome: "success", modelTarget: "utility" as const },
  ])(
    "keeps admitted $modelTarget setup on the gateway lane without relabeling $outcome as non-admission",
    async ({ outcome, modelTarget }) => {
      const failure = new Error("admitted operation failed");
      const started = createDeferred();
      const release = createDeferred();
      const result = activationResult("openai/gpt-5.5", 250, ["Default model: openai/gpt-5.5"]);
      setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
        started.resolve();
        await release.promise;
        if (outcome === "task error") {
          throw failure;
        }
        return result;
      });
      const { calls, respond } = makeRespond();
      const activeAtResponse: number[] = [];
      const params = {
        kind: "api-key",
        agentId: "research",
        ...(modelTarget ? { modelTarget } : {}),
        modelRef: "openai/gpt-5.5",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
      };
      const pending = systemAgentHandler("openclaw.setup.activate")({
        params,
        respond: (ok: boolean, payload?: unknown, error?: unknown) => {
          activeAtResponse.push(systemAgentLane().activeCount);
          if (outcome === "response error") {
            throw failure;
          }
          respond(ok, payload, error);
        },
      } as never);

      await started.promise;
      expect(systemAgentLane().activeCount).toBe(1);
      release.resolve();
      if (outcome === "success") {
        await pending;
      } else {
        await expect(pending).rejects.toBe(failure);
      }

      expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
        ...params,
        surface: "gateway",
        runtime: expect.objectContaining({ exit: expect.any(Function) }),
        onActivationStarted: expect.any(Function),
        onActivationCompletion: expect.any(Function),
      });
      expect(calls).toEqual(outcome === "success" ? [reply(result)] : []);
      expect(activeAtResponse).toEqual(outcome === "task error" ? [] : [0]);
      expect(systemAgentLane().activeCount).toBe(0);
    },
  );

  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it.each([
    {
      name: "trims and canonicalizes valid context without forwarding secrets",
      context: {
        page: "  /settings/channels  ",
        source: "client",
        plugin: {
          ...examplePlugin,
          config: { apiKey: "never forwarded" },
          setting: { ...accountSetting, value: "never forwarded" },
        },
      },
      expected: {
        page: "/settings/channels",
        plugin: { ...examplePlugin, setting: accountSetting },
      },
    },
    {
      name: "drops Unicode case-folding context without rejecting the turn",
      context: { page: "\u212A" },
      expected: undefined,
    },
    {
      name: "drops an invalid plugin id",
      context: { page: "plugin-settings", plugin: { ...examplePlugin, id: "bad?id" } },
      expected: { page: "plugin-settings" },
    },
    {
      name: "drops an overlong plugin name",
      context: { page: "plugin-settings", plugin: { ...examplePlugin, name: "n".repeat(97) } },
      expected: { page: "plugin-settings" },
    },
    {
      name: "bounds escaped plugin reference data before forwarding it",
      context: {
        page: "plugin-settings",
        plugin: {
          ...examplePlugin,
          setting: { path: Array(16).fill("\u0000".repeat(64)), label: "Large" },
        },
      },
      expected: { page: "plugin-settings", plugin: examplePlugin },
    },
  ])("$name", async ({ context, expected }) => {
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle").mockResolvedValue({ text: "Ready.", action: "none" });
    const call = await chatSession(engine).chat({ message: "Help with this", context });
    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith(
      "Help with this",
      ...(expected ? [{ uiContext: expected }] : []),
    );
  });

  it("persists completed turns from the engine's sanitized history", async () => {
    const engine = makeEngine({
      runAgentTurn: async () => ({ text: "Everything is healthy." }),
    });
    const { chat } = chatSession(engine);
    const call = await chat({
      message: "How is this machine doing?",
      context: { page: "dashboard", plugin: { ...examplePlugin, installed: false } },
    });

    expect(call.payload).toMatchObject({ reply: "Everything is healthy." });
    expect(transcriptStoreMocks.appendTurn.mock.calls).toEqual([
      [expect.objectContaining({ role: "user", text: "How is this machine doing?" })],
      [expect.objectContaining({ role: "assistant", text: "Everything is healthy." })],
    ]);
    expect(JSON.stringify(transcriptStoreMocks.appendTurn.mock.calls)).not.toMatch(
      /ui-context|plugin-reference|Example/,
    );
  });

  it("persists only the mask marker for a sensitive hosted-wizard answer", async () => {
    vi.spyOn(hostedSetup, "runHostedChannelSetup").mockImplementationOnce(runSensitiveChannelSetup);
    const engine = makeEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
    });
    const { chat } = chatSession(engine);
    const prompt = await chat({ message: "connect telegram" });
    expect(prompt.payload).toMatchObject({ sensitive: true, wizardInputPending: true });
    transcriptStoreMocks.appendTurn.mockClear();

    await chat({ message: "raw-secret-value" });

    const persisted = transcriptStoreMocks.appendTurn.mock.calls.map(([turn]) => turn);
    expect(persisted).toContainEqual(
      expect.objectContaining({ role: "user", text: "<redacted secret>" }),
    );
    expect(JSON.stringify(persisted)).not.toContain("raw-secret-value");
  });

  it("returns history oldest-first with default and explicit bounded limits", async () => {
    const turns = [
      { role: "user" as const, text: "one", at: 1 },
      { role: "assistant" as const, text: "two", at: 2 },
    ];
    transcriptStoreMocks.readTranscriptTailAsync.mockImplementation(async (limit: number) =>
      turns.slice(-limit),
    );
    const invoke = async (params: Record<string, unknown>) => {
      const { calls, pending } = request("openclaw.chat.history", params);
      await pending;
      return calls[0];
    };

    expect(await invoke({})).toEqual(reply({ turns }));
    expect(transcriptStoreMocks.readTranscriptTailAsync).toHaveBeenLastCalledWith(100);
    expect(await invoke({ limit: 1 })).toEqual(reply({ turns: [turns[1]] }));
    expect((await invoke({ limit: 501 }))?.ok).toBe(false);
  });

  it.each(["revoked", "rejected"] as const)(
    "does not disclose %s pending history",
    async (outcome) => {
      const read =
        createDeferred<Awaited<ReturnType<typeof transcriptStoreMocks.readTranscriptTailAsync>>>();
      transcriptStoreMocks.readTranscriptTailAsync.mockReturnValueOnce(read.promise);
      let current = true;
      const { calls, pending } = request(
        "openclaw.chat.history",
        {},
        {
          hasCurrentClientAuthority: () => current,
        },
      );
      expect(calls).toEqual([]);
      const error =
        outcome === "revoked" ? "Gateway requester authority changed" : "history reader refused";
      const rejected = expect(pending).rejects.toThrow(error);
      if (outcome === "revoked") {
        current = false;
        read.resolve([{ role: "assistant", text: "private history", at: 1 }]);
      } else {
        read.reject(new Error(error));
      }
      await rejected;
      expect(calls).toEqual([]);
    },
  );

  it("reuses a live session, then requires fresh fallback verification after failure", async () => {
    stubEngineOverview();
    const engine = makeEngine({
      runAgentTurn: async () => {
        throw new SystemAgentInferenceUnavailableError("agent-turn", [
          new Error("workspace owner openclaw is missing from the roster"),
        ]);
      },
    });
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const { sessions, chat } = chatSession(engine);
    const failed = await chat({ message: "status please" });

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("workspace owner openclaw is missing from the roster"),
        details: { code: "system_agent_session_invalidated" },
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
    expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();

    const retried = await chat({});

    expect(retried.ok).toBe(true);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(true);
  });

  it("does not relabel unrelated session failures as inference errors", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(new Error("wizard bug"));
    const { sessions, chat } = chatSession(engine);
    await expect(chat({ message: "status please" })).rejects.toThrow("wizard bug");
    expect(sessions.has("s1")).toBe(true);
  });
});
