import {
  escapeRuntimeContextFooter,
  isRuntimeContextMessage,
  labelRuntimeContextText,
  RUNTIME_CONTEXT_HEADER,
  type Context,
  type RuntimeContextMessage,
} from "../../../llm/types.js";
import {
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  RUNTIME_EVENT_USER_PROMPT,
  projectRuntimeContextFragments,
  type CurrentInboundPromptContext,
  type RuntimeContextFragment,
} from "../../internal-runtime-context.js";

/** Hidden custom transcript message that carries runtime context into model conversion. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details: {
    source: "openclaw-runtime-context";
    runtimeContextCarrier: true;
    fragments?: RuntimeContextFragment[];
  };
  timestamp: number;
};

/** Appends turn additions to both full and resumed projections without changing their provenance. */
export function appendCurrentInboundContext(
  context: CurrentInboundPromptContext | undefined,
  fragments: RuntimeContextFragment[],
  legacyText = fragments.map((fragment) => fragment.text).join("\n\n"),
): CurrentInboundPromptContext {
  const append = (text?: string) => [text, legacyText].filter(Boolean).join("\n\n");
  return {
    ...context,
    text: append(context?.text),
    ...(context?.resumableText !== undefined
      ? { resumableText: append(context.resumableText) }
      : {}),
    fragments: [
      ...(context?.fragments ??
        (context?.text ? [{ kind: "conversation-data" as const, text: context.text }] : [])),
      ...fragments,
    ],
  };
}

export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const contextText =
    params.preferResumableText === true
      ? (params.context?.resumableText ?? params.context?.text)
      : params.context?.text;
  const prefix = contextText?.trim() ?? "";
  return [prefix, params.prompt].filter(Boolean).join(params.context?.promptJoiner ?? "\n\n");
}

/** Attach context to this queued turn, not the active run's original prompt owner. */
export function buildCurrentInboundSteeringPrompt(
  prompt: string,
  context: CurrentInboundPromptContext | undefined,
): string {
  if (!context) {
    return prompt;
  }
  const fragments = (
    context.fragments ?? [{ kind: "conversation-data" as const, text: context.text }]
  ).filter((fragment) => fragment.text.trim());
  return buildCurrentInboundPrompt({
    prompt,
    context: { ...context, text: projectRuntimeContextFragments(fragments) },
  });
}

/** Selects explicit producer context without interpreting any prompt text as provenance. */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  fragments?: RuntimeContextFragment[];
  allowRuntimeOnly?: boolean;
}) {
  const fragments = params.fragments?.filter((fragment) => fragment.text.trim());
  const runtimeContext = fragments?.map((fragment) => fragment.text).join("\n\n") ?? "";
  const transcriptPrompt = params.transcriptPrompt ?? params.effectivePrompt;
  const runtimeOnly =
    !transcriptPrompt.trim() && Boolean(runtimeContext) && params.allowRuntimeOnly !== false;
  const prompt = runtimeOnly
    ? RUNTIME_EVENT_USER_PROMPT
    : transcriptPrompt || params.effectivePrompt;
  return {
    prompt,
    modelPrompt:
      params.effectivePrompt && params.effectivePrompt !== prompt
        ? params.effectivePrompt
        : undefined,
    runtimeContext: runtimeContext || undefined,
    ...(runtimeOnly ? { runtimeOnly: true } : {}),
  };
}

export function buildRuntimeContextCustomMessage(
  runtimeContext: string | undefined,
  fragments?: RuntimeContextFragment[],
): RuntimeContextCustomMessage | undefined {
  const trimmedRuntimeContext = runtimeContext?.trim();
  if (!trimmedRuntimeContext) {
    return undefined;
  }
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content: trimmedRuntimeContext,
    display: false,
    details: {
      source: "openclaw-runtime-context",
      runtimeContextCarrier: true,
      ...(fragments?.length ? { fragments } : {}),
    },
    timestamp: Date.now(),
  };
}

/** Project per-request instructions into the transient carrier without changing history. */
export function prependRuntimeContextForModel(
  messages: Context["messages"],
  runtimeContext: string,
): Context["messages"] {
  if (!runtimeContext.trim()) {
    return messages;
  }
  const carrierIndex = messages.findIndex(isRuntimeContextMessage);
  const carrier = messages[carrierIndex];
  const prepend = (text: string) =>
    text.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`)
      ? `${RUNTIME_CONTEXT_HEADER}\n${escapeRuntimeContextFooter(runtimeContext)}\n\n${text.slice(RUNTIME_CONTEXT_HEADER.length + 1)}`
      : labelRuntimeContextText([runtimeContext, text].filter(Boolean).join("\n\n"));
  if (!carrier || !isRuntimeContextMessage(carrier)) {
    return [
      ...messages,
      {
        role: "user",
        content: prepend(""),
        timestamp: messages.at(-1)?.timestamp ?? 0,
        runtimeContext: {},
      },
    ];
  }
  const content = carrier.content;
  const firstTextIndex =
    typeof content === "string" ? -1 : content.findIndex((part) => part.type === "text");
  const updated: RuntimeContextMessage = {
    ...carrier,
    content:
      typeof content === "string"
        ? prepend(content)
        : firstTextIndex < 0
          ? [{ type: "text", text: prepend("") }, ...content]
          : content.map((part, index) =>
              index === firstTextIndex && part.type === "text"
                ? Object.assign({}, part, { text: prepend(part.text) })
                : part,
            ),
  };
  return messages.map((message, index) => (index === carrierIndex ? updated : message));
}
