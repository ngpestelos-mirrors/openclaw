import {
  isAssistantRunEvent,
  isTerminalRunEvent,
  normalizeChatProjectionEvent,
  readChatProjection,
  readChatProjectionText,
} from "./chat-projection.js";
import type { EventHub } from "./event-hub.js";
import type { OpenClawEvent } from "./types.js";

type RunTerminalSource = { kind: "canonical" } | { kind: "chat"; eventType: OpenClawEvent["type"] };

export async function* iterateSdkRunEvents(
  runId: string,
  replayEvents: OpenClawEvent[],
  events: EventHub<OpenClawEvent>,
  filter?: (event: OpenClawEvent) => boolean,
): AsyncIterable<OpenClawEvent> {
  let hasCanonicalAssistantRunEvent = replayEvents.some(isAssistantRunEvent);
  let terminalSource: RunTerminalSource | undefined = replayEvents.some(isTerminalRunEvent)
    ? { kind: "canonical" }
    : undefined;
  let previousChatProjectionText: string | undefined;
  const toRunStreamEvent = (event: OpenClawEvent): OpenClawEvent | undefined => {
    const chatProjection = readChatProjection(event);
    if (chatProjection?.state === "delta") {
      if (hasCanonicalAssistantRunEvent) {
        return undefined;
      }
      const runEvent = normalizeChatProjectionEvent(
        event,
        chatProjection,
        previousChatProjectionText,
      );
      const text = readChatProjectionText(chatProjection.payload);
      if (text !== undefined) {
        previousChatProjectionText = text;
      }
      return runEvent;
    }
    if (chatProjection) {
      if (terminalSource) {
        return undefined;
      }
      const runEvent = normalizeChatProjectionEvent(
        event,
        chatProjection,
        previousChatProjectionText,
      );
      terminalSource = { kind: "chat", eventType: runEvent.type };
      return runEvent;
    }
    if (isAssistantRunEvent(event)) {
      hasCanonicalAssistantRunEvent = true;
    }
    if (isTerminalRunEvent(event)) {
      // Abort broadcasts can arrive chat-first. Collapse matching carriers,
      // while preserving a later authoritative outcome that differs.
      const duplicate = terminalSource?.kind === "chat" && terminalSource.eventType === event.type;
      terminalSource = { kind: "canonical" };
      if (duplicate) {
        return undefined;
      }
    }
    return event;
  };
  const matches = (event: OpenClawEvent) => event.runId === runId;
  const liveSource = events.stream(matches);
  // Iterator creation subscribes before replay yields, so live events queue behind the snapshot.
  const live = liveSource[Symbol.asyncIterator]();
  try {
    for (const event of replayEvents) {
      const runEvent = toRunStreamEvent(event);
      if (!runEvent || (filter && !filter(runEvent))) {
        continue;
      }
      yield runEvent;
    }
    while (true) {
      const next = await live.next();
      if (next.done) {
        break;
      }
      const runEvent = toRunStreamEvent(next.value);
      if (!runEvent || (filter && !filter(runEvent))) {
        continue;
      }
      yield runEvent;
    }
  } finally {
    await live.return?.();
  }
}
