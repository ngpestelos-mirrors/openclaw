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

function loadedPane(text: string, id: string) {
  const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage(text));
  return { load, pane: mountTranscript(id, load) };
}
function sequence(...bodies: Promise<FullMessageResult>[]) {
  const load = vi.fn<SidebarFullMessageLoader>();
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
  sessionKey = "agent:work:main",
): RecoveryTranscriptElement {
  const pane = document.createElement("test-recovery-transcript") as RecoveryTranscriptElement;
  pane.props = {
    ...threadProps(paneId, sessionKey, [previewMessage]),
    fullMessageAgentId: "work",
    loadFullAssistantMessage,
  };
  document.body.append(pane);
  return pane;
}

function click(pane: Element, selector: string) {
  expectDefined(pane.querySelector<HTMLButtonElement>(selector), selector).click();
}

async function searchTranscript(
  pane: RecoveryTranscriptElement,
  query: string,
  expected: string | null,
) {
  if (!pane.querySelector(".agent-chat__search-bar input")) {
    toggleTranscriptSearch(pane.props.paneId);
    await pane.settleUpdates();
  }
  const input = expectDefined(
    pane.querySelector<HTMLInputElement>(".agent-chat__search-bar input"),
    "transcript search input",
  );
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await pane.settleUpdates();
  if (expected === null) {
    expect(pane.bubble).toBeNull();
  } else {
    expect(pane.bubble?.textContent).toContain(expected);
  }
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("updates an unchanged search when a hidden reply finishes recovering", async () => {
  const pending = createDeferred<FullMessageResult>();
  const load = vi.fn<SidebarFullMessageLoader>().mockImplementation(() => pending.promise);
  const pane = mountTranscript("recovery-active-search", load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  await searchTranscript(pane, "lunarneedle", null);

  pending.resolve(fullMessage("The restored exhibit is lunarneedle."));
  await vi.waitFor(() => expect(pane.bubble?.textContent).toContain("lunarneedle"));
  expect(load).toHaveBeenCalledOnce();
});

it("recovers an oversized source group with its tool cards and complete output", async () => {
  const output = "x".repeat(5_000_000) + " OUTPUT_END";
  const call = {
    type: "toolCall",
    id: "large-result",
    name: "exec",
    arguments: { command: "check" },
  };
  const load = vi.fn<SidebarFullMessageLoader>().mockImplementation(async ({ maxChars }) => ({
    ok: true,
    message: {
      role: "assistant",
      __openclaw: { id: "oversized-tools" },
      content: [
        call,
        {
          type: "toolResult",
          id: "large-result",
          name: "exec",
          text: output.slice(0, maxChars ?? 500_000),
        },
      ],
    },
  }));
  const pane = mountTranscript("recovery-oversized-tools", load);
  pane.props = {
    ...pane.props,
    showToolCalls: true,
    messages: [
      {
        role: "assistant",
        content: "[chat.history omitted: message too large]",
        __openclaw: { id: "oversized-tools", truncated: true, reason: "oversized" },
      },
    ],
  };
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
  const load = vi.fn<SidebarFullMessageLoader>().mockRejectedValue(new Error("offline"));
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
  const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage("Original answer."));
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
  const load = vi.fn<SidebarFullMessageLoader>().mockResolvedValue(fullMessage("First scope."));
  const pane = mountTranscript("recovery-routing", load, "global");
  await pane.waitForText("First scope.");
  await searchTranscript(pane, "First scope", "First scope.");

  load.mockResolvedValue(fullMessage("Second scope."));
  pane.props = {
    ...pane.props,
    ...(scope === "session" ? { sessionKey: "agent:work:other" } : { fullMessageAgentId: "other" }),
  };
  await pane.draw();
  expect(pane.bubble).toBeNull();
  toggleTranscriptSearch(pane.props.paneId);
  await pane.waitForText("Second scope.");
  expect(load).toHaveBeenLastCalledWith({
    sessionKey: pane.props.sessionKey,
    agentId: pane.props.fullMessageAgentId,
    messageId: "assistant-full-1",
  });
  await searchTranscript(pane, "First scope", null);
  await searchTranscript(pane, "Second scope", "Second scope.");
});

it("keeps recovered pending-input text until that input leaves the source", async () => {
  const { load, pane } = loadedPane("Accepted input.", "recovery-pending-input");
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
  pane.props.messages = [];
  pane.props.pendingInputs = pendingInputs;
  await pane.waitForText("Accepted input.");
  await pane.draw();
  expect(load).toHaveBeenCalledOnce();
  expect(pane.textContent).toContain("Accepted input.");
  await searchTranscript(pane, "Accepted input", "Accepted input.");

  await pane.draw({ pendingInputs: [] });
  load.mockResolvedValue(fullMessage("Revisited input."));
  await pane.draw({ pendingInputs });
  expect(pane.bubble).toBeNull();
  toggleTranscriptSearch(pane.props.paneId);
  await pane.waitForText("Revisited input.");
  expect(load).toHaveBeenCalledTimes(2);
});

it("stops searching recovered text when the source is no longer capped", async () => {
  const { load, pane } = loadedPane("Recovered body.", "recovery-replaced-source");
  await pane.waitForText("Recovered body.");
  await searchTranscript(pane, "Recovered body", "Recovered body.");

  pane.props.messages = [
    {
      ...previewMessage,
      content: "Current source body.",
      __openclaw: { id: "assistant-full-1" },
    },
  ];
  await pane.draw();
  expect(pane.bubble).toBeNull();
  await searchTranscript(pane, "Current source body", "Current source body.");
  expect(load).toHaveBeenCalledOnce();
});
