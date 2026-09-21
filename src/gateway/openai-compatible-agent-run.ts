import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentStreamParams, ClientToolDefinition } from "../agents/command/shared-types.js";
import type { ImageContent } from "../agents/command/types.js";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { readAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { defaultRuntime } from "../runtime.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import type { GatewayContextResolver } from "./server-methods/types.js";

export type OpenAiCompatibleHttpOptions<TConfig> = GatewayHttpRequestAuthOptions & {
  config?: TConfig;
  maxBodyBytes?: number;
  resolveGatewayContext?: GatewayContextResolver;
};

export type OpenAiCompatiblePendingToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export function readOpenAiHttpRunTerminal(result: unknown): {
  runFailed: boolean;
  stopReason: string | undefined;
  pendingToolCalls: OpenAiCompatiblePendingToolCall[] | undefined;
} {
  const meta = isRecord(result) ? result.meta : undefined;
  if (!isRecord(meta)) {
    return {
      runFailed: readAgentRunTerminalOutcome(result) === "failed",
      stopReason: undefined,
      pendingToolCalls: undefined,
    };
  }
  const stopReasonRaw = meta.stopReason;
  const stopReason = typeof stopReasonRaw === "string" ? stopReasonRaw : undefined;
  const pendingRaw = meta.pendingToolCalls;
  if (!Array.isArray(pendingRaw)) {
    return {
      runFailed: readAgentRunTerminalOutcome(result) === "failed",
      stopReason,
      pendingToolCalls: undefined,
    };
  }
  const pendingToolCalls: OpenAiCompatiblePendingToolCall[] = [];
  for (const call of pendingRaw) {
    const record = isRecord(call) ? call : undefined;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    const argsValue = record?.arguments;
    const argumentsValue =
      typeof argsValue === "string"
        ? argsValue
        : argsValue == null
          ? ""
          : JSON.stringify(argsValue);
    if (id && name) {
      pendingToolCalls.push({ id, name, arguments: argumentsValue });
    }
  }
  return {
    runFailed: readAgentRunTerminalOutcome(result) === "failed",
    stopReason,
    pendingToolCalls,
  };
}

export async function runOpenAiCompatibleAgentCommand(params: {
  message: string;
  images?: ImageContent[];
  clientTools?: ClientToolDefinition[];
  extraSystemPrompt?: string;
  modelOverride?: string;
  streamParams?: AgentStreamParams;
  sessionKey: string;
  runId: string;
  messageChannel: string;
  senderIsOwner: boolean;
  abortSignal?: AbortSignal;
  hasCurrentClientAuthority?: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  let admitted = false;
  const assertSourceCurrent = () => {
    if (!admitted && params.hasCurrentClientAuthority?.() === false) {
      throw new ToolAuthorizationError("Gateway requester authority changed");
    }
  };
  assertSourceCurrent();
  return agentCommandFromGatewayIngress(
    {
      message: params.message,
      images: params.images?.length ? params.images : undefined,
      clientTools: params.clientTools?.length ? params.clientTools : undefined,
      extraSystemPrompt: params.extraSystemPrompt || undefined,
      model: params.modelOverride,
      streamParams: params.streamParams,
      sessionKey: params.sessionKey,
      runId: params.runId,
      deliver: false,
      messageChannel: params.messageChannel,
      senderIsOwner: params.senderIsOwner,
      bestEffortDeliver: false,
      allowModelOverride: params.modelOverride !== undefined,
      abortSignal: params.abortSignal,
      assertSourceCurrent,
      onAdmittedRunContext: (context) => {
        assertSourceCurrent();
        bindGatewayContextResolver(context, params.resolveGatewayContext);
        // Canonical admission takes custody; later ingress changes cannot revoke accepted input.
        admitted = true;
      },
    },
    defaultRuntime,
    createDefaultDeps(),
    {},
  );
}
