// Discord tests cover outbound adapter plugin behavior.
import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordComponentMessage } from "./components.builders.js";
import type { DiscordComponentMessageSpec } from "./components.types.js";
import {
  createDiscordOutboundHoisted,
  expectDiscordThreadBotSend,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { createDiscordSendReceipt } from "./send.receipt.js";

const outboundWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "discord/outbound" ? { ...logger, warn: outboundWarnSpy } : logger;
    },
  };
});

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;
let discordInboundEventDelivery: typeof import("./inbound-event-delivery.js").discordInboundEventDelivery;

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCall(source: MockCallSource, callIndex = 0): Array<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected Discord send call ${callIndex}`);
  }
  return call;
}

function mockObjectArg(
  source: MockCallSource,
  callIndex = 0,
  argIndex = 2,
): Record<string, unknown> {
  const value = mockCall(source, callIndex)[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected Discord send call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectMessage(text: string, index = 0) {
  expect(mockCall(hoisted.sendMessageDiscordMock, index).slice(0, 2)).toEqual([
    "channel:123456",
    text,
  ]);
  const options = mockObjectArg(hoisted.sendMessageDiscordMock, index);
  expect(options.accountId).toBe("default");
  return options;
}

function sendContext() {
  return { cfg: {}, to: "channel:123456", text: "", accountId: "default" };
}

function trustedMedia(workspaceDir = "/tmp/agent-workspace", content = "trusted media") {
  const mediaReadFile = vi.fn(async () => Buffer.from(content));
  const mediaAccess = { localRoots: [workspaceDir], readFile: mediaReadFile, workspaceDir };
  return { mediaAccess, mediaLocalRoots: mediaAccess.localRoots, mediaReadFile };
}

function expectMediaAuthority(
  options: Record<string, unknown>,
  media: ReturnType<typeof trustedMedia>,
) {
  expect(options.mediaAccess).toBe(media.mediaAccess);
  expect(options.mediaLocalRoots).toBe(media.mediaLocalRoots);
  expect(options.mediaReadFile).toBe(media.mediaReadFile);
}

beforeAll(async () => {
  ({ discordOutbound } = await import("./outbound-adapter.js"));
  ({ discordInboundEventDelivery } = await import("./inbound-event-delivery.js"));
});

describe("discordOutbound", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
    outboundWarnSpy.mockClear();
  });

  it("uses allowFrom to disambiguate bare numeric DM delivery targets", () => {
    expect(
      discordOutbound.resolveTarget?.({
        to: "1470130713209602050",
        allowFrom: ["1470130713209602050"],
      }),
    ).toEqual({
      ok: true,
      to: "user:1470130713209602050",
    });
  });

  it("uses webhook persona delivery for bound thread text replies", async () => {
    mockDiscordBoundThreadManager(hoisted);
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };

    const result = await discordOutbound.sendText?.({
      cfg,
      to: "channel:parent-1",
      text: "hello from persona",
      accountId: "default",
      threadId: "thread-1",
      replyToId: "reply-1",
      identity: {
        name: "Codex",
        avatarUrl: "https://example.com/avatar.png",
      },
    });

    const call = mockCall(hoisted.sendWebhookMessageDiscordMock);
    expect(call[0]).toBe("hello from persona");
    const options = mockObjectArg(hoisted.sendWebhookMessageDiscordMock, 0, 1);
    expect(options.webhookId).toBe("wh-1");
    expect(options.webhookToken).toBe("tok-1");
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("thread-1");
    expect(options.replyTo).toEqual({ messageId: "reply-1", scope: "all" });
    expect(options.username).toBe("Codex");
    expect(options.avatarUrl).toBe("https://example.com/avatar.png");
    expect(options.cfg).toBe(cfg);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-webhook-1",
      target: { kind: "channel", id: "thread-1" },
    });
  });

  it("falls back to bot send when Discord rejects the webhook send", async () => {
    mockDiscordBoundThreadManager(hoisted);
    hoisted.sendWebhookMessageDiscordMock.mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "fallback",
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expectDiscordThreadBotSend({
      hoisted,
      text: "fallback",
      result,
    });
    // The fallback is intended, but the persona failure must stay visible.
    expect(outboundWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("webhook persona send failed"),
      { error: expect.objectContaining({ message: "rate limited" }) },
    );
  });

  it("routes poll sends to thread target when threadId is provided", async () => {
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    const markInboundEventDelivered = vi.fn();
    const end = discordInboundEventDelivery.begin(
      "agent:main:discord:channel:parent-1",
      {
        outboundTo: "thread-1",
        outboundAccountId: "default",
        markInboundEventDelivered,
      },
      { inboundEventKind: "room_event" },
    );
    hoisted.sendPollDiscordMock.mockResolvedValueOnce({
      messageId: "poll-1",
      channelId: "thread-1",
      receipt: createDiscordSendReceipt({
        platformMessageIds: ["poll-1"],
        channelId: "thread-1",
        kind: "poll",
        threadId: "thread-1",
      }),
    });
    let result;
    try {
      result = await discordOutbound.sendPoll?.({
        cfg: {},
        to: "channel:parent-1",
        poll: { question: "Best snack?", options: ["banana", "apple"] },
        content: "Vote now",
        accountId: "default",
        threadId: "thread-1",
        silent: true,
        sessionKey: "agent:main:discord:channel:parent-1",
        inboundEventKind: "room_event",
        onPlatformSendDispatch,
      });
    } finally {
      end();
    }

    const call = mockCall(hoisted.sendPollDiscordMock);
    expect(call[0]).toBe("channel:thread-1");
    expect(call[1]).toEqual({
      question: "Best snack?",
      options: ["banana", "apple"],
    });
    expect(mockObjectArg(hoisted.sendPollDiscordMock)).toMatchObject({
      accountId: "default",
      content: "Vote now",
      threadId: "thread-1",
      silent: true,
      onPlatformSendDispatch,
    });
    expect(result).toEqual({
      channel: "discord",
      messageId: "poll-1",
      channelId: "thread-1",
      receipt: expect.objectContaining({
        primaryPlatformMessageId: "poll-1",
        threadId: "thread-1",
      }),
    });
    expect(markInboundEventDelivered).toHaveBeenCalledOnce();
  });

  it("enforces account poll policy before provider dispatch", async () => {
    await expect(
      discordOutbound.sendPoll?.({
        cfg: {
          channels: {
            discord: {
              actions: { polls: true },
              accounts: { work: { actions: { polls: false } } },
            },
          },
        },
        to: "channel:parent-1",
        poll: { question: "Best snack?", options: ["banana", "apple"] },
        accountId: "work",
      }),
    ).rejects.toThrow("Discord polls are disabled");
    expect(hoisted.sendPollDiscordMock).not.toHaveBeenCalled();
  });

  it("routes audioAsVoice payloads through the Discord voice send helper", async () => {
    const onDeliveryResult = vi.fn();
    const media = trustedMedia("/tmp/agent-workspace", "trusted media");
    hoisted.sendMessageDiscordMock.mockImplementation(
      async (_to: unknown, _text: unknown, options: unknown) => {
        const deliveryResult = { messageId: "msg-1", channelId: "ch-1" };
        const onProgress = (options as { onDeliveryResult?: (result: unknown) => Promise<void> })
          .onDeliveryResult;
        await onProgress?.(deliveryResult);
        return deliveryResult;
      },
    );
    const result = await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload: {
        text: "voice note",
        mediaUrls: ["./voice.ogg", "./extra.png"],
        audioAsVoice: true,
      },
      ...media,
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
      onDeliveryResult,
    });

    const voiceCall = mockCall(hoisted.sendVoiceMessageDiscordMock);
    expect(voiceCall[0]).toBe("channel:123456");
    expect(voiceCall[1]).toBe("./voice.ogg");
    const voiceOptions = mockObjectArg(hoisted.sendVoiceMessageDiscordMock);
    expect(voiceOptions.accountId).toBe("default");
    expect(voiceOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });
    expectMediaAuthority(voiceOptions, media);

    const messageOptions = expectMessage("voice note");
    expect(messageOptions.reply).toBeUndefined();
    expect(messageOptions).not.toHaveProperty("mediaAccess");

    const mediaOptions = expectMessage("", 1);
    expect(mediaOptions.mediaUrl).toBe("./extra.png");
    expectMediaAuthority(mediaOptions, media);
    expect(mediaOptions.reply).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      target: { kind: "channel", id: "ch-1" },
    });
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "voice-1",
      "msg-1",
      "msg-1",
    ]);
  });

  it("preserves reader-free workspace authority on direct voice media sends", async () => {
    const mediaAccess = {
      localRoots: ["/tmp/agent-workspace"],
      workspaceDir: "/tmp/agent-workspace",
    };

    await discordOutbound.sendMedia?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      mediaUrl: "./voice.ogg",
      audioAsVoice: true,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
    });

    const voiceCall = mockCall(hoisted.sendVoiceMessageDiscordMock);
    expect(voiceCall[1]).toBe("./voice.ogg");
    const voiceOptions = mockObjectArg(hoisted.sendVoiceMessageDiscordMock);
    expect(voiceOptions.mediaAccess).toBe(mediaAccess);
    expect(voiceOptions.mediaLocalRoots).toBe(mediaAccess.localRoots);
    expect(voiceOptions.mediaReadFile).toBeUndefined();
    expect(voiceOptions.mediaAccess).not.toHaveProperty("readFile");
  });

  it("delivers fallback TTS supplement text before reporting a voice failure", async () => {
    const voiceError = new Error("ffmpeg unavailable");
    hoisted.sendVoiceMessageDiscordMock.mockRejectedValueOnce(voiceError);

    await expect(
      discordOutbound.sendPayload?.({
        ...sendContext(),
        payload: {
          mediaUrls: ["https://example.com/voice.ogg"],
          audioAsVoice: true,
          ttsSupplement: { spokenText: "spoken answer" },
        },
        replyToId: "reply-1",
        replyToMode: "first",
      }),
    ).rejects.toBe(voiceError);

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledOnce();
    const messageCall = mockCall(hoisted.sendMessageDiscordMock, 0);
    expect(messageCall[0]).toBe("channel:123456");
    expect(messageCall[1]).toBe("spoken answer");
    expect(mockObjectArg(hoisted.sendMessageDiscordMock).reply).toEqual({
      messageId: "reply-1",
      scope: "first",
    });
    expect(outboundWarnSpy).toHaveBeenCalledWith(
      "discord voice send failed; continuing without voice",
      { error: voiceError },
    );
  });

  it("does not treat delivery progress failures as voice delivery failures", async () => {
    await expect(
      discordOutbound.sendPayload?.({
        ...sendContext(),
        payload: {
          text: "voice note",
          mediaUrls: ["https://example.com/voice.ogg"],
          audioAsVoice: true,
        },
        onDeliveryResult: async () => {
          throw new Error("progress unavailable");
        },
      }),
    ).rejects.toThrow("progress unavailable");

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("sends implicit all-mode video captions before media with replies", async () => {
    await discordOutbound.sendMedia?.({
      ...sendContext(),
      text: "rendered clip",
      mediaUrl: "/tmp/render.mp4",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "all",
    });

    const captionOptions = expectMessage("rendered clip");
    expect(captionOptions.reply).toEqual({ messageId: "reply-1", scope: "all" });

    const mediaOptions = expectMessage("", 1);
    expect(mediaOptions.mediaUrl).toBe("/tmp/render.mp4");
    expect(mediaOptions.reply).toEqual({ messageId: "reply-1", scope: "all" });
  });

  it("keeps captioned video in the thread created by the forum starter", async () => {
    const media = trustedMedia("/tmp/agent-workspace", "trusted video");
    hoisted.sendMessageDiscordMock
      .mockResolvedValueOnce({
        messageId: "starter-1",
        channelId: "thread-1",
        receipt: {
          threadId: "thread-1",
          platformMessageIds: ["starter-1"],
          parts: [{ platformMessageId: "starter-1", kind: "text", index: 0 }],
          sentAt: 1,
        },
      })
      .mockResolvedValueOnce({
        messageId: "video-1",
        channelId: "thread-1",
        receipt: {
          platformMessageIds: ["video-1"],
          parts: [{ platformMessageId: "video-1", kind: "media", index: 0 }],
          sentAt: 2,
        },
      });

    const result = await discordOutbound.sendMedia?.({
      cfg: {},
      to: "channel:forum-1",
      text: "rendered clip",
      mediaUrl: "./render.mp4",
      accountId: "default",
      ...media,
    });

    expect(mockCall(hoisted.sendMessageDiscordMock, 0)[0]).toBe("channel:forum-1");
    expect(mockCall(hoisted.sendMessageDiscordMock, 1)[0]).toBe("channel:thread-1");
    expect(mockObjectArg(hoisted.sendMessageDiscordMock)).not.toHaveProperty("mediaAccess");
    const videoOptions = mockObjectArg(hoisted.sendMessageDiscordMock, 1, 2);
    expectMediaAuthority(videoOptions, media);
    expect(result).toMatchObject({
      channel: "discord",
      messageId: "starter-1",
      target: { kind: "channel", id: "thread-1" },
      receipt: {
        primaryPlatformMessageId: "starter-1",
        threadId: "thread-1",
        platformMessageIds: ["starter-1", "video-1"],
        parts: [
          { platformMessageId: "starter-1", kind: "text", index: 0, threadId: "thread-1" },
          { platformMessageId: "video-1", kind: "media", index: 1, threadId: "thread-1" },
        ],
      },
    });
  });

  it("touches bound thread activity after shared outbound delivery succeeds", async () => {
    const touchThread = vi.fn();
    hoisted.getThreadBindingManagerMock.mockReturnValue({
      getByThreadId: () => ({ threadId: "thread-1" }),
      touchThread,
    });

    await discordOutbound.afterDeliverPayload?.({
      cfg: {},
      target: {
        channel: "discord",
        to: "channel:parent-1",
        accountId: "default",
        threadId: "thread-1",
      },
      payload: { text: "delivered" },
      results: [{ channel: "discord", messageId: "msg-1" }],
    });

    expect(touchThread).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("notifies inbound event delivery after shared outbound delivery succeeds", async () => {
    const markDelivered = vi.fn();
    const end = discordInboundEventDelivery.begin(
      "agent:main:discord:channel:c1",
      {
        outboundTo: "thread-1",
        outboundAccountId: "default",
        markInboundEventDelivered: markDelivered,
      },
      { inboundEventKind: "room_event" },
    );

    try {
      await discordOutbound.afterDeliverPayload?.({
        cfg: {},
        target: {
          channel: "discord",
          to: "channel:parent-1",
          accountId: "default",
          threadId: "thread-1",
        },
        payload: {
          text: "delivered",
          channelData: {
            discord: {
              __openclawInboundEventDelivery: {
                sessionKey: "agent:main:discord:channel:c1",
                inboundEventKind: "room_event",
              },
            },
          },
        },
        results: [{ channel: "discord", messageId: "msg-1" }],
      });
    } finally {
      end();
    }

    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  it("sends component payload media sequences with the component message first", async () => {
    const media = trustedMedia("/tmp/media", "trusted component media");
    hoisted.sendDiscordComponentMessageMock.mockResolvedValueOnce({
      messageId: "component-1",
      channelId: "ch-1",
    });
    hoisted.sendMessageDiscordMock.mockResolvedValueOnce({
      messageId: "msg-2",
      channelId: "ch-1",
    });

    const payload = await discordOutbound.renderPresentation?.({
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
      },
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    const result = await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload,
      ...media,
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    const componentCall = mockCall(hoisted.sendDiscordComponentMessageMock);
    expect(componentCall[0]).toBe("channel:123456");
    expect(mockObjectArg(hoisted.sendDiscordComponentMessageMock, 0, 1).text).toBe("hello");
    const componentOptions = mockObjectArg(hoisted.sendDiscordComponentMessageMock);
    expect(componentOptions.mediaUrl).toBe("https://example.com/1.png");
    expectMediaAuthority(componentOptions, media);
    expect(componentOptions.accountId).toBe("default");
    expect(componentOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });

    const messageCall = mockCall(hoisted.sendMessageDiscordMock);
    expect(messageCall[0]).toBe("channel:123456");
    expect(messageCall[1]).toBe("");
    const messageOptions = mockObjectArg(hoisted.sendMessageDiscordMock);
    expect(messageOptions.mediaUrl).toBe("https://example.com/2.png");
    expectMediaAuthority(messageOptions, media);
    expect(messageOptions.accountId).toBe("default");
    expect(messageOptions.reply).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-2",
      target: { kind: "channel", id: "ch-1" },
    });
  });

  it("delivers complete authored title through native presentation components", async () => {
    const text = `${"x".repeat(1996)} \n  TAIL_NOT_DELIVERED`;
    const presentation = adaptMessagePresentationForChannel({
      capabilities: discordOutbound.presentationCapabilities,
      presentation: { title: text, blocks: [] },
    });
    const payload = await discordOutbound.renderPresentation?.({
      payload: { presentation },
      presentation,
      ctx: { cfg: {}, to: "channel:123456", text: "", payload: { presentation } },
    });
    if (!payload) {
      throw new Error("expected native Discord presentation");
    }
    await discordOutbound.sendPayload?.({ cfg: {}, to: "channel:123456", text: "", payload });
    const spec = mockObjectArg(
      hoisted.sendDiscordComponentMessageMock,
      0,
      1,
    ) as DiscordComponentMessageSpec;
    const components = buildDiscordComponentMessage({ spec }).components;
    const wire = JSON.stringify(components.map((component) => component.serialize()));
    expect(wire).toContain("TAIL_NOT_DELIVERED");
    expect(
      (spec.blocks ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text.replace(/^-# /u, "")] : []))
        .join(""),
    ).toBe(text);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("preserves disabled presentation buttons through channel adaptation", async () => {
    const adaptedPresentation = adaptMessagePresentationForChannel({
      capabilities: discordOutbound.presentationCapabilities,
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Already handled", value: "done", disabled: true },
              { label: "Open docs", url: "https://example.com/docs", disabled: true },
            ],
          },
        ],
      },
    });

    const payload = await discordOutbound.renderPresentation?.({
      payload: { text: "Action state" },
      presentation: adaptedPresentation,
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    const discordData = payload.channelData?.discord as
      | { presentationComponents?: { blocks?: Array<{ type?: string; buttons?: unknown[] }> } }
      | undefined;
    const buttons = discordData?.presentationComponents?.blocks?.find(
      (block) => block.type === "actions",
    )?.buttons;

    expect(buttons?.[0]).toEqual({
      label: "Already handled",
      style: "secondary",
      callbackData: "done",
      disabled: true,
    });
    expect(buttons?.[1]).toEqual({
      label: "Open docs",
      style: "link",
      url: "https://example.com/docs",
      disabled: true,
    });
  });

  it("encodes question buttons from Gateway option order", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const payload = await discordOutbound.renderPresentation?.({
      payload: {
        channelData: { askUser: { questionId, optionValues: ["Staging", "Production"] } },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Production",
                action: { type: "question", questionId, optionValue: "Production" },
              },
              {
                label: "Other…",
                action: { type: "question", questionId, intent: "custom-input" },
              },
              {
                label: "Staging",
                action: { type: "question", questionId, optionValue: "Staging" },
              },
            ],
          },
        ],
      },
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);

    const discordData = payload?.channelData?.discord as
      | { presentationComponents?: { blocks?: Array<{ buttons?: unknown[] }> } }
      | undefined;
    expect(discordData?.presentationComponents?.blocks?.[0]?.buttons).toMatchObject([
      { internalCustomId: `ocq:id=${questionId};i=1` },
      { internalCustomId: `ocq:id=${questionId};i=0` },
    ]);
  });

  it("falls back to chunked text when a table exceeds the Discord component envelope", async () => {
    const table = {
      type: "table" as const,
      caption: "Large pipeline",
      headers: ["Account", "Stage"],
      rows: Array.from({ length: 900 }, (_entry, index) => [
        `account-${String(index)}-${"x".repeat(80)}`,
        "Review",
      ]),
    };
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          table,
          {
            type: "buttons",
            buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
          },
        ],
      },
      capabilities: discordOutbound.presentationCapabilities,
    });

    const rendered = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation,
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);
    const fallbackText = renderMessagePresentationFallbackText({ presentation });
    await discordOutbound.sendPayload?.({
      ...sendContext(),
      text: fallbackText,
      payload: { text: fallbackText },
    });
    const textChunks = hoisted.sendMessageDiscordMock.mock.calls.map((call) => String(call[1]));
    const deliveredText = textChunks.join("\n");

    expect(presentation.blocks.length).toBeGreaterThan(40);
    expect(rendered).toBeNull();
    expect(hoisted.sendDiscordComponentMessageMock).not.toHaveBeenCalled();
    expect(textChunks.length).toBeGreaterThan(1);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-899-");
    expect(deliveredText).toContain("Continue: `/continue`");
  });

  it("sends prepared native Discord payload data through outbound delivery", async () => {
    await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload: {
        text: "hello",
        mediaUrl: "https://example.com/photo.png",
        channelData: {
          discord: {
            components: [{ type: 1, components: [] }],
            filename: "photo.png",
          },
        },
      },
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    const call = mockCall(hoisted.sendMessageDiscordMock);
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("hello");
    const options = mockObjectArg(hoisted.sendMessageDiscordMock);
    expect(options.mediaUrl).toBe("https://example.com/photo.png");
    expect(options.components).toEqual([{ type: 1, components: [] }]);
    expect(options.filename).toBe("photo.png");
    expect(options.accountId).toBe("default");
    expect(options.reply).toEqual({ messageId: "reply-1", scope: "first" });
  });

  it("renders channelData Discord components on payload sends", async () => {
    await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload: {
        text: "native component text",
        channelData: {
          discord: {
            components: {
              blocks: [{ type: "text", text: "Native component body" }],
            },
          },
        },
      },
    });

    const call = mockCall(hoisted.sendDiscordComponentMessageMock);
    expect(call[0]).toBe("channel:123456");
    const payload = mockObjectArg(hoisted.sendDiscordComponentMessageMock, 0, 1);
    expect(payload.text).toBe("native component text");
    expect(payload.blocks).toEqual([{ type: "text", text: "Native component body" }]);
    expect(mockObjectArg(hoisted.sendDiscordComponentMessageMock).accountId).toBe("default");
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("neutralizes approval mentions only for approval payloads", async () => {
    await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload: {
        text: "Approval @everyone <@123> <#456>",
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
          },
        },
      },
    });

    const call = mockCall(hoisted.sendMessageDiscordMock);
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("Approval @\u200beveryone <@\u200b123> <#\u200b456>");
    expect(mockObjectArg(hoisted.sendMessageDiscordMock).accountId).toBe("default");
  });

  it("uses a single implicit reply for chunked approval payload fallbacks", async () => {
    await discordOutbound.sendPayload?.({
      ...sendContext(),
      payload: {
        text: "line one\nline two",
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
          },
        },
      },
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
      formatting: { maxLinesPerMessage: 1 },
    });

    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { reply?: unknown } | undefined)?.reply,
      ),
    ).toEqual([{ messageId: "reply-1", scope: "first" }, undefined]);
  });
});
