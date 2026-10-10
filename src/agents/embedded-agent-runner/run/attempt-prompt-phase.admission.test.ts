import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultSessionStorePath } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { Context, Model, SimpleStreamOptions } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  estimateCompactionHistoryTokens,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import {
  getEmbeddedSessionPromptState,
  createToolResultPromptProjectionState,
  clearEmbeddedSessionPromptStates,
} from "../session-prompt-state.js";
import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type { PromptSubmissionCall } from "./attempt-prompt-phase.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

// Register the shared module mocks before importing any runtime dependency.
const { createFixture, mocks } = await vi.hoisted(
  async () => await import("./attempt-prompt-phase.test-support.js"),
);
const tempStateDirs = useSessionStoreTempDirs(afterAll, "openclaw-prompt-projection-admission-");

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

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  clearEmbeddedSessionPromptStates(["phase-context-replay"]);
  vi.unstubAllEnvs();
});

describe("prompt projection write admission", () => {
  it.each([false, true])(
    "admits projection persistence before provider dispatch and rechecks cancellation (abort: %s)",
    async (abort) => {
      const stateDir = tempStateDirs.make();
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:projection-admission",
        sessionId: "projection-admission",
        storePath: resolveDefaultSessionStorePath("main"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope);
      const fixture = createFixture();
      fixture.input.prepared.sessionRuntime.sessionManager = manager;
      const projection = createToolResultPromptProjectionState();
      projection.frozen.add("tool-result");
      projection.sourceHashByKey.set("tool-result", "source");
      projection.replacements.set("tool-result", {
        content: [{ type: "text", text: "bounded result" }],
      });
      fixture.input.prepared.sessionRuntime.toolResultPromptProjectionState = projection;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const requested = createDeferredCore();
      const worker = runOpenClawAgentWorkerWrite({ agentId: scope.agentId }, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let dispatched = false;
      mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
        requested.resolve();
        await submission.persistToolResultProjections();
        dispatched = true;
      });
      const markers = () => manager.getEntries().filter((entry) => entry.type === "custom");
      const phase = runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);
      try {
        await requested.promise;
        await yieldToEventLoop();
        expect(markers()).toEqual([]);
        expect(dispatched).toBe(false);
        const reason = new Error("attempt cancelled while waiting for database");
        if (abort) {
          fixture.input.runAbortController.abort(reason);
        }
        release.resolve();
        await Promise.all([worker, phase]);
        if (abort) {
          expect(markers()).toEqual([]);
          expect(dispatched).toBe(false);
          expect(mocks.handlePromptError).toHaveBeenCalledWith(
            expect.objectContaining({ error: reason }),
          );
        } else {
          expect(mocks.handlePromptError).not.toHaveBeenCalled();
          expect(markers()).toMatchObject([{ customType: "openclaw.cache-ttl" }]);
          expect(dispatched).toBe(true);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([worker, phase]);
      }
    },
  );
});

