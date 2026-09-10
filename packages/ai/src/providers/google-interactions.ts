// Google Interactions provider adapts Gemini Interactions API streams and tools to the agent runtime.
import { getEnvApiKey } from "../env-api-keys.js";
import type { Context, Model, SimpleStreamOptions, StreamFunction } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { runGoogleInteractionsLifecycle } from "./google-interactions-shared.js";
import { createGoogleAssistantOutput, type GoogleProviderOptions } from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export type GoogleInteractionsOptions = GoogleProviderOptions;

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleInteractions: StreamFunction<
  "google-interactions",
  GoogleInteractionsOptions
> = (
  model: Model<"google-interactions">,
  context: Context,
  options?: GoogleInteractionsOptions,
) => {
  const stream = new AssistantMessageEventStream();
  const output = createGoogleAssistantOutput(model as any, "google-generative-ai");

  void runGoogleInteractionsLifecycle({
    stream,
    model: model as any,
    output,
    options,
    context,
    nextToolCallId: (name) => `${name}_${Date.now()}_${++toolCallCounter}`,
  });

  return stream;
};

export const streamSimpleGoogleInteractions: StreamFunction<
  "google-interactions",
  SimpleStreamOptions
> = (model: Model<"google-interactions">, context: Context, options?: SimpleStreamOptions) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }

  const base = buildBaseOptions(model, options, apiKey);
  return streamGoogleInteractions(model, context, {
    ...base,
  } satisfies GoogleInteractionsOptions);
};
