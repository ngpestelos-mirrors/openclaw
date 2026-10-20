import { expectDefined } from "@openclaw/normalization-core";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import {
  createTestTranscript as createTranscript,
  stubAnimationFrames,
} from "../chat-view.test-helpers.ts";
import { projectChatTranscriptMetadata } from "../session-message-cache.ts";
import {
  render,
  renderChatThread,
  renderTranscriptSearch,
} from "../test-helpers/chat-transcript-native.tsx";
import * as chatMessage from "./chat-message-group-frame.ts";
import {
  getTranscriptState,
  toggleTranscriptSearch,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  requireElement,
  threadProps,
} from "./chat-transcript.test-support.ts";

const transcripts: ReturnType<typeof createTranscript>[] = [];
function createTestTranscript(...args: Parameters<typeof createTranscript>) {
  const transcript = createTranscript(...args);
  transcripts.push(transcript);
  return transcript;
}
function threadView(props: ChatThreadProps, transcript = createTestTranscript()) {
  const container = document.body.appendChild(document.createElement("div"));
  const rerender = () => {
    render(renderChatThread(props, transcript), container);
    transcript.update();
  };
  const start = async () => {
    rerender();
    transcript.start();
    await flushDeferredRowPrune();
  };
  return { transcript, container, rerender, start };
}
const inlineReply = ".chat-reply-attribution--inline button";
const replyName = ".chat-reply-attribution__name";
const replyTarget = "chat-bubble--reply-target";
function replyAccess(
  read: () => unknown = () => undefined,
): NonNullable<ChatThreadProps["replyMessageAccess"]> {
  return { revision: 0, navigationId: null, read, open: vi.fn() };
}

