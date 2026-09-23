import { resolveToolResultFailureKind } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function readQaDeferredToolResult(requestedId: unknown, envelope: unknown) {
  if (
    !isRecord(envelope) ||
    !isRecord(envelope.tool) ||
    !isRecord(envelope.result) ||
    !Array.isArray(envelope.result.content) ||
    typeof requestedId !== "string" ||
    (requestedId !== envelope.tool.id && requestedId !== envelope.tool.name)
  ) {
    return undefined;
  }
  const name = readNonEmptyString(envelope.tool.name);
  return name
    ? {
        name,
        result: envelope.result,
        failed:
          envelope.result.isError === true ||
          Boolean(resolveToolResultFailureKind(envelope.result)),
      }
    : undefined;
}

export function readAssistantToolCalls(message: Record<string, unknown>): Array<{
  arguments?: unknown;
  id?: string;
  name: string;
}> {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => {
    if (!isRecord(block)) {
      return [];
    }
    const type = readNonEmptyString(block.type);
    if (type !== "toolCall" && type !== "toolUse" && type !== "tool_use") {
      return [];
    }
    const name = readNonEmptyString(block.name);
    return name
      ? [
          {
            arguments: block.arguments ?? block.input,
            id: readNonEmptyString(block.id),
            name,
          },
        ]
      : [];
  });
}

export function readWaitingCodeModeRunId(message: Record<string, unknown>) {
  const details = isRecord(message.details) ? message.details : undefined;
  return details?.status === "waiting" ? readNonEmptyString(details.runId) : undefined;
}
