import { expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { ChatLog } from "./components/chat-log.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import { makeTuiState } from "./tui-event-test-support.js";

it("renders append-only chat output and clears an empty replacement", () => {
  const state = makeTuiState({ activeChatRunId: "run-1" });
  const chatLog = new ChatLog();
  const handlers = createEventHandlers({
    state,
    chatLog,
    btw: { clear: vi.fn(), showResult: vi.fn() },
    tui: { requestRender: vi.fn() },
    setActivityStatus: vi.fn(),
    updateFooter: vi.fn(),
    loadHistory: async () => ({ loaded: false }),
    streamingWatchdogMs: 0,
  });
  const event = { runId: "run-1", sessionKey: state.currentSessionKey, state: "delta" };
  const render = () => normalizeTestText(chatLog.render(120).join("\n"));
  try {
    handlers.handleChatEvent({
      ...event,
      deltaText: "Hello",
      message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    });
    handlers.handleChatEvent({ ...event, deltaText: " world" });
    expect(render()).toContain("Hello world");
    handlers.handleChatEvent({ ...event, deltaText: "", replace: true });
    expect(render()).not.toContain("Hello");
    handlers.handleChatEvent({ ...event, deltaText: "Rewritten" });
    expect(render()).toContain("Rewritten");
  } finally {
    handlers.dispose();
    chatLog.dispose();
  }
});