describe("chat transcript replies", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(() => {
    for (const transcript of transcripts.splice(0)) {
      transcript.dispose();
    }
    vi.useRealTimers();
    resetTranscriptTestDom();
  });

  async function commitLayout() {
    flush();
    await Promise.resolve();
    vi.advanceTimersToNextFrame();
    flush();
  }

  function replyMessages(
    client?: readonly [id: string, mode: string, displayName: string] | null,
    namedHuman = false,
  ) {
    const [id, mode, displayName] = client ?? [];
    return [
      {
        ...turn("source-message", client ? "user" : "assistant", "The original answer", {
          ...(namedHuman ? person("profile-alice", "Alice") : {}),
          ...(client ? { transport: { clients: [{ id, mode, displayName }] } } : {}),
        }),
        timestamp: 1_000,
      },
      {
        ...turn("reply-message", "user", "Follow up", { replyToId: "source-message" }),
        timestamp: 2_000,
      },
    ] as const;
  }

  it.each([
    { name: "ordinary motion", reducedMotion: false, textless: false },
    { name: "reduced motion", reducedMotion: true, textless: false },
    { name: "textless original", reducedMotion: false, textless: true },
  ])(
    "reveals loaded replies and owns their flash lifetime: $name",
    async ({ reducedMotion, textless }) => {
      const flushFrames = stubAnimationFrames();
      const commitReplyLayout = async () => {
        flush();
        await Promise.resolve();
        flushFrames();
        flush();
      };
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("prefers-reduced-motion") && reducedMotion,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      const [source, reply] = replyMessages();
      const open = vi.fn();
      const props = threadProps("pane-reply-preview", "agent:main:main", [
        textless
          ? {
              ...source,
              role: "user",
              content: [],
              __openclaw: { ...source["__openclaw"], replyToId: "elsewhere" },
            }
          : source,
        reply,
      ]);
      props.replyMessageAccess = { revision: 0, navigationId: null, read: () => undefined, open };
      render(renderChatThread(props, transcript), container);
      transcript.start();
      transcript.update();
      await flushDeferredRowPrune();

      const preview = container.querySelector<HTMLButtonElement>(inlineReply);
      if (!textless) {
        expect(preview?.getAttribute("aria-label")).toBe("Replying to Molty");
      }
      expect(preview?.textContent).not.toContain("source-message");

      const sourceBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
        (bubble) => bubble.dataset.entryId === "source-message",
      )!;
      const clickReply = async () => {
        preview?.click();
        await Promise.resolve();
        await commitReplyLayout();
      };
      const duration = reducedMotion ? 1_000 : 1_200;
      vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
      await clickReply();
      expect(open).not.toHaveBeenCalled();
      expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
      if (!textless) {
        sourceBubble.firstElementChild!.dispatchEvent(new Event("animationend", { bubbles: true }));
      }
      expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
      vi.advanceTimersByTime(duration / 2);
      await clickReply();
      vi.advanceTimersByTime(duration - 1);
      expect(sourceBubble.classList.contains(replyTarget)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(sourceBubble.classList.contains(replyTarget)).toBe(false);
      await clickReply();
      transcript.dispose();
      expect(sourceBubble.classList.contains(replyTarget)).toBe(false);
    },
  );

  it.each([
    ["assistant", null, false, "Molty"],
    ["CLI", ["cli", "cli", "Release helper"], false, "via CLI (Release helper)"],
    ["RPC", ["gateway-client", "backend", "Build helper"], false, "via RPC (Build helper)"],
    ["named human via CLI", ["cli", "cli", "Release helper"], true, "Alice"],
  ] as const)(
    "hydrates an unloaded %s reply preview without inserting its source row",
    async (_source, client, namedHuman, senderLabel) => {
      const [sourceMessage, followUp] = replyMessages(client, namedHuman);
      let resolvedMessage: unknown = undefined;
      const access = replyAccess(() => resolvedMessage);
      const { open } = access;
      const props = {
        ...threadProps("pane-reply-hydration", "agent:main:main", [followUp]),
        userId: "profile-viewer",
        userName: "Unrelated Viewer",
        replyMessageAccess: access,
      };
      const { container, rerender, start } = threadView(props);
      await start();

      expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();

      resolvedMessage = { ...sourceMessage, content: "The original message" };
      props.replyMessageAccess.revision += 1;
      rerender();

      const preview = container.querySelector<HTMLButtonElement>(inlineReply);
      expect(preview?.querySelector(replyName)?.textContent?.trim()).toBe(senderLabel);
      expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();
      preview?.click();
      expect(open).toHaveBeenCalledWith("source-message");
    },
  );

  it.each([false, true])(
    "opens folded work when a reply navigation loads its source (run frame: %s)",
    async (framed) => {
      const [sourceMessage, followUp] = replyMessages();
      const props = threadProps("pane-folded-history-reply", "agent:main:dashboard:reply", [
        followUp,
      ]);
      const access = replyAccess(() => sourceMessage);
      const { open } = access;
      props.replyMessageAccess = access;
      const { transcript, container, rerender, start } = threadView(
        props,
        createTestTranscript(props.paneId),
      );
      await start();
      const viewport = requireElement(container, ".chat-thread");
      viewport.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
        viewport.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
        viewport.dispatchEvent(new Event("scroll"));
      };
      requireElement(container, ".chat-reply-attribution--inline button").click();
      expect(open).toHaveBeenCalledWith("source-message");
      props.replyMessageAccess.navigationId = "source-message";
      props.messages = [
        {
          role: "user",
          content: "Prepare an answer",
          timestamp: 0,
          ...(framed ? { __openclaw: { idempotencyKey: "source-run:user" } } : {}),
        },
        { ...sourceMessage, ...(framed ? { runId: "source-run" } : {}) },
        {
          role: "assistant",
          phase: "final_answer",
          content: "Final answer",
          timestamp: 1_500,
          ...(framed ? { runId: "source-run" } : {}),
        },
        followUp,
      ];
      rerender();
      expect(transcript.revealMessage("source-message")).toBe(true);
      rerender();
      await flushDeferredRowPrune();
      expect(
        requireElement(container, ".chat-work-group button").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(requireElement(container, "[data-entry-id='source-message']").textContent).toContain(
        "The original answer",
      );
    },
  );

  const person = (id: string, name: string) => ({
    senderId: id,
    senderName: name,
    senderIdentity: { type: "profile", id },
  });
  const alice = person("alice", "Alice");
  const bob = person("bob", "Bob");
  const owner = {
    actor: { type: "human", id: "alice", identity: { type: "profile", id: "alice" } },
  };
  const turn = (id: string, role: string, content: string, openclaw: object = {}) => ({
    role,
    content,
    timestamp: Number(id.replace(/\D/g, "")),
    __openclaw: { id, ...openclaw },
  });
  const ownPromptReply = [
    turn("p1", "user", "Deploy?", alice),
    turn("a2", "assistant", "Deploying", { replyToId: "p1" }),
  ];
  async function renderedStrips(props: ReturnType<typeof threadProps>, searchQuery?: string) {
    const { transcript, container } = threadView(props);
    if (searchQuery) {
      getTranscriptState(props.paneId).search.toggle();
      getTranscriptState(props.paneId).search.setQuery(searchQuery);
    }
    render(renderChatThread(props, transcript), container);
    transcript.start();
    transcript.update();
    await flushDeferredRowPrune();
    const strips = [...container.querySelectorAll(".chat-reply-attribution--reply")].map((strip) =>
      strip.querySelector(replyName)?.textContent?.trim(),
    );
    expect(container.textContent?.split("Replying to").length).toBe(strips.length + 1);
    return strips;
  }

  const currentReplyCases = [
    { linkage: "the prompt that owns its run", strips: ["Alice"] },
    { linkage: "its own prompt in a 1:1 thread", latest: null, strips: [] },
    { linkage: "an older prompt in a 1:1 thread", latest: alice, strips: ["Alice"] },
    { linkage: "a legacy reply without a run", replyRun: null, strips: [] },
    { linkage: "a prompt without a run key", promptRun: null, strips: [] },
    { linkage: "another run's prompt", promptRun: "run-b", strips: [] },
    { linkage: "duplicate run owners", duplicate: true, strips: [] },
    {
      linkage: "a channel-mirrored reply keyed only by its send",
      reply: { mirrorOrigin: "discord", idempotencyKey: "run-a" },
      strips: [],
    },
  ].map(
    ({
      linkage,
      promptRun = "run-a",
      replyRun = "run-a",
      latest = bob,
      duplicate,
      reply,
      strips,
    }) => ({
      case: linkage,
      query: undefined,
      session: undefined,
      strips,
      messages: [
        ...(duplicate
          ? [turn("p1", "user", "Earlier", { ...alice, idempotencyKey: "run-a:user" })]
          : []),
        turn("p2", "user", "hey hey", {
          ...alice,
          ...(promptRun ? { idempotencyKey: `${promptRun}:user` } : {}),
        }),
        // The latest prompt never stands in for an unresolved origin.
        ...(latest ? [turn("p3", "user", "Unrelated", latest)] : []),
        {
          ...turn("a4", "assistant", "Tô aqui", reply ?? (replyRun ? { runId: replyRun } : {})),
          openclawDelivery: { replyToCurrent: true },
        },
      ],
    }),
  );

  it.each([
    ...currentReplyCases,
    {
      case: "search hides the other speaker",
      messages: [
        turn("p1", "user", "Deploy?", alice),
        turn("a2", "assistant", "Deploying"),
        turn("p3", "user", "Status?", bob),
        turn("a4", "assistant", "Rollout done"),
      ],
      query: "Rollout",
      strips: ["Bob"],
    },
    {
      case: "search hides the prompt this turn answers",
      messages: [
        turn("p1", "user", "Rollout plan?", alice),
        turn("a2", "assistant", "Drafted"),
        turn("p3", "user", "Anything else?", alice),
        turn("a4", "assistant", "Rollout finished", {
          replyToId: "p3",
          replyToPreview: { text: "Anything else?", senderLabel: "Alice" },
        }),
      ],
      query: "Rollout",
      strips: [],
    },
    {
      case: "a system turn replies explicitly to an older human prompt",
      messages: [
        turn("p1", "user", "Please check this report", {
          ...alice,
          idempotencyKey: "run-a:user",
        }),
        {
          ...turn("p2", "user", "[System] Scheduled report", { idempotencyKey: "run-b:user" }),
          provenance: { kind: "internal_system", sourceTool: "cron" },
        },
        {
          ...turn("a3", "assistant", "Answer to the older prompt", { replyToId: "p1" }),
          runId: "run-b",
        },
      ],
      strips: ["Alice"],
    },
    {
      case: "the session has a participant outside the loaded page",
      messages: ownPromptReply,
      session: {
        owner,
        participants: [{ identity: { type: "profile", id: "bob" }, label: "Bob" }],
      },
      strips: ["Alice"],
    },
    {
      case: "the owner reappears as a participant with reordered identity keys",
      messages: ownPromptReply,
      session: {
        owner,
        participants: [{ identity: { id: "alice", type: "profile" }, label: "Alice" }],
      },
      strips: [],
    },
  ])(
    "keeps cached reply attribution from the full conversation when $case",
    async ({ messages, query, session, strips }) => {
      const props = threadProps("pane-reply-context", "agent:main:main", [...messages]);
      if (session) {
        props.transcriptMetadata = projectChatTranscriptMetadata({
          key: props.sessionKey,
          kind: "direct",
          updatedAt: 1,
          ...session,
        } as GatewaySessionRow);
      }
      expect(await renderedStrips(props, query)).toEqual(strips);
    },
  );

  it.each([
    { target: "loaded explicit", loaded: true, readOnly: false },
    { target: "unloaded explicit", loaded: false, readOnly: false },
    { target: "loaded automatic in a read-only archive", loaded: true, readOnly: true },
  ])("clears search and navigates to a $target reply target", async ({ loaded, readOnly }) => {
    vi.useFakeTimers();
    const transcript = createTestTranscript();
    const searchContainer = document.body.appendChild(document.createElement("div"));
    const threadContainer = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    const paneId = "pane-filtered-reply-navigation";
    const [sourceMessage, followUp] = replyMessages();
    const sourceId = readOnly ? "p2" : "source-message";
    const sourceSelector = `[data-entry-id='${sourceId}']`;
    const props = threadProps(
      paneId,
      "agent:main:main",
      readOnly
        ? [
            turn("p1", "user", "Original for Alice", alice),
            turn("p2", "user", "Original for Bob", bob),
            turn("a3", "assistant", "Follow up for Bob"),
          ]
        : [
            ...(loaded ? [sourceMessage] : []),
            {
              ...followUp,
              __openclaw: {
                ...followUp["__openclaw"],
                replyToPreview: { text: "The original answer", senderLabel: "Molty" },
              },
            },
          ],
    );
    if (readOnly) {
      props.selectedSession = {
        key: props.sessionKey,
        kind: "direct",
        updatedAt: 1,
        archived: true,
      };
    } else {
      props.replyMessageAccess = {
        revision: 0,
        navigationId: null,
        read: () => undefined,
        open,
      };
    }
    const rerender = () => {
      render(renderTranscriptSearch(paneId), searchContainer);
      render(renderChatThread(props, transcript), threadContainer);
      transcript.update();
    };
    toggleTranscriptSearch(paneId);
    rerender();
    transcript.start();
    const input = requireElement(searchContainer, "input") as HTMLInputElement;
    input.value = "Follow up";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(threadContainer.querySelector(sourceSelector)).toBeNull();
    requireElement(threadContainer, ".chat-reply-attribution button").click();
    await vi.advanceTimersByTimeAsync(0);
    await commitLayout();

    expect(searchContainer.querySelector("input")).toBeNull();
    if (loaded) {
      expect(open).not.toHaveBeenCalled();
      expect(requireElement(threadContainer, sourceSelector).classList.contains(replyTarget)).toBe(
        true,
      );
    } else {
      expect(open).toHaveBeenCalledWith(sourceId);
    }
  });

  it.each(["group", "frame"] as const)(
    "refreshes an unchanged reply %s when its older original loads or changes",
    async (presentation) => {
      vi.spyOn(Date, "now").mockReturnValue(60_000);
      const history = [
        turn("p1000", "user", "Alice", { senderId: "alice", senderName: "Alice" }),
        turn("a2000", "assistant", "Unrelated"),
        turn("p3000", "user", "Bob", {
          senderId: "bob",
          senderName: "Bob",
          idempotencyKey: "reply-run:user",
        }),
        {
          ...turn("a4000", "assistant", "Answer", {
            replyToId: "p500",
            replyToPreview: { senderLabel: "Old label", text: "Old snapshot" },
          }),
          phase: "final_answer",
          stopReason: "stop",
          ...(presentation === "frame" ? { runId: "reply-run" } : {}),
        },
      ];
      const props = threadProps(
        `pane-reply-source-${presentation}`,
        "agent:main:dashboard:reply-source",
        history,
      );
      const { container, rerender, start } = threadView(props);
      const attribution = () =>
        expectDefined(
          container
            .querySelector('[data-entry-id="a4000"]')
            ?.closest(".chat-group")
            ?.querySelector(".chat-reply-attribution--reply"),
          "reply attribution",
        );
      const prepareFrame = vi.spyOn(chatMessage, "prepareMessageGroupFrame");
      await start();
      expect(attribution().querySelector(`button ${replyName}`)?.textContent).toBe("Old label");
      const unrelatedKey = expectDefined(
        container
          .querySelector('[data-entry-id="a2000"]')
          ?.closest(".chat-group")
          ?.getAttribute("data-chat-row-key"),
        "unrelated group key",
      );
      expect(prepareFrame.mock.calls.some(([group]) => group.key === unrelatedKey)).toBe(true);
      prepareFrame.mockClear();

      for (const [name, text] of [
        ["Carol", "Original question loaded"],
        ["Caroline", "Original question corrected"],
      ]) {
        props.messages = [
          turn("p500", "user", text, { senderId: "carol", senderName: name }),
          ...history,
        ];
        rerender();
        await flushDeferredRowPrune();
        expect(attribution().querySelector(`button ${replyName}`)?.textContent).toBe(name);
        expect(prepareFrame.mock.calls.filter(([group]) => group.key === unrelatedKey)).toEqual([]);
      }
    },
  );
});
