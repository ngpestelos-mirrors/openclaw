import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  finalizeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../../agents/subagents/requester-final-attachment.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";

type ConsultParams = Parameters<
  typeof import("../../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));

import { createTalkClientAgentConsultRunner } from "../talk/client-agent-consult.js";

const config = {} as OpenClawConfig;
const requester = {
  requesterAgentId: "researcher",
  requesterSessionKey: "agent:researcher:talk",
};
const batchRunIds = ["run-child"];
const coreParams = {
  config,
  prompt: "check",
  runId: "run-talk",
  sessionId: "session-talk",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-talk",
    sessionKey: "agent:researcher:talk",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

function createRunner(isRunCurrent: (runId: string) => boolean = () => true) {
  return createTalkClientAgentConsultRunner({
    config,
    context: { logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "main",
      canonicalKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
      assertCurrent: vi.fn(),
    },
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: vi.fn(async ({ runId }) => ({
      release: vi.fn(),
      isCurrent: () => isRunCurrent(runId),
    })),
  });
}

async function startPromotedFinal(
  core: Deferred<{ payloads: never[] }>,
  rearmGeneration: number,
  isRunCurrent?: (runId: string) => boolean,
) {
  const append = vi.fn(() => true);
  const runner = createRunner(isRunCurrent);
  runner.runPrompt.adoptCompletionClaims();
  const run = runner.runPrompt({ prompt: "investigate", requesterFinal: { append } });
  await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
  expect(
    promoteRequesterFinalAttachment({
      ...requester,
      requesterTurnRunId: "run-talk",
      batchRunIds,
      rearmGeneration,
    }),
  ).toBe(true);
  core.resolve({ payloads: [] });
  await expect(run).resolves.toEqual({ text: "done" });
  return { runner, append };
}

function finalize(rearmGeneration: number, finalAssistantVisibleText: string) {
  finalizeRequesterFinalAttachment({
    ...requester,
    requesterSessionId: "session-talk",
    batchRunIds,
    rearmGeneration,
    requesterYieldBatch: true,
    pause: false,
    delivered: true,
    finalAssistantVisibleText,
  });
}

describe("Talk requester-final consult ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    mocks.createOperationalRunInstanceRef.mockImplementation((runId: string) => ({
      instanceId: `instance:${runId}`,
      runId,
    }));
    mocks.prepareAgentRunAdmission.mockImplementation(
      (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
        operationalRunInstance: params.operationalRunInstance,
        admit: vi.fn(),
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      await params.onRunStarted?.({
        runId: "run-talk",
        sessionId: "session-talk",
        timeoutMs: 60_000,
      });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
  });

  afterEach(embeddedRunsTesting.resetActiveEmbeddedRuns);

  it("promotes and consumes a yielded final exactly once", async () => {
    const core = createDeferredCore<{ payloads: never[] }>();
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:yielded-final",
      runId: "run-talk",
    };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      const project = (_overlay: ReplyToolAuthorityOverlay) => "authority";
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            acceptsRequesterOrigin: () => false,
            source: "attempt",
            project,
            projectAsync: async (overlay) => project(overlay),
            assertRegistrationActive: () => {},
            assertActive: () => {},
          }),
        },
        () => {
          const operation = getCurrentSessionControllerOwner();
          if (!operation) {
            throw new Error("Talk consult has no controller-owned turn");
          }
          setActiveEmbeddedRun(
            "session-talk",
            handle,
            "agent:researcher:talk",
            undefined,
            "researcher",
            operation,
          );
        },
      );
      try {
        return await core.promise;
      } finally {
        clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      }
    });
    const { runner, append } = await startPromotedFinal(core, 1);
    expect(runner.runPrompt.claimAppend()).toBe(true);
    finalize(1, "late final");
    expect(append).toHaveBeenCalledExactlyOnceWith("late final");
  });

  it("revokes a promoted final when its run owner is stale", async () => {
    const core = createDeferredCore<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    let runCurrent = true;
    const { runner, append } = await startPromotedFinal(core, 2, () => runCurrent);
    runCurrent = false;
    expect(runner.runPrompt.claimAppend()).toBe(false);
    finalize(2, "stale final");
    expect(append).not.toHaveBeenCalled();
  });
});
