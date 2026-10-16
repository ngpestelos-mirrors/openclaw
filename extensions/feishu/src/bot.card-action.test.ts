import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleFeishuMessage } from "./bot.js";
import { processedCardActions, resolvedCardActionChatTypes } from "./card-action-state.js";
import { handleFeishuCardAction, type FeishuCardActionEvent } from "./card-action.js";
import {
  createFeishuCardInteractionEnvelope as envelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";
import { expectFirstSentCardUsesFillWidthOnly } from "./card-test-helpers.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION as CANCEL,
  FEISHU_APPROVAL_CONFIRM_ACTION as CONFIRM,
  FEISHU_APPROVAL_REQUEST_ACTION as REQUEST,
} from "./card-ux-approval.js";

const { createClient, getChat, sendCard, sendMessage } = vi.hoisted(() => ({
  createClient: vi.fn(),
  getChat: vi.fn(),
  sendCard: vi.fn<typeof import("./send.js").sendCardFeishu>(),
  sendMessage: vi.fn<typeof import("./send.js").sendMessageFeishu>(),
}));
vi.mock("./accounts.js", () => ({
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));
vi.mock("./bot.js", () => ({ handleFeishuMessage: vi.fn() }));
vi.mock("./client.js", () => ({ createFeishuClient: createClient }));
vi.mock("./send.js", () => ({
  sendCardFeishu: sendCard,
  sendMessageFeishu: sendMessage,
}));

describe("Feishu Card Action Handler", () => {
  const log = vi.fn();
  const runtime = { ...createRuntimeEnv(), log };
  const maxDate = 8_640_000_000_000_000;
  const context = () => ({ u: "u123", h: "chat1", e: Date.now() + 60_000 });
  const quickAction = (overrides: Partial<Omit<FeishuCardInteractionEnvelope, "oc">> = {}) =>
    envelope({
      k: "quick",
      a: "feishu.quick_actions.help",
      q: "/help",
      c: { ...context(), t: "group" },
      ...overrides,
    });
  const approvalAction = (expiresAt = Date.now() + 60_000) =>
    envelope({
      k: "meta",
      a: REQUEST,
      m: { command: "/new", prompt: "Start?" },
      c: { ...context(), s: "session", e: expiresAt },
    });
  const cardEvent = (
    value: Record<string, unknown> = quickAction(),
    overrides: Partial<FeishuCardActionEvent> = {},
  ): FeishuCardActionEvent => ({
    operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
    token: "callback-token",
    action: { value, tag: "button" },
    context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    ...overrides,
  });
  const dispatch = (
    event = cardEvent(),
    options: Omit<Parameters<typeof handleFeishuCardAction>[0], "cfg" | "event"> = {},
  ) => handleFeishuCardAction({ cfg: {}, event, runtime, ...options });
  const inbound = () => vi.mocked(handleFeishuMessage).mock.calls[0]?.[0].event;
  const message = () => inbound()?.message;
  const expectNotice = (text: unknown) =>
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ to: "chat:chat1", text });

  beforeEach(() => {
    vi.clearAllMocks();
    getChat.mockReset().mockResolvedValue({ code: 0, data: { chat_type: "group" } });
    createClient.mockReset().mockReturnValue({ im: { chat: { get: getChat } } });
    vi.mocked(handleFeishuMessage).mockReset().mockResolvedValue(undefined);
    processedCardActions.clear();
    resolvedCardActionChatTypes.clear();
  });

  it("handles card action with JSON object payload", async () => {
    await dispatch(cardEvent({ key: "val" }, { context: { chat_id: "" } }));
    expect(message()).toMatchObject({
      content: '{"text":"{\\"key\\":\\"val\\"}"}',
      chat_id: "u123",
    });
  });

  it("opens approval cards with resolved DM type and preserved interaction context", async () => {
    getChat.mockResolvedValueOnce({ code: 0, data: { chat_mode: "p2p" } });
    await dispatch(cardEvent(approvalAction()), { accountId: "main" });
    const containing = expect.objectContaining;
    const expected = { u: "u123", h: "chat1", t: "p2p", s: "session", e: expect.any(Number) };
    expect(sendCard.mock.calls[0]?.[0]).toMatchObject({
      to: "chat:chat1",
      accountId: "main",
      card: {
        header: { title: { content: "Confirm action" } },
        body: {
          elements: expect.arrayContaining([
            {
              tag: "action",
              actions: [containing({ value: containing({ c: expected }) }), expect.anything()],
            },
          ]),
        },
      },
    });
    expectFirstSentCardUsesFillWidthOnly(sendCard);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("does not open approval cards when the expiry would exceed a valid Date", async () => {
    vi.useFakeTimers({ now: maxDate });
    await dispatch(cardEvent(approvalAction(maxDate)), { accountId: "main" });
    expect(sendCard).not.toHaveBeenCalled();
    expectNotice(expect.stringContaining("payload is invalid"));
  });

  it("marks synthetic group card callbacks as mentioning the bot", async () => {
    await dispatch(
      cardEvent(quickAction({ a: CONFIRM, q: "/new" }), {
        open_message_id: "om_card_message",
      }),
      { botOpenId: "ou_bot" },
    );
    expect(message()).toMatchObject({
      chat_id: "chat1",
      chat_type: "group",
      reply_target_message_id: "om_card_message",
      typing_target_message_id: "om_card_message",
      content: '{"text":"/new"}',
    });
    expect(inbound()?.sender.sender_id).toEqual({
      open_id: "u123",
      user_id: "uid1",
      union_id: "un1",
    });
    expect(message()?.mentions).toEqual([
      { key: "mention_bot", id: { open_id: "ou_bot" }, name: "bot" },
    ]);
  });

  it.each([
    ["expired", () => ({ e: Date.now() - 1 })],
    ["different user", () => ({ u: "u999" })],
  ] as const)("safely rejects actions belonging to %s", async (reason, overrides) => {
    await dispatch(cardEvent(quickAction({ c: { ...context(), t: "group", ...overrides() } })));
    expectNotice(expect.stringContaining(reason));
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("sends a lightweight cancellation notice", async () => {
    await dispatch(cardEvent(quickAction({ k: "button", a: CANCEL, q: undefined })));
    expectNotice("Cancelled.");
  });

  it("preserves p2p callbacks for DM quick actions", async () => {
    const event = cardEvent(quickAction({ c: { ...context(), h: "p2p-chat-1", t: "p2p" } }), {
      context: { chat_id: "p2p-chat-1" },
    });
    await dispatch(event, { botOpenId: "ou_bot" });
    expect(message()).toMatchObject({ chat_id: "p2p-chat-1", chat_type: "p2p" });
    expect(message()?.mentions).toBeUndefined();
  });

  it("does not cache chat types or callback tokens when expiry would exceed a valid Date", async () => {
    vi.useFakeTimers({ now: maxDate });
    getChat.mockResolvedValue({ code: 0, data: { chat_type: "p2p" } });
    const event = cardEvent({ text: "/help" }, { context: { chat_id: "oc_dm_chat_boundary" } });
    await dispatch(event);
    await dispatch(event);
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
    expect(message()).toMatchObject({ chat_id: "oc_dm_chat_boundary", chat_type: "p2p" });
  });

  it("keeps Feishu chat lookup error logs UTF-16 safe at the truncation boundary", async () => {
    getChat.mockResolvedValueOnce({ code: 99, msg: `${"x".repeat(499)}😀tail` });
    await dispatch(cardEvent({ text: "/help" }));
    expect(message()?.chat_type).toBe("p2p");
    expect(log).toHaveBeenCalledWith(
      `feishu[mock-account]: failed to resolve chat type: ${"x".repeat(499)}; defaulting to p2p`,
    );
  });

  it("falls back to p2p when Feishu chat API throws", async () => {
    getChat.mockRejectedValueOnce(new Error("network failure"));
    await dispatch(cardEvent({ text: "/help" }));
    expect(message()?.chat_type).toBe("p2p");
  });

  it("does not log raw duplicate callback tokens", async () => {
    const event = cardEvent();
    await dispatch(event);
    await dispatch(event);
    const logs = log.mock.calls.flat().join("\n");
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(logs).toContain("skipping duplicate card action token");
    expect(logs).not.toContain(event.token);
  });

  it("rejects empty callback tokens before dispatch", async () => {
    await dispatch(cardEvent(quickAction(), { token: "   " }));
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: rejected card action from u123: missing token",
    );
  });

  it("keeps a claimed token completed after a non-retryable dispatch failure", async () => {
    vi.mocked(handleFeishuMessage).mockRejectedValueOnce(new Error("transient"));
    const event = cardEvent();
    await expect(dispatch(event)).rejects.toThrow("transient");
    await dispatch(event);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight token claimed while a slow dispatch is still running", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<void>();
    vi.mocked(handleFeishuMessage).mockReturnValue(pending.promise);
    const event = cardEvent();
    const first = dispatch(event);
    await vi.advanceTimersByTimeAsync(61_000);
    await dispatch(event);
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
  });
});
