/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { resetChatViewState } from "../chat-view-state.test-support.ts";
import { renderChatThread, TranscriptTestHost } from "../test-helpers/chat-transcript-native.tsx";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import { toggleTranscriptSearch, type ChatThreadProps } from "./chat-thread-interactions.ts";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

type FullMessageResult = Awaited<ReturnType<SidebarFullMessageLoader>>;

const previewMessage = {
  role: "assistant",
  content: "Preview\n...(truncated)...",
  __openclaw: { id: "assistant-full-1", truncated: true },
  timestamp: 1_000,
};

const loader = () => vi.fn<SidebarFullMessageLoader>();
function sequence(...bodies: Promise<FullMessageResult>[]) {
  const load = loader();
  for (const body of bodies) {
    load.mockImplementationOnce(() => body);
  }
  return load;
}
function fullMessage(content: string): FullMessageResult {
  return { ok: true, message: { role: "assistant", content } };
}

class RecoveryTranscriptElement extends TranscriptTestHost {
  props: ChatThreadProps = threadProps("recovery-pane");
  resetPresentationOnDisconnect = true;
  override readonly transcript = createChatTranscript(() => this.props.paneId);

  override renderTranscript = () => renderChatThread(this.props, this.transcript, { search: true });
  get bubble() {
    return this.querySelector(".chat-bubble");
  }
  async draw(changes: Partial<ChatThreadProps> = {}) {
    Object.assign(this.props, changes);
    this.requestRender();
    await this.updateComplete;
  }
  waitForText(text: string) {
    return vi.waitFor(() => expect(this.textContent).toContain(text));
  }

  async search(query: string, expected: string | null) {
    if (!this.querySelector(".agent-chat__search-bar input")) {
      toggleTranscriptSearch(this.props.paneId);
      await this.settleUpdates();
    }
    const input = expectDefined(
      this.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
      "transcript search input",
    );
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await this.settleUpdates();
    if (expected === null) {
      expect(this.bubble).toBeNull();
    } else {
      expect(this.bubble?.textContent).toContain(expected);
    }
  }

  override disconnectedCallback() {
    // Match the pane-specific production reset before disposing the transcript.
    if (this.resetPresentationOnDisconnect) {
      resetChatViewState(this.props.paneId);
    }
    super.disconnectedCallback();
  }
}

customElements.define("test-recovery-transcript", RecoveryTranscriptElement);

function mountTranscript(
  paneId: string,
  loadFullAssistantMessage: SidebarFullMessageLoader,
  changes: Partial<ChatThreadProps> = {},
): RecoveryTranscriptElement {
  const pane = document.createElement("test-recovery-transcript") as RecoveryTranscriptElement;
  pane.props = {
    ...threadProps(paneId, "agent:work:main", [previewMessage]),
    fullMessageAgentId: "work",
    loadFullAssistantMessage,
    ...changes,
  };
  document.body.append(pane);
  return pane;
}

