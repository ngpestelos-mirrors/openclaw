import { randomUUID } from "node:crypto";
import {
  bindOperatorModelExecution,
  prepareSystemAgentRunAdmission,
  type AdmittedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { buildBtwCliPrompt } from "../agents/btw-prompts.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import type { InternalSessionEffectsTarget } from "../agents/internal-session-effects.js";
import { withSessionManagerWrite } from "../agents/sessions/session-manager-write-admission.js";
import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageContent, Message } from "../llm/types.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import {
  assertSessionCompanionImageInput,
  resolveSessionCompanionCliRuntime,
  resolveSessionCompanionModel,
  SESSION_COMPANION_TOOLS,
} from "./session-companion-policy.js";

export const SESSION_COMPANION_ASK_TIMEOUT_MS = 60_000;

export type SessionCompanionPromptMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

export type SessionCompanionRunParams = {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  sessionKey: string;
  workspaceDir: string;
  systemPrompt: string;
  messages: SessionCompanionPromptMessage[];
  images?: ImageContent[];
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertSourceCurrent?: () => void;
  signal: AbortSignal;
};

const EMPTY_USAGE = makeZeroUsageSnapshot();

function toRunnerHistoryMessage(
  message: SessionCompanionPromptMessage,
  selection: { provider: string; modelId: string },
): Message {
  if (message.role === "user") {
    return { role: "user", content: message.content, timestamp: message.ts };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "openai-responses",
    provider: selection.provider,
    model: selection.modelId,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: message.ts,
  };
}

export async function runSessionCompanionAsk(params: SessionCompanionRunParams): Promise<string> {
  params.assertSourceCurrent?.();
  const selectedModel = resolveSessionCompanionModel({
    cfg: params.cfg,
    agentId: params.agentId,
    modelRef: params.modelRef,
    operatorAuthority: params.operatorAuthority,
  });
  const current = params.messages.at(-1);
  if (!current || current.role !== "user") {
    throw new Error("Session companion has no current question.");
  }
  const cliRuntime = await resolveSessionCompanionCliRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    selection: selectedModel,
  });
  if (cliRuntime && params.images?.length) {
    throw new SessionCompanionAskError(
      "image-input-unsupported",
      "Side chat on a CLI runtime cannot read images. Choose an image-capable utility model and retry.",
    );
  }
  const runId = `session-companion-${randomUUID()}`;
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const { prepareInternalSessionEffectsSession, removeInternalSessionEffectsSession } =
    await import("../agents/internal-session-effects.js");
  const target = await prepareInternalSessionEffectsSession({
    agentId: params.agentId,
    cwd: params.workspaceDir,
    runId,
    storePath,
  });
  const expectedSeedOwner = {
    lifecycleRevision: target.sessionEntry.lifecycleRevision,
    activeWriterRunId: target.sessionEntry.activeWriterRunId,
  };
  let executionStarted = false;
  let preparedRunAdmission: PreparedAgentRunAdmission | undefined;
  let modelExecution: ReturnType<typeof bindOperatorModelExecution>;
  try {
    modelExecution = bindOperatorModelExecution(params.operatorAuthority, {
      provider: selectedModel.provider,
      model: selectedModel.modelId,
    });
    const abortSignal = modelExecution
      ? AbortSignal.any([params.signal, modelExecution.signal])
      : params.signal;
    preparedRunAdmission = prepareSystemAgentRunAdmission(
      params.cfg,
      runId,
      params.agentId,
      "session-companion.ask",
      params.assertSourceCurrent,
      params.operatorAuthority,
    );
    if (cliRuntime) {
      executionStarted = true;
      const answer = await runSessionCompanionViaCliRuntime({
        ...params,
        cliRuntime,
        modelId: selectedModel.modelId,
        requesterModel: { provider: selectedModel.provider, model: selectedModel.modelId },
        authProfileId: selectedModel.profileId,
        target,
        preparedRunAdmission,
        runId,
        abortSignal,
      });
      modelExecution?.assertCurrent();
      return answer;
    }
    const [{ SessionManager }, { runEmbeddedAgent }] = await Promise.all([
      import("../agents/sessions/index.js"),
      import("../agents/embedded-agent.js"),
    ]);
    const sessionManager = await SessionManager.openAsync(
      target,
      undefined,
      undefined,
      params.signal,
    );
    params.signal.throwIfAborted();
    params.assertSourceCurrent?.();
    await withSessionManagerWrite(sessionManager, () => {
      abortSignal.throwIfAborted();
      params.assertSourceCurrent?.();
      const currentEntry = loadExactSessionEntry(target)?.entry;
      if (
        !currentEntry ||
        currentEntry.sessionId !== target.sessionId ||
        currentEntry.lifecycleRevision !== expectedSeedOwner.lifecycleRevision ||
        currentEntry.activeWriterRunId !== expectedSeedOwner.activeWriterRunId
      ) {
        throw new Error("Session companion identity changed before history persistence");
      }
      for (const message of params.messages.slice(0, -1)) {
        sessionManager.appendMessage(toRunnerHistoryMessage(message, selectedModel));
      }
    });
    abortSignal.throwIfAborted();
    executionStarted = true;
    const result = await runEmbeddedAgent({
      preparedRunAdmission,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sandboxSessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      cwd: params.workspaceDir,
      config: params.cfg,
      // Invocation restrictions survive configured-runtime admission and reload.
      // The internal execution session must not become the session-read target.
      disableToolSearch: true,
      requireWorkspaceOnly: true,
      sessionReadScopeKey: params.sessionKey,
      codeModeOverride: false,
      prompt: current.content,
      images: params.images,
      assertModelInput: params.images?.length ? assertSessionCompanionImageInput : undefined,
      provider: selectedModel.runtimeProvider ?? selectedModel.provider,
      model: selectedModel.modelId,
      modelFallbacksOverride: [],
      requestedRouteResolution: "resolved",
      agentHarnessRuntimeOverride: "openclaw",
      authProfileId: selectedModel.profileId,
      authProfileIdSource: selectedModel.profileId ? "user" : undefined,
      timeoutMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runTimeoutOverrideMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runId,
      abortSignal,
      extraSystemPrompt: params.systemPrompt,
      promptMode: "minimal",
      bootstrapContextMode: "lightweight",
      toolsAllow: [...SESSION_COMPANION_TOOLS],
      disableMessageTool: true,
      disableTrajectory: true,
      suppressLiveStreamOutput: true,
      cleanupBundleMcpOnRunEnd: true,
      oneShotCliRun: true,
      inputProvenance: { kind: "internal_system", sourceTool: "session-companion" },
    });
    modelExecution?.assertCurrent();
    return (
      result.meta.finalAssistantVisibleText ??
      result.payloads
        ?.filter((payload) => payload.isReasoning !== true && typeof payload.text === "string")
        .map((payload) => payload.text)
        .join("") ??
      ""
    );
  } finally {
    try {
      preparedRunAdmission?.close();
      await removeInternalSessionEffectsSession(
        target,
        executionStarted ? undefined : expectedSeedOwner,
      );
    } finally {
      modelExecution?.release();
    }
  }
}

