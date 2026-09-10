import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundPipeline,
  registerTelegramInboundHandlers,
} from "./bot-handlers.inbound-pipeline.js";
import {
  createTelegramMessagePipeline,
  type TelegramMessagePipeline,
} from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  runWithTelegramSpooledReplayUpdate,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { sequentialize } from "./bot.runtime.js";
import { recordTelegramConversationMessages } from "./conversation-observation.js";
import { getTelegramSequentialConstraints } from "./sequential-key.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createOrderingFixture(debounceMs: number) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-observation-order-"));
  directories.push(directory);
  const storePath = path.join(directory, "sessions.json");
  const cfg: OpenClawConfig = {
    session: { store: storePath },
    channels: { telegram: { groupPolicy: "open", dmPolicy: "open", allowFrom: ["*"] } },
    messages: { inbound: { debounceMs } },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const botInfo = { ...telegramBotInfoForTest, username: "qa_bot" };
  const bot = new Bot("123456:integration-token", { botInfo });
  bot.use(sequentialize(getTelegramSequentialConstraints));
  const processed = vi.fn<TelegramMessagePipeline["processMessageWithReplyChain"]>(async () => ({
    kind: "completed",
  }));
  const params: RegisterTelegramHandlerParams = {
    accountId: "default",
    ownerAgentId: "main",
    bot,
    cfg,
    telegramCfg: cfg.channels!.telegram!,
    mediaMaxBytes: 1024,
    opts: { token: "123456:integration-token", botInfo },
    runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      resolveStorePath: () => storePath,
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    resolveGroupPolicy: () => ({ allowed: true, allowlistEnabled: false }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => true,
    resolveTelegramGroupConfig: () => ({ groupConfig: { groupPolicy: "open" } }),
    shouldSkipUpdate: () => false,
    processMessage: async () => ({ kind: "completed" }),
  };
  const message: TelegramMessagePipeline = {
    ...createTelegramMessagePipeline(params),
    claimMessageDispatchDedupe: async () => ({ process: true, claims: [] }),
    recordMessageForReplyChain: async () => undefined,
    resolveTelegramSessionState: () => ({
      agentId: "main",
      sessionKey: "agent:main:telegram:group:-100123",
      storePath,
      sessionEntry: undefined,
      model: undefined,
    }),
    processMessageWithReplyChain: processed,
  };
  registerTelegramInboundHandlers({
    bot,
    pipeline: createTelegramInboundPipeline({
      params,
      message,
      authorization: createTelegramHandlerAuthorization(params),
    }),
  });
  return { bot, processed, storePath };
}

it("records a forwarded message before another sender's immediate request crosses the buffer", async () => {
  const { bot, processed, storePath } = await createOrderingFixture(0);
  const chat = { id: -100123, type: "group" as const, title: "QA" };
  const forwarded: Message = {
    chat,
    message_id: 1,
    date: 1700000000,
    from: { id: 111, first_name: "Alice", is_bot: false },
    forward_origin: {
      type: "user",
      date: 1700000000,
      sender_user: { id: 333, first_name: "Original sender", is_bot: false },
    },
    text: "Earlier forwarded fact",
  };
  vi.useFakeTimers();
  await bot.handleUpdate({ update_id: 1, message: forwarded });
  expect(processed).not.toHaveBeenCalled();
  await bot.handleUpdate({
    update_id: 2,
    message: {
      chat,
      message_id: 2,
      date: 1700000001,
      from: { id: 222, first_name: "Bob", is_bot: false },
      text: "@qa_bot summarize",
      entities: [{ type: "mention", offset: 0, length: 7 }],
    },
  });
  expect(processed).toHaveBeenCalledTimes(1);
  const requestCapture = processed.mock.calls[0]?.[0].options?.conversationHistory;
  expect(requestCapture).toMatchObject({ throughSequence: 2, requestSourceIds: ["2"] });
  const earlier = await recordTelegramConversationMessages({
    agentId: "main",
    storePath,
    accountId: "default",
    chatId: chat.id,
    threadSpec: { scope: "none" },
    messages: [forwarded],
    updateIds: [1],
  });
  expect(earlier.throughSequence).toBe(1);
  expect(earlier.conversationRef).toBe(requestCapture?.conversationRef);
  await vi.advanceTimersByTimeAsync(80);
  expect(processed).toHaveBeenCalledTimes(2);
  expect(processed.mock.calls[1]?.[0].options?.conversationHistory).toMatchObject({
    throughSequence: 1,
    requestSourceIds: ["1"],
  });
});

it("keeps a same-sender plain text tail unread after an addressed debounce request", async () => {
  const { bot, processed, storePath } = await createOrderingFixture(50);
  const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  const target = {
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-100123",
    sessionId: "debounce-session",
    storePath,
  };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  const chat = { id: -100123, type: "group" as const, title: "QA" };
  const sender = { id: 111, first_name: "Alice", is_bot: false };
  const messages: Message[] = [
    { chat, from: sender, date: 1700000000, message_id: 1, text: "Earlier context fact" },
    {
      chat,
      from: sender,
      date: 1700000001,
      message_id: 2,
      text: "@qa_bot current request",
      entities: [{ type: "mention", offset: 0, length: 7 }],
    },
    { chat, from: sender, date: 1700000002, message_id: 3, text: "Later ordinary tail" },
  ];
  const participants: TelegramSpooledReplayDeferredParticipant[] = [];
  vi.useFakeTimers();
  for (const message of messages) {
    const update = { update_id: message.message_id, message };
    const result = await runWithTelegramSpooledReplayUpdate(update, () => bot.handleUpdate(update));
    if (!result.deferredWork) {
      throw new Error("Expected each source update to retain its buffered participant");
    }
    participants.push(result.deferredWork);
  }
  expect(processed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);
  expect(processed).toHaveBeenCalledTimes(1);
  const first = processed.mock.calls[0]![0];
  expect(first.msg.text).toBe("@qa_bot current request");
  expect(first.options?.conversationHistory).toMatchObject({
    throughSequence: 2,
    requestSourceIds: ["2"],
  });
  expect(await Promise.all(participants.map((participant) => participant.task))).toEqual([
    { kind: "completed" },
    { kind: "completed" },
    { kind: "completed" },
  ]);
  const firstRecorder = createRecorder({
    input: { text: first.msg.text, idempotencyKey: "request-2" },
    target: { ...target, sessionEntry: undefined },
    conversationHistory: first.options?.conversationHistory,
  });
  expect(await firstRecorder.stageApproved!({ runId: "request-2", assertCurrent: () => {} })).toBe(
    true,
  );
  const firstInput = JSON.stringify(firstRecorder.getPendingInputMessage?.()?.content);
  expect(firstInput).toContain("Earlier context fact");
  expect(firstInput).not.toContain("Later ordinary tail");
  await firstRecorder.persistApproved();
  expect(firstRecorder.hasPersisted()).toBe(true);

  await bot.handleUpdate({
    update_id: 4,
    message: {
      chat,
      from: sender,
      date: 1700000003,
      message_id: 4,
      text: "@qa_bot next request",
      entities: [{ type: "mention", offset: 0, length: 7 }],
    },
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(processed).toHaveBeenCalledTimes(2);
  const next = processed.mock.calls[1]![0];
  const nextRecorder = createRecorder({
    input: { text: next.msg.text, idempotencyKey: "request-4" },
    target: { ...target, sessionEntry: undefined },
    conversationHistory: next.options?.conversationHistory,
  });
  try {
    expect(await nextRecorder.stageApproved!({ runId: "request-4", assertCurrent: () => {} })).toBe(
      true,
    );
    const nextInput = JSON.stringify(nextRecorder.getPendingInputMessage?.()?.content);
    expect(nextInput).toContain("Later ordinary tail");
    expect(nextInput).not.toContain("Earlier context fact");
  } finally {
    nextRecorder.finishPendingInput?.("cancelled");
  }
});
