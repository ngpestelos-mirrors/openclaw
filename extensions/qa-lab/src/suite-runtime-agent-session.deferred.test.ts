import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, expect, it } from "vitest";
import { readSessionTranscriptSummary } from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
const { cleanup, makeTempDir } = createTempDirHarness();
afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  resetPluginStateStoreForTests();
  await cleanup();
});
function qaSessionEnv(tempRoot: string) {
  return { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "state") };
}
async function seedQaSession(p: { tempRoot: string; sessionKey: string; sessionId: string }) {
  await upsertSessionEntry({
    agentId: "qa",
    env: qaSessionEnv(p.tempRoot),
    sessionKey: p.sessionKey,
    entry: { sessionId: p.sessionId, updatedAt: 10 },
  });
}
async function appendQaTranscriptMessage(p: {
  tempRoot: string;
  sessionKey: string;
  sessionId: string;
  message: unknown;
}) {
  await appendSessionTranscriptMessageByIdentity({
    agentId: "qa",
    env: qaSessionEnv(p.tempRoot),
    sessionId: p.sessionId,
    sessionKey: p.sessionKey,
    message: p.message,
  });
}

it("preserves authenticated deferred-tool chronology without crediting mismatched or failed results", async () => {
  const tempRoot = await makeTempDir("qa-session-transcript-deferred-results-");
  const sessionKey = "agent:qa:deferred-results";
  const sessionId = "session-deferred-results";
  await seedQaSession({ tempRoot, sessionKey, sessionId });
  const calls = [
    "named",
    "opaque",
    "mismatch",
    "nested-error",
    "nested-status-error",
    "outer-error",
  ];
  await appendQaTranscriptMessage({
    tempRoot,
    sessionKey,
    sessionId,
    message: {
      role: "assistant",
      content: calls.map((id) => ({
        type: "toolCall",
        id,
        name: "tool_call",
        arguments: {
          id: id === "opaque" ? "catalog-spawn" : "sessions_spawn",
          args: { task: "fixture" },
        },
      })),
    },
  });
  for (const id of [...calls, "named", "orphan"]) {
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "tool_call",
        timestamp: 100,
        isError: id === "outer-error",
        details: {
          tool: { id: "catalog-spawn", name: id === "mismatch" ? "message" : "sessions_spawn" },
          result: {
            content: [],
            ...(id === "nested-error" ? { isError: true } : {}),
            ...(id === "nested-status-error" ? { details: { status: "error" } } : {}),
          },
        },
      },
    });
  }
  const summary = await readSessionTranscriptSummary(
    { gateway: { tempRoot } } as never,
    sessionKey,
  );
  expect(summary.assistantToolCallCounts.sessions_spawn).toBe(5);
  expect(summary.completedToolCallCounts.sessions_spawn).toBe(5);
  expect(summary.successfulToolCallCounts.sessions_spawn).toBe(2);
  expect(summary.successfulToolCallCounts.message).toBeUndefined();
  expect(
    summary.successfulToolCallEvents?.filter((event) => event.name === "sessions_spawn"),
  ).toEqual([
    { name: "sessions_spawn", timestamp: 100, toolCallId: "named" },
    { name: "sessions_spawn", timestamp: 100, toolCallId: "opaque" },
  ]);
});

it("retains deferred current-source delivery receipts and the direct-reply guard", async () => {
  const tempRoot = await makeTempDir("qa-session-transcript-deferred-message-");
  const sessionKey = "agent:qa:deferred-message";
  const sessionId = "session-deferred-message";
  await seedQaSession({ tempRoot, sessionKey, sessionId });
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "send",
          name: "tool_call",
          arguments: { id: "message", args: { action: "send", message: "fixture" } },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "send",
      toolName: "tool_call",
      isError: false,
      timestamp: 100,
      details: {
        tool: { id: "catalog-message", name: "message" },
        result: {
          content: [],
          details: { sourceReplyRoute: "current-source", receipt: { threadId: "fixture-thread" } },
        },
      },
    },
    { role: "assistant", content: [{ type: "text", text: "Sent." }] },
  ];
  for (const message of [messages[0], messages[1], messages[1], messages[2]]) {
    await appendQaTranscriptMessage({ tempRoot, sessionKey, sessionId, message });
  }
  await expect(
    readSessionTranscriptSummary({ gateway: { tempRoot } } as never, sessionKey),
  ).resolves.toMatchObject({
    currentSourceToolDeliveries: [{ toolName: "message", threadId: "fixture-thread" }],
    successfulToolCallCounts: { tool_call: 1, message: 1 },
    hasDirectReplySelfMessage: true,
  });
});