/**
 * Subscription-backed CLI runtimes have no direct provider credential, so Side
 * chat runs as a tool-free, one-shot side question on the owning CLI backend.
 * The bounded reference context stands in for the read-only session tools,
 * which the CLI bridge cannot scope to the observed session.
 */
async function runSessionCompanionViaCliRuntime(
  params: SessionCompanionRunParams & {
    cliRuntime: string;
    modelId: string;
    requesterModel: { provider: string; model: string };
    authProfileId?: string;
    target: InternalSessionEffectsTarget;
    preparedRunAdmission: PreparedAgentRunAdmission;
    runId: string;
    abortSignal: AbortSignal;
  },
): Promise<string> {
  const [{ prepareCliRunContext }, { executePreparedCliRun }] = await Promise.all([
    import("../agents/cli-runner/prepare.runtime.js"),
    import("../agents/cli-runner/execute.runtime.js"),
  ]);
  const history = params.messages.slice(0, -1);
  const question = params.messages.at(-1)?.content ?? "";
  let prepared: PreparedCliRunContext | undefined;
  try {
    params.assertSourceCurrent?.();
    prepared = await prepareCliRunContext({
      preparedRunAdmission: params.preparedRunAdmission,
      sessionId: params.target.sessionId,
      sessionKey: params.target.sessionKey,
      sessionEntry: params.target.sessionEntry,
      sessionFile: params.target.sessionFile,
      agentId: params.agentId,
      trigger: "manual",
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      prompt: buildBtwCliPrompt({
        messages: history.map((message) =>
          toRunnerHistoryMessage(message, {
            provider: params.cliRuntime,
            modelId: params.modelId,
          }),
        ),
        question,
        imageCount: 0,
      }),
      extraSystemPrompt: params.systemPrompt,
      executionMode: "side-question",
      provider: params.cliRuntime,
      model: params.modelId,
      requesterModel: params.requesterModel,
      disableTools: true,
      timeoutMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runTimeoutOverrideMs: SESSION_COMPANION_ASK_TIMEOUT_MS,
      runId: params.runId,
      authProfileId: params.authProfileId,
      abortSignal: params.abortSignal,
    });
    params.abortSignal.throwIfAborted();
    params.assertSourceCurrent?.();
    return (await executePreparedCliRun(prepared)).text;
  } finally {
    await prepared?.preparedBackend.cleanup?.();
  }
}
