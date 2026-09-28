import type { Api, AssistantMessage, Model, Usage } from "@openclaw/llm-core";

export function createAssistantOutput(
  model: Pick<Model, "api" | "provider" | "id">,
  api: Api = model.api,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyTransportUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function createEmptyTransportUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
