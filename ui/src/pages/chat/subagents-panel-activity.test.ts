import { describe, expect, it } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { readSubagentActivitySnapshot, subagentToolCallCount } from "./subagents-panel-activity.ts";
import type { AgentEventPayload } from "./tool-stream-contract.ts";

function toolCall(id: string | undefined = "read-1") {
  return {
    role: "assistant",
    runId: "run-1",
    content: [
      { type: "toolCall", ...(id ? { id } : {}), name: "read", arguments: { path: "src/app.ts" } },
    ],
  };
}

function toolResult() {
  return {
    role: "toolResult",
    runId: "run-1",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "export const ready = true;" }],
  };
}

function activity(extra: Partial<AgentActivityItem> = {}): AgentActivityItem {
  return {
    itemId: "item-read-1",
    toolCallId: "read-1",
    kind: "tool",
    name: "read",
    title: "Read file",
    phase: "end",
    status: "completed",
    ...extra,
  };
}

function complete(messages: unknown[], extra: Partial<ChatHistoryResult> = {}): ChatHistoryResult {
  return { messages, hasMore: false, totalMessages: messages.length, ...extra };
}

function event(stream: string, data: AgentEventPayload["data"], seq: number): AgentEventPayload {
  return { runId: "run-1", seq, ts: 1000 + seq, stream, data };
}

const count = (history: ChatHistoryResult) =>
  subagentToolCallCount(readSubagentActivitySnapshot(history));
const live = (events: AgentEventPayload[], messages: unknown[] = []) =>
  complete(messages, { inFlightRun: { runId: "run-1", events } });

describe("subagent panel call counts", () => {
  it.each<[string, ChatHistoryResult, ReturnType<typeof count>]>([
    ["complete ordinary history", complete([toolCall()]), { count: 1, exact: true }],
    [
      "older pages remain",
      complete([toolCall()], { hasMore: true, nextOffset: 1, totalMessages: 20 }),
      { count: 1, exact: false },
    ],
    ["empty incomplete history", { messages: [], hasMore: true }, undefined],
    ["unkeyed legacy call", complete([toolCall("")]), undefined],
    [
      "call without a recorded run owner",
      complete([{ ...toolCall(), runId: undefined }]),
      undefined,
    ],
    [
      "prepared item without an invocation ID",
      complete([
        {
          role: "assistant",
          runId: "run-1",
          content: [],
          activity: [activity({ toolCallId: undefined })],
        },
      ]),
      undefined,
    ],
    ["unknown history", {}, undefined],
  ])("reports count certainty for %s", (_name, history, expected) => {
    expect(count(history)).toEqual(expected);
  });

  it("counts paired transcript calls, results and replayed live items once", () => {
    const history = live(
      [
        event("tool", { toolCallId: "read-1", name: "read", phase: "start" }, 1),
        event("item", activity({ phase: "start", status: "running" }), 2),
        event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 3),
        event("item", activity(), 4),
      ],
      [toolCall(), toolResult()],
    );
    expect(count(history)).toEqual({ count: 1, exact: true });
  });

  it("keeps reused call IDs in distinct recorded runs separate while deduplicating each result", () => {
    expect(
      count(
        complete(
          [
            { ...toolCall(), activity: [activity()] },
            toolResult(),
            { ...toolCall(), runId: "run-2", activity: [activity()] },
            { ...toolResult(), runId: "run-2" },
          ],
          {
            inFlightRun: {
              runId: "run-2",
              events: [{ ...event("item", activity(), 1), runId: "run-2" }],
            },
          },
        ),
      ),
    ).toEqual({ count: 2, exact: true });
  });

  it("keeps a lower bound when an invocation ID is omitted across item frames", () => {
    const known = activity({
      phase: "update",
      status: "running",
      progressText: "Reading source",
    });
    const itemOnly = activity({
      toolCallId: undefined,
      phase: "start",
      status: "running",
      progressText: "Reading source",
    });
    const snapshot = readSubagentActivitySnapshot(
      live([known, itemOnly].map((item, index) => event("item", item, index + 1))),
    );
    expect(subagentToolCallCount(snapshot)).toEqual({ count: 1, exact: false });
    expect(snapshot.tool).toMatchObject({ name: "read", text: "Reading source" });
  });

  it.each([
    {
      name: "a prepared hidden item follows its raw lifecycle frame",
      events: [
        event("tool", { toolCallId: "read-1", name: "read", phase: "result" }, 1),
        event("item", activity({ hideFromChannelProgress: true }), 2),
      ],
      expected: { count: 0, exact: true },
    },
    {
      name: "a suppressed duplicate follows its visible prepared operation",
      events: [
        event("item", activity(), 1),
        event("item", activity({ itemId: "duplicate-item", suppressChannelProgress: true }), 2),
      ],
      expected: { count: 1, exact: true },
    },
  ])("preserves prepared visibility when $name", ({ events, expected }) => {
    expect(count(live(events))).toEqual(expected);
  });
});
