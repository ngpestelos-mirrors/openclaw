import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { CompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import { SessionManager } from "../../sessions/session-manager.js";
import {
  createPromptCacheRequestObserver,
  type PromptCacheRequestObservation,
} from "../prompt-cache-request-observer.js";
import {
  getEmbeddedSessionPromptState,
  clearEmbeddedSessionPromptStates,
  prepareSessionSystemPrompt,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type {
  PromptPreflightCall,
  PromptSubmissionCall,
} from "./attempt-prompt-phase.test-support.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);

type PromptErrorCall = {
  error: unknown;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.applyPromptToolsAllow.mockReturnValue({
    activeToolNames: ["read"],
    callableToolNames: ["read"],
    effectiveTools: [{ name: "read" }],
    uncompactedEffectiveTools: [{ name: "read" }],
    tools: [{ name: "read" }],
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
});

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates([
    "phase-context-replay",
    "phase-system-update",
    "phase-finalization",
  ]);
});

describe("runEmbeddedAttemptPromptPhase", () => {
  it.each([false, true])(
    "wires final Decision withdrawal with in-history updates %s",
    async (inHistorySystemUpdates) => {
      const f = createFixture();
      const ownedSession = f.input.prepared.sessionRuntime.agentSession;
      const session = ownedSession.activeSession;
      session.agent.state.systemPrompt = "pruned prompt";
      session.agent.state.tools = [];
      if (inHistorySystemUpdates) {
        const state = getEmbeddedSessionPromptState("phase-system-update");
        const project = (systemPrompt: string) =>
          prepareSessionSystemPrompt({
            state,
            routeKey: "anthropic/claude-opus-5/anthropic-messages",
            systemPrompt,
            entries: [],
          });
        project("pruned prompt").commit();
        f.input.prepared.sessionRuntime.prepareSystemPromptUpdate = vi.fn(
          async (prompt: string, _freshlyRendered?: boolean) => project(prompt),
        );
      }
      let withdrawals = 0;
      f.input.prepared.promptToolPolicy.prepareForDispatch = (prepare) => {
        withdrawals++;
        return prepare();
      };
      const refresh = Object.assign(
        vi.fn((current: string) => current + " / permitted tools"),
        {
          freshlyRendered: true,
        },
      );
      const preparePrompt = vi.fn(async () => refresh);
      f.input.prepared.systemPrompt.prepareToolPrompt = preparePrompt;
      vi.mocked(ownedSession.setActiveSessionSystemPrompt).mockImplementation((prompt) => {
        session.agent.state.systemPrompt = prompt;
        return prompt;
      });
      const ordinaryAssembly = expectDefined(
        mocks.preparePromptAssembly.getMockImplementation(),
        "prompt assembly fixture implementation",
      );
      mocks.preparePromptAssembly.mockImplementation(async (input) => ({
        ...(await ordinaryAssembly(input)),
        decisionPrefilter: {
          shouldPruneTools: true,
          restrictionApplied: true,
          status: "proposed",
          reason: "conversational",
          isCurrent: () => false,
        },
      }));
      mocks.submitPrompt.mockImplementation(async (input: PromptSubmissionCall) => {
        const readContext = await expectDefined(
          input.preparePrimaryModelRequest?.(),
          "foreground restoration preparation",
        );
        const context = readContext();
        if (inHistorySystemUpdates) {
          expect(context).toMatchObject({
            tools: [],
            systemPrompt: "pruned prompt",
            promptUpdate: {
              update: {
                customType: "openclaw.system-update",
                content: expect.stringContaining("pruned prompt / permitted tools"),
              },
            },
          });
          context.promptUpdate?.commit();
          expect(session.agent.state.systemPrompt).toBe("pruned prompt");
        } else {
          expect(context).toEqual({ tools: [], systemPrompt: "pruned prompt / permitted tools" });
        }
      });
      await runEmbeddedAttemptPromptPhase(f.input, f.promptState);
      expect(f.readState().promptError).toBeNull();
      expect(withdrawals).toBe(1);
      expect(preparePrompt).toHaveBeenCalledWith(
        f.input.prepared.promptToolPolicy.current.effectiveTools,
      );
      expect(refresh).toHaveBeenCalledWith("pruned prompt");
      if (inHistorySystemUpdates) {
        expect(f.input.prepared.sessionRuntime.prepareSystemPromptUpdate).toHaveBeenCalledWith(
          "pruned prompt / permitted tools",
          true,
        );
      }
      const assembly = await mocks.preparePromptAssembly.mock.results[0]!.value;
      expect(assembly.decisionPrefilter).toMatchObject({
        restrictionApplied: false,
        status: "retained",
        reason: "selection-changed",
      });
    },
  );

  it("observes canonical request prefixes before managed cache consumption and skips compaction", async () => {
    const fixture = createFixture();
    const session = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
    const observations = vi.fn<(observation: PromptCacheRequestObservation) => void>();
    const observer = createPromptCacheRequestObserver(
      { sessionId: "prompt-phase-cache-observer", streamStrategy: "test" },
      observations,
    );
    fixture.input.preparedStreamRuntime.cache.onModelRequest = observer.onModelRequest;
    let compacting = false;
    Object.defineProperty(session, "isCompacting", { get: () => compacting });
    mocks.prepareGooglePromptCache.mockImplementation(
      async ({ streamFn }: { streamFn: StreamFn }): Promise<StreamFn> =>
        (model, context, options) =>
          streamFn(model, { ...context, systemPrompt: undefined, tools: undefined }, options),
    );
    mocks.submitPrompt.mockImplementation(async () => {
      const tool = { name: "read", description: "Read text", parameters: Type.Object({}) };
      for (const [index, cacheRead] of [10_000, 0, 10_000].entries()) {
        await session.agent.streamFn(testModel, {
          systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}stable suffix`,
          messages: [],
          tools: [{ ...tool, description: index === 2 ? "Read workspace text" : tool.description }],
        });
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
        if (index === 0) {
          compacting = true;
          await session.agent.streamFn(testModel, {
            systemPrompt: "Summarize",
            messages: [],
            tools: [],
          });
          compacting = false;
        }
      }
    });
    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
    expect(fixture.readState().promptError).toBeNull();
    expect(observations.mock.calls.map(([observation]) => observation)).toMatchObject([
      { requestIndex: 1, broke: false, cacheRead: 10_000, changes: null },
      { requestIndex: 2, broke: true, cacheRead: 0, changes: null },
      {
        requestIndex: 3,
        broke: false,
        cacheRead: 10_000,
        changes: [{ code: "tools", detail: '1 -> 1 tools; description: "read"' }],
      },
    ]);
  });

  it.each([
    {
      persisted: true,
      skip: false,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: "current:user",
    },
    {
      persisted: true,
      skip: true,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: undefined,
    },
    {
      persisted: false,
      skip: false,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: undefined,
    },
    {
      persisted: true,
      skip: false,
      pendingPrompt: "hello",
      pendingImageCount: 0,
      expectedKey: "current:user",
    },
  ])(
    "captures pending text/images and exact ingress identity (persisted=$persisted, skip=$skip, images=$pendingImageCount)",
    async ({ persisted, skip, pendingPrompt, pendingImageCount, expectedKey }) => {
      const fixture = createFixture({ pendingPrompt, pendingImageCount });
      const { activeSession } = fixture.input.prepared.sessionRuntime.agentSession;
      const currentUser = {
        role: "user" as const,
        content: pendingPrompt,
        timestamp: 1,
        idempotencyKey: "current:user",
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: { ...currentUser, idempotencyKey: "draft:user" },
        target: async () => undefined,
      });
      if (persisted) {
        recorder.markRuntimePersisted(currentUser);
      }
      fixture.input.attempt.userTurnTranscriptRecorder = recorder;
      fixture.input.attempt.skipPreparedUserTurnMessage = skip;
      const budgets: CompactionRequestBudget[] = [];
      fixture.input.attempt.onCompactionRequestBudget = (budget) => {
        if (budget) {
          budgets.push(budget);
        }
      };
      const tool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => ({ content: [], details: {} }),
      };
      activeSession.agent.state.tools = [tool];
      let compacting = false;
      Object.defineProperty(activeSession, "isCompacting", { get: () => compacting });
      mocks.preparePromptPreflight.mockImplementation(async (input: PromptPreflightCall) => {
        expect(budgets).toHaveLength(1);
        expect(budgets[0]).toMatchObject({ contextWindow: 32_000, reserveTokens: 77 });
        expect(budgets[0]?.pendingTokens).toBeGreaterThan(0);
        expect(budgets[0]?.pendingUserIdempotencyKey).toBe(expectedKey);
        return input.state;
      });
      mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
        expect(submission.compactionRequestBudget).toBe(budgets[0]);
        const model = fixture.input.attempt.model;
        const context = {
          systemPrompt: "Current foreground context. ".repeat(200),
          messages: [],
          tools: [{ ...tool, description: "Complete schema guidance. ".repeat(100) }],
        };
        await activeSession.agent.streamFn(model, context);
        expect(budgets).toHaveLength(2);
        expect(budgets[1]).toMatchObject({
          contextWindow: 32_000,
          reserveTokens: 77,
          pendingTokens: 0,
        });
        expect(budgets[1]?.fixedTokens).toBeGreaterThan(budgets[0]?.fixedTokens ?? 0);
        expect(budgets[1]?.pendingUserIdempotencyKey).toBeUndefined();
        compacting = true;
        await activeSession.agent.streamFn(
          { ...model, contextWindow: 200_000 },
          { systemPrompt: "Separate summarizer", messages: [], tools: [] },
        );
        expect(budgets).toHaveLength(2);
        compacting = false;
      });

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(fixture.readState().promptError).toBeNull();
    },
  );

  it("runs prompt work in phase order and publishes prompt outputs", async () => {
    const fixture = createFixture();

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: "leaf-1",
    });

    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "before-agent-run",
      "google-cache",
      "images",
      "observe",
      "preflight",
      "submit",
      "stop-steering",
    ]);
    expect(fixture.sessionRuntimeState.prePromptMessageCount).toBe(2);
    expect(fixture.promptState.finalPromptText).toBe("hello");
    expect(mocks.preparePromptContext).toHaveBeenCalledWith(
      expect.objectContaining({
        appendOnlyRuntimeContext: true,
        preparedUserTurnMessage: expect.objectContaining({
          content: "hello",
          timestamp: 100,
          __openclaw: { senderName: "Alice" },
        }),
      }),
    );
    expect(mocks.preparePromptPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ appendOnlyRuntimeContext: true }),
    );
    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        skipPromptSubmission: false,
      }),
    );
    expect(mocks.observePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCount: 1,
        reserveTokens: 77,
        transcriptLeafId: "leaf-1",
      }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ type: "image" })],
        appendOnlyRuntimeContext: true,
        leasedSteering: { leaseId: "lease-1", runIds: ["run-1"], isCurrent: expect.any(Function) },
        modelPrompt: "hello",
        runtimeContextMessage: expect.objectContaining({ content: "runtime" }),
        transcriptLeafId: "leaf-1",
        transcriptPrompt: "hello",
      }),
    );
    expect(mocks.releasePendingSteering).not.toHaveBeenCalled();
  });

  it("withholds prompt hooks and submission after its owner retires during context lookup", async () => {
    const fixture = createFixture();
    const admission = prepareSystemAgentRunAdmission({}, "prompt-owner", "main", "prompt-session");
    try {
      const admitted = await admission.admit("embedded");
      const prepareAssembly = expectDefined(
        mocks.preparePromptAssembly.getMockImplementation(),
        "prompt assembly fixture",
      );
      mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => ({
        ...(await prepareAssembly(...args)),
        assertHostActive: resolveAdmittedRunActiveAssertion(admitted),
      }));
      const prepareContext = expectDefined(
        mocks.preparePromptContext.getMockImplementation(),
        "prompt context fixture",
      );
      const context = prepareContext();
      const lookup = createDeferred<typeof context>();
      const entered = createDeferred();
      mocks.preparePromptContext.mockImplementationOnce(() => {
        entered.resolve();
        return lookup.promise;
      });
      const pending = runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
      await entered.promise;
      admission.close();
      lookup.resolve(context);
      await pending;
      expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
      expect(mocks.submitPrompt).not.toHaveBeenCalled();
      expect(mocks.handlePromptError).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "admitted run authority is no longer active" }),
        }),
      );
    } finally {
      admission.close();
    }
  });

  it("keeps ordinary prompt state and ambient hooks out of settled-turn finalization", async () => {
    const fixture = createFixture();
    fixture.input.attempt.operation = "settled-tool-finalization";
    const sessionManager = SessionManager.inMemory();
    const state = getEmbeddedSessionPromptState("phase-finalization");
    const project = (systemPrompt: string) =>
      prepareSessionSystemPrompt({
        state,
        routeKey: "anthropic/claude-opus-5/anthropic-messages",
        systemPrompt,
        entries: sessionManager.getBranch(),
      });
    project("## Tools\nread, write").commit();
    await persistSessionSystemPrompt(state, (customType, data) =>
      sessionManager.appendCustomEntryAsync(customType, data),
    );
    project("## Tools\nread").commit();
    const before = structuredClone({
      series: state.systemPrompt,
      pending: state.pendingSystemPrompt,
    });
    const runtime = fixture.input.prepared.sessionRuntime;
    runtime.sessionManager = sessionManager;
    runtime.sessionPromptState = state;
    runtime.toolResultPromptProjectionState = state.toolResults;
    runtime.transcriptPolicy.inHistorySystemUpdates = true;
    const submit = expectDefined(
      mocks.submitPrompt.getMockImplementation(),
      "prompt submission fixture",
    );
    mocks.submitPrompt.mockImplementation(async (input: PromptSubmissionCall) => {
      await input.persistToolResultProjections();
      return submit(input);
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBeNull();
    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect({ series: state.systemPrompt, pending: state.pendingSystemPrompt }).toEqual(before);
    expect(
      sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
        ),
    ).toHaveLength(1);
    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "google-cache",
      "images",
      "observe",
      "preflight",
      "submit",
      "stop-steering",
    ]);
  });

  it("honors a tool-policy failure published during prompt assembly", async () => {
    const fixture = createFixture();
    const failure = new Error("explicit tool allowlist is empty");
    mocks.applyPromptToolsAllow.mockImplementationOnce(() => {
      fixture.input.prepared.toolCatalog.emptyExplicitToolAllowlistError = failure;
      return fixture.input.prepared.promptToolPolicy.current;
    });
    mocks.observePrompt.mockImplementationOnce((input: { skipPromptSubmission: boolean }) => ({
      skipPromptSubmission: input.skipPromptSubmission,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(failure);
    expect(fixture.readState().promptErrorSource).toBe("precheck");
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure.message, leaseId: "lease-1" }),
    );
  });

  it("admits the provider prompt when aggregate projection pressure is only heuristic", async () => {
    const fixture = createFixture();
    const preparePromptContext = mocks.preparePromptContext.getMockImplementation();
    mocks.preparePromptContext.mockImplementation(() => ({
      ...(preparePromptContext?.() as Record<string, unknown>),
      aggregatePressureEngaged: true,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({ skipPromptSubmission: false }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("reads yield state after submission fails and publishes abort state before recovery", async () => {
    const fixture = createFixture();
    const submissionError = new Error("submission failed");
    const yieldAbortSettled = Promise.resolve();
    mocks.submitPrompt.mockImplementation(async () => {
      fixture.order.push("submit");
      fixture.yieldState.yieldDetected = true;
      fixture.yieldState.yieldAbortSettled = yieldAbortSettled;
      fixture.yieldState.yieldMessage = "yield context";
      throw submissionError;
    });
    mocks.handlePromptError.mockImplementation(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(input.yieldDetected).toBe(true);
      expect(input.yieldAbortSettled).toBe(yieldAbortSettled);
      expect(input.yieldMessage).toBe("yield context");
      input.releaseLeasedSteering(input.error);
      input.markYieldAborted();
      expect(fixture.readState()).toMatchObject({ aborted: false, cleanupYieldAborted: true });
      return {};
    });

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: "leaf-1",
    });

    expect(fixture.order.slice(-3)).toEqual(["submit", "prompt-error", "stop-steering"]);
    expect(fixture.promptState.yieldAborted).toBe(true);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", runIds: ["run-1"] }),
    );
  });

  it.each([
    { kind: "timeout", phase: "prompt", source: "external" },
    { kind: "aborted", source: "external" },
  ] satisfies AgentRunAttemptTerminal[])(
    "preserves an external $kind when yield cleanup observes the same unwind",
    async (terminal) => {
      const fixture = createFixture();
      fixture.input.state.terminal = terminal;
      mocks.submitPrompt.mockRejectedValueOnce(new Error("yield unwind"));
      mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
        input.markYieldAborted();
        expect(fixture.input.state.terminal).toEqual(terminal);
        return {};
      });

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(fixture.input.state.terminal).toEqual(terminal);
      expect(fixture.promptState.yieldAborted).toBe(true);
    },
  );

  it("keeps a run-budget timeout failure-free for partial-output salvage", async () => {
    const fixture = createFixture();
    fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
    fixture.input.runAbortController.abort(new Error("request timed out"));
    mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => ({
      promptFailure: { error: input.error, source: "prompt" },
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(fixture.readState().promptError).toBeNull();
    expect(fixture.readState().promptErrorSource).toBeNull();
  });

  it("records a provider failure that races a run-budget timeout", async () => {
    const fixture = createFixture();
    const providerError = new Error("provider failed");
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
      fixture.input.runAbortController.abort(new Error("request timed out"));
      throw providerError;
    });
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: providerError, source: "prompt" },
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(providerError);
    expect(fixture.readState().promptErrorSource).toBe("prompt");
  });

  it("releases transferred steering when prompt assembly rejects an invalidated result", async () => {
    const fixture = createFixture();
    const invalidationError = new Error("queued child result lost authority");
    const prepareAssembly = expectDefined(
      mocks.preparePromptAssembly.getMockImplementation(),
      "prompt assembly fixture",
    );
    mocks.preparePromptAssembly.mockImplementationOnce(async (...args) => {
      await prepareAssembly(...args);
      throw invalidationError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      input.releaseLeasedSteering(input.error);
      return { promptFailure: { error: input.error, source: "prompt" } };
    });

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: null,
    });

    expect(mocks.releasePendingSteering).toHaveBeenCalledExactlyOnceWith({
      error: invalidationError.message,
      leaseId: "lease-1",
      runIds: ["run-1"],
    });
    expect(fixture.readState().promptError).toBe(invalidationError);
    expect(mocks.preparePromptContext).not.toHaveBeenCalled();
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(fixture.order).toEqual(["assembly", "prompt-error", "stop-steering"]);
  });

  it("releases steering when preflight skips provider submission", async () => {
    const fixture = createFixture();
    const promptError = new Error("preflight rejected");
    mocks.preparePromptExecution.mockResolvedValueOnce({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 1,
      loadedCount: 0,
      skippedCount: 1,
    });
    mocks.observePrompt.mockImplementationOnce(() => {
      fixture.order.push("observe");
      return { skipPromptSubmission: true };
    });
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(promptError);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "preflight rejected",
        leaseId: "lease-1",
        runIds: ["run-1"],
      }),
    );
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
  });

  it("publishes preflight state before a submission failure", async () => {
    const fixture = createFixture();
    const promptError = new Error("admission warning");
    const submitError = new Error("provider failed");
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.order.push("submit");
      expect(fixture.readState().promptError).toBe(promptError);
      throw submitError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (errorInput: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(errorInput.error).toBe(submitError);
      return {};
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.order.slice(-4)).toEqual([
      "preflight",
      "submit",
      "prompt-error",
      "stop-steering",
    ]);
  });
});