describe("recorded prompt context budgets", () => {
  it.each([
    { appendOnlyRuntimeContext: true, queued: false, debugEnabled: true },
    { appendOnlyRuntimeContext: false, queued: false, debugEnabled: false },
    { appendOnlyRuntimeContext: true, queued: true, debugEnabled: false },
    { appendOnlyRuntimeContext: false, queued: true, debugEnabled: true },
  ])(
    "budgets submitted context with a recorded carrier (appendOnly=$appendOnlyRuntimeContext, queued=$queued)",
    async ({ appendOnlyRuntimeContext, queued, debugEnabled }) => {
      await withOpenClawTestState({ label: "recorded-carrier-budget" }, async (state) => {
        const fixture = createFixture({ pendingPrompt: "hello", pendingImageCount: 0 });
        // Cover both diagnostics modes without multiplying the four replay/compaction cases.
        mocks.isEnabled.mockReturnValue(debugEnabled);
        const currentUser = {
          role: "user" as const,
          content: "hello",
          timestamp: 1,
          idempotencyKey: "current:user",
        };
        const oldCarrier = buildRuntimeContextCustomMessage("Previously recorded context");
        const nextCarrier = buildRuntimeContextCustomMessage(
          "New transient context. ".repeat(queued ? 1 : 200),
        );
        if (!oldCarrier || !nextCarrier) {
          throw new Error("Expected both runtime carriers");
        }
        const target = {
          agentId: "main",
          sessionEntry: undefined,
          sessionId: "phase-context-replay",
          sessionKey: "agent:main:phase-context-replay",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        if (queued) {
          await manager.appendMessageAsync({
            role: "user",
            content: "Earlier project archive. ".repeat(1_500),
            timestamp: 1,
          });
          await manager.appendMessageAsync(
            createAssistant(testModel, [
              { type: "text", text: "Recorded project facts. ".repeat(900) },
            ]),
          );
          await manager.appendMessageAsync({
            role: "user",
            content: "Current project archive. ".repeat(1_500),
            timestamp: 3,
          });
          const priorInput = Math.ceil(
            JSON.stringify(
              manager.buildSessionContext().messages.map((message) => {
                if (message.role !== "user" && message.role !== "assistant") {
                  throw new Error("Expected seeded user/assistant history");
                }
                return { role: message.role, content: message.content };
              }),
            ).length / 4,
          );
          const priorText = "Recorded current facts. ".repeat(800);
          const prior = createAssistant(
            testModel,
            [{ type: "text", text: priorText }],
            "stop",
            priorInput,
          );
          prior.usage.output = Math.ceil(priorText.length / 4);
          prior.usage.totalTokens = priorInput + prior.usage.output;
          prior.usage.contextUsage = {
            state: "available",
            promptTokens: priorInput,
            totalTokens: prior.usage.totalTokens,
          };
          expect(prior.usage.totalTokens).toBeGreaterThan(24_576);
          expect(prior.usage.totalTokens).toBeLessThan(testModel.contextWindow!);
          await manager.appendMessageAsync(prior);
        }
        const recorder = createUserTurnTranscriptRecorder({ message: currentUser, target });
        await recorder.persistApproved();
        await manager.reloadPersistedTranscriptAsync();
        await manager.appendCustomMessageEntryAsync(
          oldCarrier.customType,
          oldCarrier.content,
          oldCarrier.display,
          oldCarrier.details,
        );
        const { session, settingsManager } = await createTestSession({
          sessionManager: manager,
          ...(queued
            ? {
                settingsManager: SettingsManager.inMemory({
                  compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
                  retry: { enabled: false },
                }),
              }
            : {}),
        });
        const queuedContext = "Queued project material. ".repeat(1_120).trim();
        const queuedMessage = {
          role: "custom" as const,
          customType: "test.ordinary-queued-context",
          content: queuedContext,
          display: false,
          timestamp: 1,
        };
        if (queued) {
          await session.sendCustomMessage(queuedMessage, { deliverAs: "nextTurn" });
        }
        const { sessionRuntime } = fixture.input.prepared;
        sessionRuntime.agentSession.activeSession = session;
        sessionRuntime.agentSession.settingsManager = settingsManager;
        sessionRuntime.sessionManager = manager;
        sessionRuntime.preparedUserTurnMessage = currentUser;
        sessionRuntime.state.systemPromptText = session.systemPrompt;
        fixture.input.attempt = {
          ...fixture.input.attempt,
          model: testModel,
          provider: testModel.provider,
          modelId: testModel.id,
          config: {},
          userTurnTranscriptRecorder: recorder,
        };
        fixture.input.attempt.sessionId = "phase-context-replay";
        const sessionPromptState = getEmbeddedSessionPromptState(fixture.input.attempt.sessionId);
        sessionRuntime.sessionPromptState = sessionPromptState;
        sessionRuntime.toolResultPromptProjectionState = sessionPromptState.toolResults;
        sessionRuntime.transcriptPolicy.appendOnlyRuntimeContext = appendOnlyRuntimeContext;
        fixture.input.preparedStreamRuntime.promptActiveSession = (prompt, options) =>
          session.prompt(prompt, options);
        await prepareEmbeddedAttemptSessionBoundary({
          activeSession: session,
          appendOnlyRuntimeContext,
          attempt: fixture.input.attempt,
          getUserTranscriptContexts: () => undefined,
          isRawModelRun: false,
          preparedUserTurnMessage: currentUser,
          sessionManager: manager,
          setActiveSessionSystemPrompt: (prompt) => {
            session.agent.state.systemPrompt = prompt;
          },
        });
        const context = mocks.preparePromptContext.getMockImplementation()!;
        mocks.preparePromptContext.mockImplementation((...args) => ({
          ...context(...args),
          contextTokenBudget: testModel.contextWindow,
          runtimeContextMessageForCurrentTurn: nextCarrier,
          systemPromptForHook: session.systemPrompt,
        }));
        const budgets: CompactionRequestBudget[] = [];
        fixture.input.attempt.onCompactionRequestBudget = (budget) => {
          if (budget) {
            budgets.push(budget);
          }
        };
        const { submitEmbeddedAttemptPrompt } = await vi.importActual<
          typeof import("./attempt-prompt-submit.js")
        >("./attempt-prompt-submit.js");
        mocks.submitPrompt.mockImplementation(submitEmbeddedAttemptPrompt);
        const requests: string[] = [];
        const requestToolCounts: number[] = [];
        const requestTokens: number[] = [];
        streamMocks.streamSimple.mockImplementation(
          (model: Model, providerContext: Context, options?: SimpleStreamOptions) => {
            const wire = JSON.stringify({
              system: providerContext.systemPrompt,
              tools: providerContext.tools,
              messages: providerContext.messages.map(({ role, content }) => ({ role, content })),
            });
            const tokens = Math.ceil(wire.length / 4);
            const foreground = !session.isCompacting;
            if (foreground) {
              requests.push(JSON.stringify(providerContext.messages));
              requestToolCounts.push(providerContext.tools?.length ?? 0);
              requestTokens.push(tokens);
            }
            const text = foreground
              ? "done"
              : "Project archive summary. "
                  .repeat(700)
                  .slice(0, (options?.maxTokens ?? model.maxTokens) * 4);
            const response = createAssistant(model, [{ type: "text", text }], "stop", tokens);
            response.usage.output = Math.ceil(text.length / 4);
            response.usage.totalTokens = tokens + response.usage.output;
            response.usage.contextUsage = {
              state: "available",
              promptTokens: tokens,
              totalTokens: response.usage.totalTokens,
            };
            expect(response.usage.totalTokens).toBeLessThanOrEqual(model.contextWindow!);
            return createAssistantResultStream(response);
          },
        );

        await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

        expect(mocks.handlePromptError.mock.calls.map(([input]) => input.error)).toEqual([]);
        expect(fixture.readState().promptError).toBeNull();
        expect(requests).toHaveLength(1);
        const diagnostics = mocks.debug.mock.calls.filter(
          ([message]) => message === "Decision tool surface at primary dispatch",
        );
        expect(diagnostics).toHaveLength(debugEnabled ? 1 : 0);
        if (debugEnabled) {
          expect(diagnostics[0]?.[1]).toMatchObject({
            decisionStatus: "skipped",
            reason: "fixture-baseline",
            restrictionApplied: false,
            baselineVisibleTools: null,
            finalVisibleTools: requestToolCounts[0],
            definitionCharsSaved: null,
          });
        }
        if (queued) {
          const captured = budgets[0]!;
          const completePendingTokens =
            captured.pendingTokens + estimateCompactionHistoryTokens([queuedMessage]);
          expect(
            captured.contextWindow -
              captured.reserveTokens -
              captured.fixedTokens -
              completePendingTokens,
          ).toBeGreaterThan(0);
          expect(requests[0]).toContain(queuedContext);
          expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
          expect(requestTokens[0], JSON.stringify({ requestTokens, budgets })).toBeLessThanOrEqual(
            testModel.contextWindow! - settingsManager.getCompactionReserveTokens(),
          );
        }
        expect(requests[0]).toContain(
          appendOnlyRuntimeContext ? "Previously recorded context" : "New transient context.",
        );
        expect(requests[0]).not.toContain(
          appendOnlyRuntimeContext ? "New transient context." : "Previously recorded context",
        );
        if (appendOnlyRuntimeContext) {
          expect(budgets[0]?.pendingTokens).toBeLessThan(nextCarrier.content.length / 4);
        } else {
          expect(budgets[0]?.pendingTokens).toBeGreaterThan(nextCarrier.content.length / 4);
        }
        expect(budgets.at(-1)).toMatchObject({ pendingTokens: 0, pendingQueuedContextTokens: 0 });
      });
    },
  );
});
