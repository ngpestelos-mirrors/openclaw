import { afterEach, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  bindAgentAssistantSource,
  readAgentAssistantSource,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

afterEach(() => {
  resetAgentEventsForTest();
  vi.useRealTimers();
});

it("hands paced native reasoning to its exact durable occurrence before identical later thinking", async () => {
  vi.useFakeTimers();
  const runId = "native-reasoning";
  const clientRunId = "client-reasoning";
  const sessionKey = "agent:main:reasoning";
  const sessionId = "reasoning-session";
  registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
  const gateway = createAgentEventTestHarness();
  gateway.register(runId, sessionKey, clientRunId);
  const unlisten = subscribeAgentEvents(gateway.handler);
  const { emit, subscription } = createSubscribedSessionHarness({ runId, sessionKey });
  const thoughts = () =>
    gateway
      .agent()
      .map(([, event]) => event)
      .filter((event) => event.stream === "thinking");
  const update = (text: string, delta: string, start = false) => {
    const message = makeAgentAssistantMessage({ content: [{ type: "thinking", thinking: text }] });
    if (start) {
      emit({ type: "message_start", message });
    }
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
    });
    return message;
  };
  try {
    update("Checking", "Checking", true);
    const first = update("Checking facts", " facts");
    await unlisten.drain();
    expect(thoughts()).toHaveLength(1);
    const source = readAgentAssistantSource(first);
    expect(source?.itemId).toEqual(expect.any(String));
    if (!source) {
      throw new Error("Native thinking must retain its assistant occurrence");
    }
    first.content.push({ type: "text", text: "The first answer is ready." });
    emit({ type: "message_end", message: first });
    await subscription.waitForPendingEvents();
    const committed = { ...first, __openclaw: { runId } };
    source.committedMessageSeq = 2;
    bindAgentAssistantSource(committed, source);
    gateway.handler.retireTranscript({
      sessionKey,
      sessionId,
      message: committed,
      messageSeq: 2,
    });
    await unlisten.drain();
    expect(thoughts().map((event) => ({ runId: event.runId, data: event.data }))).toEqual([
      { runId: clientRunId, data: { text: "Checking", delta: "Checking", itemId: source.itemId } },
      {
        runId: clientRunId,
        data: { text: "Checking facts", delta: " facts", itemId: source.itemId },
      },
      {
        runId: clientRunId,
        data: {
          phase: "persisted",
          itemId: source.itemId,
          messageSeq: 2,
          messageRunId: runId,
        },
      },
    ]);
    // Live ownership is remapped, while the durable row keeps its producer run.
    const durable = projectSessionMessagePayload({
      sessionKey,
      message: committed,
      messageSeq: 2,
      messageId: "reasoning-row",
      runId,
      projectCurrentUserProfile: (message) => message,
    }).payload;
    expect(durable).toMatchObject({
      runId,
      message: { __openclaw: { runId, seq: 2 } },
    });
    vi.advanceTimersByTime(100);
    expect(thoughts()).toHaveLength(3);

    const second = update("Checking facts", "Checking facts", true);
    await unlisten.drain();
    const nextSource = readAgentAssistantSource(second);
    expect(nextSource?.itemId).toEqual(expect.any(String));
    expect(nextSource?.itemId).not.toBe(source.itemId);
    gateway.chatRunState.flushPendingText(clientRunId);
    expect(thoughts().at(-1)?.data).toEqual({
      text: "Checking facts",
      delta: "Checking facts",
      itemId: nextSource?.itemId,
    });
  } finally {
    subscription.unsubscribe();
    await subscription.waitForPendingEvents();
    await unlisten();
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
  }
});
