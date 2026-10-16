// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  localParticipantIdentityKey,
  sessionParticipantIdentityKey,
} from "../../lib/chat/sender-label.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type Props = Parameters<typeof buildCachedChatItems>[0];
function userMessage(content: string, timestamp: number, overrides: Record<string, unknown> = {}) {
  return { role: "user", content, timestamp, ...overrides };
}
function assistantMessage(
  content: string,
  timestamp: number,
  overrides: Record<string, unknown> = {},
) {
  return { role: "assistant", content, timestamp, ...overrides };
}
function namedPrompt(
  content: string,
  timestamp: number,
  id: string,
  name: string,
  metadata: Record<string, unknown> = {},
) {
  return userMessage(content, timestamp, {
    __openclaw: { senderId: id, senderName: name, ...metadata },
  });
}
function observedSender(accountId: string) {
  return { type: "observation", pluginId: "slack", accountId, senderKind: "human", id: "alice" };
}
function profilePrompt(...args: Parameters<typeof namedPrompt>) {
  const [content, timestamp, id, name, metadata] = args;
  return namedPrompt(content, timestamp, id, name, {
    senderIdentity: { type: "profile", id },
    ...metadata,
  });
}
function queuedPrompt(id: string, message: Record<string, unknown>, acceptedAt: number) {
  return { id, runId: id, acceptedAt, state: "queued" as const, message };
}
function boundary(
  label: string,
  searchOpen: boolean,
  fields: Record<string, unknown>,
  recipient?: string,
) {
  return {
    boundary: label,
    searchOpen,
    recipient,
    message: { role: "assistant", content: label, timestamp: searchOpen ? 1002 : 1006, ...fields },
  };
}
function sender(senderId = "alice", fields: Record<string, unknown> = {}) {
  return { senderId, senderName: senderId === "alice" ? "Alice" : "Bob", ...fields };
}
const profileKey = (id: string) => sessionParticipantIdentityKey({ type: "profile", id });
function senderCase(
  label: string,
  senders: Record<string, unknown>[],
  shared?: boolean,
  people: string[] = [],
) {
  return { case: label, senders, shared, people };
}
function messageGroups(props: Partial<Props>) {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}
beforeEach(() => resetChatThreadState());
describe("reply attribution grouping", () => {
  it.each([
    boundary("sender-less user", false, { role: "user" }),
    boundary("[System] Scheduled report", false, {
      role: "user",
      provenance: { kind: "internal_system", sourceTool: "cron" },
      __openclaw: { idempotencyKey: "system-run:user" },
    }),
    boundary("forwarded input", false, {
      senderSession: { sessionKey: "agent:other:main" },
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
    boundary("human prompt", true, { role: "user", __openclaw: sender("bob") }, "Bob"),
    boundary("forwarded input", true, {
      senderLabel: "Forwarded from main",
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
    boundary("projected source", true, {
      senderSession: { sessionKey: "agent:other:main", agentId: "other" },
    }),
    boundary("cron delivery", true, {
      senderLabel: "Daily report",
      provenance: {
        kind: "internal_system",
        sourceTool: "cron",
        jobId: "daily",
        runId: "cron-run",
        sourceSessionKey: "agent:main:cron:daily",
      },
    }),
    boundary("projected turn", true, {
      __openclaw: { turnBoundary: true },
    }),
  ])("attributes $boundary prompts (search=$searchOpen)", ({ message, recipient, searchOpen }) => {
    const alice = namedPrompt("Alice asks", 1000, "alice", "Alice");
    const followUp = namedPrompt("Bob follows up", 1003, "bob", "Bob");
    const groups = messageGroups({
      searchOpen,
      searchQuery: "Rollout",
      replyPeople: searchOpen ? ["alice", "bob"].map((id) => profileKey(id)) : undefined,
      messages: searchOpen
        ? [
            alice,
            assistantMessage("Rollout started", 1001),
            message,
            assistantMessage("Rollout done", 1003),
          ]
        : [
            alice,
            assistantMessage("For Alice", 1001),
            namedPrompt("Bob asks", 1002, "bob", "Bob"),
            followUp,
            assistantMessage("For Bob", 1004),
            message,
            assistantMessage("After boundary", 1007),
          ],
    });
    if (searchOpen) {
      expect(groups.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
        [1, "Alice"],
        [1, recipient],
      ]);
    } else {
      const replies = groups.filter((group) => group.role === "assistant");
      expect(replies[0]).toMatchObject({
        replyToSender: { id: "alice", name: "Alice" },
        replyToMessage: { message: alice },
      });
      const bob = groups.find((group) => group.role === "user" && group.sender?.id === "bob");
      expect(bob?.messages).toHaveLength(2);
      expect(replies[1]).toMatchObject({
        replyToSender: { id: "bob", name: "Bob" },
        replyToMessage: { message: followUp, key: bob?.messages.at(-1)?.key },
      });
      const last = replies.at(-1);
      expect([last?.replyToSender, last?.replyToMessage]).toEqual([undefined, undefined]);
    }
  });

  it.each(["human", "forwarded", "projected source"] as const)(
    "keeps tool results across a hidden %s boundary",
    (kind) => {
      const invocation = {
        role: "assistant",
        content: [
          { type: "text", text: "Rollout started" },
          { type: "tool_call", id: "reused", name: "custom", arguments: {} },
        ],
        timestamp: 1000,
      };
      const separator =
        kind === "human"
          ? userMessage("New request", 1001)
          : assistantMessage(
              "Forwarded request",
              1001,
              kind === "forwarded"
                ? { provenance: { kind: "inter_session", sourceTool: "sessions_send" } }
                : { senderSession: { sessionKey: "agent:other:main", agentId: "other" } },
            );
      const result = {
        role: "toolResult",
        toolCallId: "reused",
        toolName: "custom",
        content: "Rollout result from the later turn",
        timestamp: 1002,
      };
      const sources = messageGroups({
        messages: [invocation, separator, result],
        searchOpen: true,
        searchQuery: "Rollout",
      }).flatMap((group) => group.messages);
      expect(sources.map((source) => source.message)).toEqual([invocation, result]);
    },
  );

  it.each(["pending", "local"] as const)(
    "attributes recovered output across hidden %s prompts",
    (source) => {
      const local = source === "local";
      const prompt = namedPrompt("Please resume", 1002, "bob", "Bob", { id: "pending:bob" });
      const groups = messageGroups({
        searchOpen: true,
        searchQuery: "Rollout",
        replyLocalPerson: local ? localParticipantIdentityKey("viewer") : undefined,
        messages: [
          namedPrompt("Rollout plan?", 1000, local ? "bob" : "alice", local ? "Bob" : "Alice"),
          assistantMessage("Rollout started", 1001),
          assistantMessage(
            "Rollout resumed",
            1003,
            local ? { __openclaw: { id: "recovered", seq: 3, runId: "local-run" } } : {},
          ),
        ],
        queue: local
          ? [
              {
                id: "local",
                text: "Please resume",
                createdAt: 1002,
                sendRunId: "local-run",
                sendState: "waiting-reconnect",
                sendAttempts: 1,
              },
            ]
          : [],
        pendingInputs: local
          ? undefined
          : [{ id: "bob", acceptedAt: 1002, state: "interrupted", message: prompt }],
      });
      const replies = groups.filter((group) => group.role === "assistant");
      expect(replies.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
        [1, local ? "Bob" : "Alice"],
        [1, local ? undefined : "Bob"],
      ]);
      if (local) {
        expect(replies[1]?.replyShared).toBe(true);
        expect(replies[1]?.replyTurnSource?.key).toBe("msg:send:local-run:0");
      } else {
        expect(replies[1]?.replyTurnSource?.message).toBe(prompt);
        expect(
          groups.some((group) => group.messages.some((entry) => entry.message === prompt)),
        ).toBe(false);
      }
    },
  );

  it.each([false, true])("attributes live output before future input (search=%s)", (searchOpen) => {
    const current = namedPrompt("Current prompt", 1000, "bob", "Bob", { id: "pending:current" });
    const future = namedPrompt("Rollout follow-up", 1001, "alice", "Alice", {
      id: "pending:future",
    });
    const items = buildCachedChatItems(
      createProps({
        searchOpen,
        searchQuery: "Rollout",
        runId: "current",
        stream: "Rollout in progress",
        streamStartedAt: 1002,
        pendingInputs: [
          queuedPrompt("current", current, 1000),
          queuedPrompt("future", future, 1001),
        ],
      }),
    );
    const streamIndex = items.findIndex((item) => item.kind === "stream");
    const futureIndex = items.findIndex(
      (item) => item.kind === "group" && item.messages.some((source) => source.message === future),
    );
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(streamIndex).toBeLessThan(futureIndex);
    const stream = items[streamIndex];
    expect(stream).toMatchObject({ replyToSender: { name: "Bob" } });
    expect(stream?.kind === "stream" && stream.replyToMessage?.message).toBe(current);
  });

  it.each([
    senderCase("listed legacy profile", [sender()], undefined, [profileKey("alice")]),
    senderCase("renamed untyped sender", [
      sender(),
      sender("alice", { senderName: "Alice Liddell", senderUsername: "al" }),
    ]),
    senderCase("typed after untyped profile", [
      sender(),
      { senderId: "alice", senderIdentity: { type: "profile", id: "alice" } },
    ]),
    senderCase("two untyped senders", [sender(), sender("bob")], true, [profileKey("alice")]),
    senderCase("reordered observation fields", [
      { senderId: "alice", senderIdentity: observedSender("work") },
      {
        senderId: "alice",
        senderIdentity: Object.fromEntries(Object.entries(observedSender("work")).toReversed()),
      },
    ]),
    senderCase(
      "same id, distinct accounts",
      ["work", "personal"].map((accountId) => ({
        senderId: "alice",
        senderIdentity: observedSender(accountId),
      })),
      true,
    ),
  ])("counts people by stable sender id: $case", ({ people, senders, shared }) => {
    const groups = messageGroups({
      replyPeople: people,
      messages: senders.flatMap((metadata, index) => [
        userMessage(`Ask ${index}`, index * 2, { __openclaw: metadata }),
        assistantMessage(`Answer ${index}`, index * 2 + 1),
      ]),
    });

    expect(groups.map((group) => group.replyShared)).toEqual(groups.map(() => shared));
    expect(groups.map((group) => group.role)).toEqual(senders.flatMap(() => ["user", "assistant"]));
    const last = groups.at(-1);
    if (!shared) {
      expect([last?.replyToSender, last?.replyToMessage]).toEqual([undefined, undefined]);
    }
    expect(last?.replyTurnSource?.message).toMatchObject({ content: `Ask ${senders.length - 1}` });
  });

  it.each([
    { peer: "bob", shared: true },
    { peer: "viewer", shared: undefined },
  ])("counts the local viewer beside $peer", ({ peer, shared }) => {
    // The session row lists only its owner; the viewer's own prompts carry no sender.
    const viewer = localParticipantIdentityKey("viewer");
    const attributed = profilePrompt("Status?", 1002, peer, peer);
    const groups = messageGroups({
      replyPeople: [viewer],
      replyLocalPerson: viewer,
      messages: [
        userMessage("Deploy?", 1000),
        assistantMessage("Deploying", 1001),
        attributed,
        assistantMessage("Rollout done", 1003),
      ],
    });

    const [first, last] = groups.filter((group) => group.role === "assistant");
    expect(last?.replyShared).toBe(shared);
    expect(last?.replyToMessage?.message).toBe(shared ? attributed : undefined);
    // The local prompt counts as a person but never names its reply.
    expect(first?.replyToSender).toBeUndefined();
  });

  it.each([
    { first: null, second: "older", groups: 2 },
    { first: "older", second: "newer", groups: 2 },
    { first: "current", second: "older", groups: 2 },
    { first: "older", second: "older", groups: 1 },
  ])("keeps attribution boundaries from $first to $second", ({ first, second, groups }) => {
    const messages = [first, second].map((target, index) =>
      assistantMessage(
        `Reply ${index}`,
        index + 1,
        target === "current"
          ? { openclawDelivery: { replyToCurrent: true } }
          : target
            ? { __openclaw: { replyToId: target } }
            : {},
      ),
    );
    const items = groupMessages(
      messages.map((message, index) => ({ kind: "message", key: `reply:${index}`, message })),
    );
    expect(items).toHaveLength(groups);
    expect(
      items.filter((item) => item.kind === "group").map((group) => group.messages.length),
    ).toEqual(groups === 1 ? [2] : [1, 1]);
  });

  it.each([
    {
      changed: "sender provenance",
      text: "second",
      name: "Bobby",
      avatar: "/api/users/bob/avatar?v=2",
    },
    { changed: "prompt content", text: "updated prompt", name: "Bob", avatar: undefined },
  ])("$changed refreshes attribution on an unchanged assistant reply", ({ text, name, avatar }) => {
    const alice = profilePrompt("first", 1, "alice", "Alice");
    const bob = profilePrompt("second", 2, "bob", "Bob", { id: "bob-prompt" });
    const reply = assistantMessage("answer", 3);
    const input = createProps({ messages: [alice, bob, reply] });
    const original = buildCachedChatItems(input).find(
      (item) => item.kind === "group" && item.role === "assistant",
    );
    const replacement = profilePrompt(text, 2, "bob", name, {
      id: "bob-prompt",
      ...(avatar ? { senderProfileAvatarUrl: avatar } : {}),
    });
    const updated = buildCachedChatItems({ ...input, messages: [alice, replacement, reply] }).find(
      (item) => item.kind === "group" && item.role === "assistant",
    );
    expect(updated).toMatchObject({
      replyToSender: { name, ...(avatar ? { profileAvatarUrl: avatar } : {}) },
    });
    expect(updated?.kind === "group" && updated.replyToMessage?.message).toBe(replacement);
    expect(updated?.kind === "group" && updated.replyToMessage?.key).toBe(
      original?.kind === "group" ? original.replyToMessage?.key : undefined,
    );
  });
});
