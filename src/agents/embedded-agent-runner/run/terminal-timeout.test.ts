import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  markEmbeddedRunAuthProfileSuccess,
  reportEmbeddedRunSuccessfulAuthBinding,
} from "./auth-profile-success.js";
import { resolveReplayInvalidFlag } from "./incomplete-turn-resolution.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { resolveEmbeddedRunTerminalTimeout } from "./terminal-timeout.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

async function resolveTerminal(attempt: EmbeddedRunAttemptResult) {
  const input = makeTerminalInput({
    attempt,
    resolveReplayInvalid: (incompleteTurnText) =>
      resolveReplayInvalidFlag({ attempt, incompleteTurnText }),
  });
  input.prepared = await prepareAttempt({
    attempt,
    currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
    terminalState: input.terminalState,
  });
  const timeout = resolveEmbeddedRunTerminalTimeout({
    ...input,
    terminalPrepared: input.prepared,
  });
  const resolved = timeout
    ? { action: "complete" as const, result: timeout }
    : await resolveEmbeddedRunTerminal(input);
  expect(resolved.action).toBe("complete");
  if (resolved.action !== "complete") {
    throw new Error("Expected terminal completion without replay");
  }
  expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
  expect(input.armPostCompactionGuard).not.toHaveBeenCalled();
  return { input, result: resolved.result };
}

function toolAttempt(overrides: Partial<EmbeddedRunAttemptResult> = {}) {
  const assistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "test.txt" } }],
  });
  return makeEmbeddedRunnerAttempt({
    terminal: { kind: "timeout", phase: "tool_execution", source: "runtime", aborted: true },
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [
      assistant,
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "Saved file contents" }],
        isError: false,
        timestamp: 0,
      },
    ],
    toolMetas: [{ toolName: "read", toolCallId: "read-1", isError: false, replaySafe: true }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...overrides,
  });
}

describe("tool timeout terminal bookkeeping", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { compactionFailure: false, toolWarning: false },
    { compactionFailure: true, toolWarning: false },
    { compactionFailure: false, toolWarning: true },
  ])(
    "reports an unfinished tool timeout without success bookkeeping (compaction failure: $compactionFailure, tool warning: $toolWarning)",
    async ({ compactionFailure, toolWarning }) => {
      const attempt = toolAttempt({
        lastToolError: toolWarning ? { toolName: "read", error: "Earlier read failed" } : undefined,
        terminal: {
          kind: "timeout",
          phase: "tool_execution",
          source: "runtime",
          aborted: true,
          ...(compactionFailure
            ? { failure: { source: "compaction" as const, error: "synthetic bridge interrupted" } }
            : {}),
        },
      });
      const messages = [...attempt.messagesSnapshot];
      const { input, result } = await resolveTerminal(attempt);

      expect(result.payloads).toHaveLength(toolWarning ? 2 : 1);
      expect(result.payloads?.at(-1)).toEqual({
        text: expect.stringContaining("Request timed out"),
        isError: true,
      });
      expect(result.meta).toMatchObject({
        modelFallbackStopReason: "agent_run_terminal_timeout",
        livenessState: "blocked",
        error: { kind: "incomplete_turn", fallbackSafe: false },
      });
      expect(result.meta.executionTrace?.attempts ?? []).not.toContainEqual(
        expect.objectContaining({ result: "success" }),
      );
      expect(input.setTerminalLifecycleMeta).toHaveBeenCalledWith(
        expect.objectContaining({ livenessState: "blocked" }),
      );
      expect(markEmbeddedRunAuthProfileSuccess).not.toHaveBeenCalled();
      expect(reportEmbeddedRunSuccessfulAuthBinding).not.toHaveBeenCalled();
      expect(attempt.messagesSnapshot).toEqual(messages);
    },
  );

  it.each(["ok", "timeout"] as const)(
    "preserves %s attempts with accepted continuations",
    async (kind) => {
      const { result } = await resolveTerminal(
        toolAttempt({
          ...(kind === "ok" ? { terminal: { kind } } : {}),
          yieldDetected: true,
          acceptedSessionSpawns: [{ runId: "child-1", childSessionKey: "agent:main:subagent:1" }],
        }),
      );
      expect(result.meta.error).toBeUndefined();
      expect(result.meta.livenessState).toBe("paused");
      expect(result.payloads ?? []).toEqual([]);
      expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    },
  );

  it("keeps a successful final answer and successful bookkeeping", async () => {
    const text = "The file contains Saved file contents.";
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const { result } = await resolveTerminal(
      toolAttempt({
        terminal: { kind: "ok" },
        assistantTexts: [text],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptCompletedAssistant: assistant,
      }),
    );
    expect(result.payloads).toEqual([{ text, replyToTag: false }]);
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.livenessState).toBe("working");
    expect(markEmbeddedRunAuthProfileSuccess).toHaveBeenCalledOnce();
    expect(reportEmbeddedRunSuccessfulAuthBinding).toHaveBeenCalledOnce();
  });
});