function click(pane: Element, selector: string) {
  expectDefined(pane.querySelector<HTMLButtonElement>(selector), selector).click();
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("updates an unchanged search when a hidden reply finishes recovering", async () => {
  const pending = createDeferred<FullMessageResult>();
  const load = sequence(pending.promise);
  const pane = mountTranscript("recovery-active-search", load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  await pane.search("lunarneedle", null);

  pending.resolve(fullMessage("The restored exhibit is lunarneedle."));
  await vi.waitFor(() => expect(pane.bubble?.textContent).toContain("lunarneedle"));
  expect(load).toHaveBeenCalledOnce();
});

it("recovers an oversized source group with its tool cards and complete output", async () => {
  const output = "x".repeat(5_000_000) + " OUTPUT_END";
  const tool = { id: "large-result", name: "exec" };
  const load = loader().mockImplementation(async ({ maxChars }) => ({
    ok: true,
    message: {
      role: "assistant",
      __openclaw: { id: "oversized-tools" },
      content: [
        { ...tool, type: "toolCall", arguments: { command: "check" } },
        { ...tool, type: "toolResult", text: output.slice(0, maxChars ?? 500_000) },
      ],
    },
  }));
  const pane = mountTranscript("recovery-oversized-tools", load, {
    showToolCalls: true,
    messages: [
      {
        role: "assistant",
        content: "[chat.history omitted: message too large]",
        __openclaw: { id: "oversized-tools", truncated: true, reason: "oversized" },
      },
    ],
  });
  await pane.updateComplete;
  await expectDefined(load.mock.results[0]?.value, "full-message load");
  await pane.updateComplete;
  expect(load).toHaveBeenCalledExactlyOnceWith({
    sessionKey: "agent:work:main",
    agentId: "work",
    messageId: "oversized-tools",
    maxChars: 8_000_000,
  });
  click(pane, ".chat-tool-msg-summary");
  await vi.dynamicImportSettled();
  await pane.updateComplete;
  expect(pane.querySelector(".chat-tool-term__out")?.textContent).toBe(output);
  expect(pane.textContent).not.toContain("This message is too large to display here.");
  expect(pane.textContent).not.toContain("Could not load the full message.");
});

it("keeps the preview through bounded retries and recovers on manual retry", async () => {
  const load = loader().mockRejectedValue(new Error("offline"));
  const pane = mountTranscript("recovery-unavailable", load);
  await pane.waitForText("Could not load the full message.");
  expect(load).toHaveBeenCalledTimes(3);
  expect(pane.textContent).toContain("Preview");
  expect(pane.textContent).toContain("...(truncated)...");
  expect(pane.querySelector(".chat-message-disclosure__toggle")).toBeNull();

  load.mockResolvedValue(fullMessage("Available after retry."));
  click(pane, ".chat-message-load-error__retry");
  await pane.waitForText("Available after retry.");
  expect(load).toHaveBeenCalledTimes(4);
});

it.each(["reconnect loading", "reconnect loaded", "remount", "prune"] as const)(
  "retires recovery across %s without accepting the old completion",
  async (boundary) => {
    const retired = createDeferred<FullMessageResult>();
    const current = createDeferred<FullMessageResult>();
    const load = sequence(retired.promise, current.promise);
    const pane = mountTranscript("recovery-retirement", load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    const loaded = boundary === "reconnect loaded";
    if (loaded) {
      retired.resolve(fullMessage("Retired body."));
      await pane.waitForText("Retired body.");
    }
    let active = pane;
    if (boundary === "prune") {
      await pane.draw({ messages: [] });
      await pane.draw({ messages: [previewMessage] });
    } else {
      // Reconnect retains presentation so invalidation must come from the controller.
      pane.resetPresentationOnDisconnect = boundary === "remount";
      pane.remove();
      if (boundary === "remount") {
        active = mountTranscript("recovery-retirement", load);
      } else {
        document.body.append(pane);
        pane.requestRender();
      }
    }
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await active.updateComplete;
    await flushDeferredRowPrune();
    expect(active.textContent).not.toContain("Retired body.");
    // Remount's new body lands before the stale completion; pruning/reconnect land after it.
    if (boundary === "remount") {
      current.resolve(fullMessage("Current body."));
      await active.waitForText("Current body.");
    }
    if (!loaded) {
      const updates = vi.spyOn(pane, "requestRender");
      retired.resolve(fullMessage("Retired body."));
      await flushDeferredRowPrune();
      expect(updates).not.toHaveBeenCalled();
      expect(active.textContent).not.toContain("Retired body.");
    }
    if (boundary !== "remount") {
      current.resolve(fullMessage("Current body."));
    }
    await active.waitForText("Current body.");
    expect(load).toHaveBeenCalledTimes(2);
  },
);

it("retires a disconnected pane's bodies without invalidating a surviving split pane", async () => {
  const load = loader().mockResolvedValue(fullMessage("Original answer."));
  const first = mountTranscript("recovery-split-first", load);
  await first.waitForText("Original answer.");
  const sibling = mountTranscript("recovery-split-second", load);
  await sibling.waitForText("Original answer.");
  const loadedRequests = load.mock.calls.length;

  first.remove();
  await sibling.draw();
  expect(sibling.textContent).toContain("Original answer.");
  expect(load).toHaveBeenCalledTimes(loadedRequests);

  load.mockResolvedValue(fullMessage("Recovered after remount."));
  const replacement = mountTranscript("recovery-split-first", load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(loadedRequests + 1));
  await replacement.waitForText("Recovered after remount.");
  expect(sibling.textContent).toContain("Original answer.");
});

it.each(["session", "agent"] as const)("scopes recovery to the requested %s", async (scope) => {
  const load = loader().mockResolvedValue(fullMessage("First scope."));
  const pane = mountTranscript("recovery-routing", load, { sessionKey: "global" });
  await pane.waitForText("First scope.");
  await pane.search("First scope", "First scope.");

  load.mockResolvedValue(fullMessage("Second scope."));
  await pane.draw(
    scope === "session" ? { sessionKey: "agent:work:other" } : { fullMessageAgentId: "other" },
  );
  expect(pane.bubble).toBeNull();
  toggleTranscriptSearch(pane.props.paneId);
  await pane.waitForText("Second scope.");
  expect(load).toHaveBeenLastCalledWith({
    sessionKey: pane.props.sessionKey,
    agentId: pane.props.fullMessageAgentId,
    messageId: "assistant-full-1",
  });
  await pane.search("First scope", null);
  await pane.search("Second scope", "Second scope.");
});

it("keeps recovered pending-input text until that input leaves the source", async () => {
  const load = loader().mockResolvedValue(fullMessage("Accepted input."));
  const pendingInputs: ChatThreadProps["pendingInputs"] = [
    {
      id: "accepted-1",
      acceptedAt: 1_000,
      state: "queued",
      message: {
        ...previewMessage,
        role: "user",
        __openclaw: { id: "pending:accepted-1", truncated: true },
      },
    },
  ];
  const pane = mountTranscript("recovery-pending-input", load, { messages: [], pendingInputs });
  await pane.waitForText("Accepted input.");
  await pane.draw();
  expect(load).toHaveBeenCalledOnce();
  expect(pane.textContent).toContain("Accepted input.");
  await pane.search("Accepted input", "Accepted input.");

  await pane.draw({ pendingInputs: [] });
  load.mockResolvedValue(fullMessage("Revisited input."));
  await pane.draw({ pendingInputs });
  expect(pane.bubble).toBeNull();
  toggleTranscriptSearch(pane.props.paneId);
  await pane.waitForText("Revisited input.");
  expect(load).toHaveBeenCalledTimes(2);
});

it("stops searching recovered text when the source is no longer capped", async () => {
  const load = loader().mockResolvedValue(fullMessage("Recovered body."));
  const pane = mountTranscript("recovery-replaced-source", load);
  await pane.waitForText("Recovered body.");
  await pane.search("Recovered body", "Recovered body.");

  await pane.draw({
    messages: [
      {
        ...previewMessage,
        content: "Current source body.",
        __openclaw: { id: "assistant-full-1" },
      },
    ],
  });
  expect(pane.bubble).toBeNull();
  await pane.search("Current source body", "Current source body.");
  expect(load).toHaveBeenCalledOnce();
});
