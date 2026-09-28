import { createAssistantOutput } from "../transports/assistant-output.js";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  StreamFunction,
  StreamOptions,
} from "../types.js";
import { AssistantMessageEventStream } from "./event-stream.js";
import { projectProviderError } from "./provider-error.js";

// Keep stream construction synchronous while provider code loads on first request.
export function createLazyStream<TApi extends Api, TOptions extends StreamOptions, TStreams>(
  load: () => Promise<TStreams>,
  select: (
    streams: TStreams,
  ) => (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
  ) => AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>,
): StreamFunction<TApi, TOptions> {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();
    load()
      .then(async (streams) => {
        for await (const event of await select(streams)(model, context, options)) {
          outer.push(event);
        }
        outer.end();
      })
      .catch((error: unknown) => {
        const message = {
          ...createAssistantOutput(model),
          ...projectProviderError(error, options?.signal),
        };
        outer.push({ type: "error", reason: message.stopReason, error: message });
        outer.end(message);
      });
    return outer;
  };
}
