import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildPluginBindingApprovalCustomId } from "openclaw/plugin-sdk/conversation-runtime";
import { expectDefined as requireValue } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfiguredAcpTopicBinding,
  createConfiguredBindingRoute,
} from "./bot-native-command-dispatch.test-support.js";
import { recordTelegramUpdateReceivedAt } from "./bot-processing-outcome.js";
import {
  makeCallbackRetryContext,
  makePrivateTextContext,
  telegramBotInfoForTest,
} from "./bot.create-telegram-bot.test-support.js";
import {
  createTelegramCallbackContext,
  makeTelegramKeyedStoreTestMock,
  runTelegramTestMiddlewareChain,
  type TelegramTestContext,
} from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", { spy: true });
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", { spy: true });

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const pluginStateTestRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
const bindingRuntime = await import("openclaw/plugin-sdk/conversation-binding-runtime");
const telegramMediaResolver = await import("./bot/delivery.resolve-media.js");
let testStateDir: string;
const spyRestorers: Array<() => void> = [];
const replayWork: Promise<unknown>[] = [];
const testCleanups: Array<() => Promise<void> | void> = [];
const onCleanup = (cleanup: () => Promise<void> | void) => testCleanups.push(cleanup);
function autoRestore<T extends { mockRestore(): void }>(spy: T): T {
  spyRestorers.push(() => spy.mockRestore());
  return spy;
}
let previousStateDir: string | undefined;
const {
  answerCallbackQuerySpy,
  commandSpy,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  getLoadConfigMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  middlewareUseSpy,
  onSpy,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
  throttlerSpy,
} = harness;
type BuildModelsProviderDataMock = ReturnType<
  typeof vi.fn<NonNullable<typeof telegramBotDepsForTest.buildModelsProviderData>>
>;
const providerAuth = await import("openclaw/plugin-sdk/provider-auth-login-flow-runtime");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const {
  recordTelegramMessageProcessingResult,
  runWithTelegramSpooledReplayUpdate,
  TelegramSpooledReplayProcessingError,
} = await import("./bot-processing-outcome.js");
const {
  clearTelegramRuntimeForTest,
  resetTelegramAccountThrottlersForTest,
  resetTelegramTopicNameCacheForTest,
} = await import("./runtime.test-support.js");
const { setTelegramRuntime } = await import("./runtime.js");
function createTelegramBot(opts: TelegramBotOptions) {
  return createTelegramBotBase({ botInfo: telegramBotInfoForTest, ...opts });
}

const loadConfig = getLoadConfigMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

const ORIGINAL_TZ = process.env.TZ;
const TELEGRAM_TEST_TIMINGS = { mediaGroupFlushMs: 20, textFragmentGapMs: 30 } as const;
const INBOUND_DEBOUNCE_MS = 4321;
let forumCacheChatId = -1_008_000_000_000;

type TelegramMessageHandler = (ctx: TelegramTestContext) => Promise<void>;
type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;
const OPEN_DM: TelegramConfig = { dmPolicy: "open", allowFrom: ["*"] };

function configureTelegram(
  telegram: TelegramConfig,
  config: Omit<OpenClawConfig, "channels"> = {},
) {
  loadConfig.mockReturnValue({ ...config, channels: { telegram } });
}

function configureInbound(
  config: Omit<OpenClawConfig, "channels"> = {},
  telegram: TelegramConfig = OPEN_DM,
) {
  configureTelegram(telegram, { messages: { inbound: { debounceMs: 0 } }, ...config });
}

function configureOpenDm(
  params: {
    debounceMs?: number;
    userTimezone?: string;
  } = {},
): void {
  configureTelegram(
    { dmPolicy: "open", allowFrom: ["*"] },
    {
      agents: params.userTimezone ? { defaults: { userTimezone: params.userTimezone } } : undefined,
      messages: { inbound: { debounceMs: params.debounceMs ?? 0 } },
    },
  );
}

function configureNativeGroupStop(allowFrom: string[] = ["42"]): void {
  configureTelegram(
    { groupPolicy: "open", groups: { "*": { requireMention: false } } },
    {
      commands: { native: true, allowFrom: { telegram: allowFrom } },
      messages: { inbound: { byChannel: { telegram: 3000 } } },
    },
  );
}

function getTelegramHandler(name: "message" | "callback_query"): TelegramMessageHandler {
  return requireValue(getOnHandler(name) as TelegramMessageHandler | undefined, `${name} handler`);
}

const getMessageHandler = () => getTelegramHandler("message");
const getCallbackHandler = () => getTelegramHandler("callback_query");

function makeCallback(
  id: string,
  data: string,
  options: Omit<Parameters<typeof makeCallbackRetryContext>[0], "id" | "data" | "messageId"> & {
    messageId?: number;
  } = {},
) {
  return makeCallbackRetryContext({ id, data, messageId: 10, ...options });
}

async function tap(id: string, data: string, options: Parameters<typeof makeCallback>[2] = {}) {
  await getCallbackHandler()(makeCallback(id, data, options));
}

function button(text: string, data: string) {
  return { reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] } };
}

function registerInteractive(
  pluginId: string,
  namespace: string,
  handler: Parameters<typeof registerPluginInteractiveHandler>[1]["handler"],
) {
  return registerPluginInteractiveHandler(pluginId, { channel: "telegram", namespace, handler });
}

const runCallback = (ctx: TelegramTestContext) =>
  runTelegramMiddlewareChain(ctx, getCallbackHandler());

function receivedCallback(ctx: TelegramTestContext, updateId: number, receivedAt: number) {
  const update = { update_id: updateId, callback_query: ctx.callbackQuery };
  recordTelegramUpdateReceivedAt(update, receivedAt);
  return { ...ctx, update };
}

function takeLatestTimerCallback(delayMs: number): () => void {
  const setTimeoutMock = vi.mocked(globalThis.setTimeout);
  const callIndex = setTimeoutMock.mock.calls.findLastIndex((call) => call[1] === delayMs);
  expect(callIndex).toBeGreaterThanOrEqual(0);
  clearTimeout(setTimeoutMock.mock.results[callIndex]?.value as ReturnType<typeof setTimeout>);
  return requireValue(
    setTimeoutMock.mock.calls[callIndex]?.[0] as (() => void) | undefined,
    `timer callback for ${delayMs}ms`,
  );
}

async function dispatchPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0],
): Promise<void> {
  await runTelegramMiddlewareChain(makePrivateTextContext(params), messageHandler);
}

async function dispatchSpooledPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0] & {
    updateId: number;
    replayUpdate?: "id" | "full";
  },
) {
  const ctx = makePrivateTextContext(params);
  const update = ctx.update ?? {};
  const replayUpdate =
    params.replayUpdate === "full" ? Object.assign({}, update, { message: ctx.message }) : update;
  return await runWithTelegramSpooledReplayUpdate(replayUpdate, async () => {
    await runTelegramMiddlewareChain(ctx, messageHandler);
  });
}

async function replayText(
  updateId: number,
  text: string,
  overrides: Omit<
    Partial<Parameters<typeof dispatchSpooledPrivateText>[1]>,
    "updateId" | "text"
  > = {},
) {
  const result = await dispatchSpooledPrivateText(getMessageHandler(), {
    updateId,
    messageId: updateId,
    text,
    replayUpdate: "full",
    ...overrides,
  });
  const participant = requireValue(result.deferredWork, "buffered replay participant");
  replayWork.push(participant.task);
  return participant;
}

function captureDeferredReply() {
  const ready = createDeferred<GetReplyOptions>();
  replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
    opts?.turnAdoptionLifecycle?.onDeferred?.();
    ready.resolve(requireValue(opts, "deferred reply options"));
    return undefined;
  });
  return ready.promise;
}

function reply(index = 0) {
  return requireValue(replySpy.mock.calls.at(index)?.[0], "reply payload");
}

function expectReplies(expected: Partial<MsgContext>[]) {
  expect(replySpy.mock.calls.map(([ctx]) => ctx)).toMatchObject(expected);
}

function expectIncludes(value: unknown, ...parts: string[]) {
  for (const part of parts) {
    expect(value).toContain(part);
  }
}

async function createBufferedReplayPair(firstMessageId: number) {
  const replay = (messageId: number, text: string) =>
    replayText(messageId, text, {
      date: 1736380800 + messageId,
      replayUpdate: "id",
    });
  return [
    await replay(firstMessageId, "first buffered message"),
    await replay(firstMessageId + 1, "second buffered message"),
  ] as const;
}

function installTelegramTopicStateForTest(): void {
  resetTelegramTopicNameCacheForTest();
  setTelegramPluginStateRuntimeForTests();
}

async function dispatchSpooledNativeStop(
  params: Omit<Parameters<typeof dispatchSpooledPrivateText>[1], "text" | "replayUpdate"> & {
    match?: string;
  },
) {
  const { match = "", ...messageParams } = params;
  const stopHandler = requireValue(
    commandSpy.mock.calls.find((call) => call[0] === "stop")?.[1] as
      | TelegramMessageHandler
      | undefined,
    "registered native stop handler",
  );
  return await dispatchSpooledPrivateText(
    async (ctx) => await stopHandler({ ...ctx, me: telegramBotInfoForTest, match }),
    {
      ...messageParams,
      text: match ? `/stop ${match}` : "/stop",
      replayUpdate: "full",
      message: {
        ...messageParams.message,
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    },
  );
}

async function setupUpdateOffsetTracker(params: { lastUpdateId: number }) {
  const onUpdateId = vi.fn<(updateId: number) => void | Promise<void>>();
  await createTelegramBot({
    token: "tok",
    updateOffset: { lastUpdateId: params.lastUpdateId, onUpdateId },
  });
  return {
    onUpdateId,
    run: (ctx: Record<string, unknown>, finalNext: () => Promise<void>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, async () => finalNext()),
  };
}

async function runTelegramMiddlewareChain(
  ctx: TelegramTestContext,
  handler: TelegramMessageHandler,
): Promise<void> {
  await runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, handler);
}

function expectResults(kind: "completed" | "skipped", ...tasks: Promise<unknown>[]) {
  return expect(Promise.all(tasks)).resolves.toEqual(tasks.map(() => ({ kind })));
}

async function flushTelegramTestMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function makeGenericCallbackContext(params: { id: string; updateId?: number }) {
  const data = "skip nightly build tonight";
  return createTelegramCallbackContext({
    id: params.id,
    data,
    update: params.updateId === undefined ? undefined : { update_id: params.updateId },
    message: {
      reply_markup: { inline_keyboard: [[{ text: "Skip tonight", callback_data: data }]] },
    },
  });
}

async function expectBlockedContentExcluded(params: { edited: boolean }) {
  configureInbound({}, { dmPolicy: "allowlist", allowFrom: ["123456789"] });
  const chat = { id: 1234, type: "private" };
  await createTelegramBot({ token: "tok" });
  const blocked = makePrivateTextContext({
    text: "unauthorized secret",
    messageId: 411,
    from: { id: 999999, username: "notallowed" },
    message: { chat, ...(params.edited ? { edit_date: 1736380810 } : {}) },
    downloadable: true,
  });
  if (params.edited) {
    const { message, ...ctx } = blocked;
    await getOnHandler("edited_message")({ ...ctx, editedMessage: message });
  } else {
    await getMessageHandler()(blocked);
  }
  expect(replySpy).not.toHaveBeenCalled();
  await getMessageHandler()(
    makePrivateTextContext({
      text: "authorized follow-up",
      messageId: 412,
      date: 1736380860,
      from: { id: 123456789, username: "allowed" },
      message: { chat },
      downloadable: true,
    }),
  );
  expect(replySpy).toHaveBeenCalledTimes(1);
  expect(reply(0).ChannelStructuredContext).toBeUndefined();
  expect(sendMessageSpy).not.toHaveBeenCalled();
}

describe("createTelegramBot", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });
  afterEach(async () => {
    try {
      for (const cleanup of testCleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      for (const restore of spyRestorers.splice(0).toReversed()) {
        restore();
      }
      vi.useRealTimers();
      await closeOpenClawStateDatabaseAsync();
      pluginStateTestRuntime.resetPluginStateStoreForTests();
      clearPluginInteractiveHandlers();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    replayWork.length = 0;
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-bot-"));
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    clearPluginInteractiveHandlers();
    resetTelegramAccountThrottlersForTest();
    throttlerSpy.mockReset();
    pluginStateTestRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
  });

  it("acknowledges callbacks before waiting for their chat's active message handler", async () => {
    await createTelegramBot({ token: "tok" });
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const callbackHandler = vi.fn(async () => {});
    const message = runTelegramMiddlewareChain(
      makePrivateTextContext({ updateId: 1, messageId: 1, chatId: 7, text: "first" }),
      async () => {
        started.resolve();
        await release.promise;
      },
    );
    const runs = [message];

    onCleanup(async () => {
      release.resolve();
      await Promise.allSettled(runs);
    });
    await started.promise;
    const callback = runTelegramMiddlewareChain(
      createTelegramCallbackContext({
        id: "queued-callback",
        data: "ordinary-action",
        updateId: 2,
        message: { chat: { id: 7, type: "private" } },
      }),
      callbackHandler,
    );
    runs.push(callback);
    await runTelegramMiddlewareChain(
      makePrivateTextContext({ updateId: 3, messageId: 3, chatId: 8, text: "other chat" }),
      async () => {},
    );

    expect(answerCallbackQuerySpy).toHaveBeenCalledExactlyOnceWith("queued-callback");
    expect(callbackHandler).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all(runs);
    expect(callbackHandler).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "keeps registry failures retryable", optionIds: [0], preparesRegistry: true },
    { name: "skips the registry for vote retraction", optionIds: [], preparesRegistry: false },
  ])("poll preparation $name", async ({ optionIds, preparesRegistry }) => {
    const readError = new Error("poll registry unavailable");
    const lookup = vi.fn(async () => {
      throw readError;
    });
    const openKeyedStoreV2: TelegramRuntime["state"]["openKeyedStoreV2"] = <T>() =>
      makeTelegramKeyedStoreTestMock<T>({ lookup });
    setTelegramRuntime({
      state: { openKeyedStoreV2 },
      channel: { inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress } },
    } as TelegramRuntime);
    await createTelegramBot({ token: "tok" });
    const update = {
      update_id: 41,
      poll_answer: {
        poll_id: "poll-retry",
        option_ids: optionIds,
        user: { id: 9, first_name: "Ada" },
      },
    };

    const reachedHandlers = vi.fn();
    onCleanup(async () => {
      clearTelegramRuntimeForTest();
    });
    const run = () => runTelegramTestMiddlewareChain(middlewareUseSpy, { update }, reachedHandlers);
    if (preparesRegistry) {
      await expect(runWithTelegramSpooledReplayUpdate(update, run)).rejects.toMatchObject({
        name: TelegramSpooledReplayProcessingError.name,
        cause: readError,
      });
    } else {
      await run();
      expect(lookup).not.toHaveBeenCalled();
      expect(reachedHandlers).toHaveBeenCalledOnce();
    }
  });

  it("preserves same-chat reply order when a debounced run is still active", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, userTimezone: "UTC" });

    autoRestore(vi.spyOn(globalThis, "setTimeout"));
    const startedBodies: string[] = [];
    const firstRunStarted = createDeferred<void>();
    const firstRunGate = createDeferred<void>();

    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      if (body.includes("first")) {
        firstRunStarted.resolve();
        await firstRunGate.promise;
      }
      return { text: `reply:${body}` };
    });

    onCleanup(async () => {
      firstRunGate.resolve();
      await Promise.allSettled(replayWork);
    });
    await createTelegramBot({ token: "tok" });

    await replayText(101, "first");

    takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();

    await firstRunStarted.promise;
    expect(startedBodies).toHaveLength(1);
    expect(startedBodies[0]).toContain("first");

    await replayText(102, "second", { date: 1736380801 });

    takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
    await Promise.resolve();

    expect(startedBodies).toHaveLength(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();

    firstRunGate.resolve();

    await Promise.all(replayWork);
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    const ordered = [expect.stringContaining("first"), expect.stringContaining("second")];
    expect(startedBodies).toEqual(ordered);
    expect(sendMessageSpy.mock.calls.map((call) => String(call[1]))).toEqual(ordered);
  });

  it("applies committed Telegram debounce changes only when new input arrives", async () => {
    const commitDebounce = (telegram: number) => {
      const config: OpenClawConfig = {
        messages: { inbound: { byChannel: { telegram } } },
        channels: { telegram: OPEN_DM },
      };
      loadConfig.mockReturnValue(config);
      setRuntimeConfigSnapshot(config, config);
    };
    commitDebounce(1000);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);

    onCleanup(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(replayWork);
      clearRuntimeConfigSnapshot();
    });
    await createTelegramBot({ token: "tok" });
    const first = await replayText(511, "before delay change");

    await vi.advanceTimersByTimeAsync(100);
    commitDebounce(500);
    await vi.advanceTimersByTimeAsync(899);
    expect(replySpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(first.task).resolves.toEqual({ kind: "completed" });
    expectReplies([{ RawBody: "before delay change", MessageSid: "511" }]);

    await replayText(512, "new batch");

    await vi.advanceTimersByTimeAsync(100);
    commitDebounce(1500);
    await replayText(513, "extends batch");

    await vi.advanceTimersByTimeAsync(1499);
    expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual(["before delay change"]);
    await vi.advanceTimersByTimeAsync(1);
    await expectResults("completed", ...replayWork);
    expectReplies([
      { RawBody: "before delay change", MessageSid: "511" },
      { RawBody: "new batch\nextends batch", MessageSid: "513" },
    ]);
  });

  it("assembles a default short-long-short burst despite intervening message IDs", async () => {
    configureTelegram(
      { dmPolicy: "open", allowFrom: ["*"] },
      { agents: { defaults: { userTimezone: "UTC" } } },
    );
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1736380800000);
    replySpy.mockResolvedValue(undefined);

    await createTelegramBot({ token: "tok" });
    const short = await replayText(301, "A".repeat(611));
    await vi.advanceTimersByTimeAsync(283);
    const long = await replayText(302, "B".repeat(4065), { date: 1736380801 });
    await vi.advanceTimersByTimeAsync(1400);
    const continuation = await replayText(303, "C".repeat(3354), {
      messageId: 305,
      date: 1736380802,
    });

    await vi.advanceTimersByTimeAsync(2703);
    await expectResults("completed", short.task, long.task, continuation.task);

    expectReplies([
      {
        RawBody: "A".repeat(611) + "\n" + "B".repeat(4065) + "C".repeat(3354),
        MessageSid: "305",
        Timestamp: 1736380802000,
      },
    ]);

    expect(reply().SessionTranscriptContext?.beforeTimestampMs).toBe(1736380800000);

    const next = await replayText(304, "next independent message", { messageId: 306 });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(next.task).resolves.toEqual({ kind: "completed" });
    expectReplies([
      {
        RawBody: "A".repeat(611) + "\n" + "B".repeat(4065) + "C".repeat(3354),
        MessageSid: "305",
      },
      { RawBody: "next independent message", MessageSid: "306" },
    ]);
  });

  it("lets /stop@openclaw_bot bypass and cancel pending same-chat inbound debounce", async () => {
    const stopText = "/stop@openclaw_bot";
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, userTimezone: "UTC" });

    autoRestore(vi.spyOn(globalThis, "setTimeout"));
    const startedBodies: string[] = [];
    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      return { text: `reply:${body}` };
    });

    onCleanup(async () => {
      await Promise.allSettled(replayWork);
    });
    await createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();
    await dispatchPrivateText(messageHandler, { updateId: 101, messageId: 101, text: "first" });
    const flushFirst = takeLatestTimerCallback(INBOUND_DEBOUNCE_MS);
    await dispatchPrivateText(messageHandler, {
      updateId: 102,
      messageId: 102,
      text: stopText,
      date: 1736380801,
    });

    expect(startedBodies).toHaveLength(1);
    expect(startedBodies[0]).toContain("stop");

    flushFirst();
    await Promise.resolve();
    expect(startedBodies).toHaveLength(1);
    expect(sendMessageSpy.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain(
      "reply:first",
    );

    const reused = await replayText(103, "first", { messageId: 101 });
    takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
    await reused.task;
    expect(startedBodies).toHaveLength(2);
    expect(startedBodies[1]).toContain("first");
  });

  it.each([
    { scope: "another sender", senderId: 43, threadId: 99 },
    { scope: "another topic", senderId: 42, threadId: 100 },
  ])("native stop preserves a pending fragment from $scope", async ({ senderId, threadId }) => {
    installTelegramTopicStateForTest();
    const chat = {
      id: ++forumCacheChatId,
      type: "supergroup",
      title: "OpenClaw Ops",
      is_forum: true,
    };
    const topic = (thread: number) => ({ chat, message_thread_id: thread, is_topic_message: true });
    configureNativeGroupStop();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    onCleanup(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(replayWork);
      clearTelegramRuntimeForTest();
      resetTelegramTopicNameCacheForTest();
    });
    await createTelegramBot({ token: "tok" });
    const target = await replayText(419, "T".repeat(4065), { message: topic(99) });

    const pending = await replayText(421, "P".repeat(4065), {
      from: { id: senderId, first_name: "Pending sender" },
      message: topic(threadId),
    });

    await vi.advanceTimersByTimeAsync(100);
    await dispatchSpooledNativeStop({ updateId: 422, messageId: 422, message: topic(99) });
    expect(reply()).toMatchObject({
      CommandSource: "native",
      CommandAuthorized: true,
      MessageSid: "422",
      SenderId: "42",
      MessageThreadId: 99,
    });
    expect(target.isSettled()).toBe(true);
    await expect(target.task).resolves.toEqual({ kind: "skipped" });
    expect(pending.isSettled()).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(pending.task).resolves.toEqual({ kind: "completed" });
    expectReplies([
      { RawBody: "/stop", MessageSid: "422" },
      {
        RawBody: "P".repeat(4065),
        MessageSid: "421",
        SenderId: String(senderId),
        MessageThreadId: threadId,
      },
    ]);
  });

  it("does not cancel prior input for native stop with unsupported arguments", async () => {
    configureTelegram(
      { dmPolicy: "open", allowFrom: ["*"] },
      {
        commands: { native: true, allowFrom: { telegram: ["42"] } },
        messages: { inbound: { byChannel: { telegram: 3000 } } },
      },
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);

    onCleanup(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(replayWork);
    });
    await createTelegramBot({ token: "tok" });
    const pending = await replayText(431, "Q".repeat(4065));

    await vi.advanceTimersByTimeAsync(100);

    await dispatchSpooledNativeStop({ updateId: 432, messageId: 432, match: "later" });

    expect(replySpy.mock.calls.find(([ctx]) => ctx.MessageSid === "432")?.[0]).toMatchObject({
      CommandSource: "native",
      CommandAuthorized: true,
      CommandBody: "/stop later",
      MessageSid: "432",
    });
    await expect(pending.task).resolves.toEqual({ kind: "completed" });
    expectReplies([
      { RawBody: "Q".repeat(4065), MessageSid: "431" },
      { RawBody: "/stop later", MessageSid: "432" },
    ]);
  });

  it("stop cancels ordinary and forwarded batches queued behind an active turn", async () => {
    configureOpenDm({ debounceMs: 3000, userTimezone: "UTC" });
    const attachmentPath = path.join(
      requireValue(process.env.OPENCLAW_STATE_DIR, "test state directory"),
      "caption.txt",
    );
    writeFileSync(attachmentPath, "attachment");
    const resolveMedia = autoRestore(vi.spyOn(telegramMediaResolver, "resolveMedia"));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const earlierStarted = createDeferred<void>();
    const releaseEarlier = createDeferred<void>();
    replySpy.mockImplementation(async (ctx: MsgContext) => {
      if (ctx.MessageSid === "440") {
        earlierStarted.resolve();
        await releaseEarlier.promise;
      }
      return undefined;
    });

    onCleanup(async () => {
      releaseEarlier.resolve();
      await replayWork[0];
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(replayWork);
    });
    await createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();
    const earlier = await replayText(440, "earlier active message");
    await vi.advanceTimersByTimeAsync(3000);
    await earlierStarted.promise;
    const ordinary = await replayText(441, "A".repeat(611));

    const forwarded = await replayText(442, "F".repeat(611), {
      message: { forward_origin: { type: "hidden_user", date: 1736380700, sender_user_name: "A" } },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440"]);

    resolveMedia.mockResolvedValueOnce({
      id: "caption-fixture",
      fileUniqueId: "caption-document-unique",
      path: attachmentPath,
      size: 10,
      contentType: "text/plain",
      kind: "document",
      savedAt: 1736380800000,
    });
    await dispatchPrivateText(messageHandler, {
      updateId: 443,
      messageId: 443,
      text: "",
      message: {
        text: undefined,
        caption: "stop",
        document: {
          file_id: "caption-document",
          file_unique_id: "caption-document-unique",
          file_name: "caption.txt",
          mime_type: "text/plain",
        },
      },
    });

    expect(ordinary.isSettled()).toBe(true);
    expect(forwarded.isSettled()).toBe(true);
    await expectResults("skipped", ordinary.task, forwarded.task);
    await vi.advanceTimersByTimeAsync(3000);
    expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440", "443"]);
    releaseEarlier.resolve();
    await expect(earlier.task).resolves.toEqual({ kind: "completed" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(replySpy.mock.calls.map(([ctx]) => ctx.MessageSid)).toEqual(["440", "443"]);
  });

  it("native stop cancels pending input before configured binding preparation finishes", async () => {
    installTelegramTopicStateForTest();
    const topic = {
      chat: { id: -1001234567890, type: "supergroup", title: "Bound topic", is_forum: true },
      message_thread_id: 42,
      is_topic_message: true,
    };
    configureNativeGroupStop();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);
    const preparationStarted = createDeferred<void>();
    const releasePreparation = createDeferred<void>();
    const stop: { task?: ReturnType<typeof dispatchSpooledNativeStop> } = {};
    const bindingRoute = autoRestore(vi.spyOn(bindingRuntime, "resolveConfiguredBindingRoute"));
    const bindingReady = autoRestore(
      vi.spyOn(conversationRuntime, "ensureConfiguredBindingRouteReady"),
    );

    onCleanup(async () => {
      releasePreparation.resolve();
      await stop.task;
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.all(replayWork);
      clearTelegramRuntimeForTest();
      resetTelegramTopicNameCacheForTest();
    });
    await createTelegramBot({ token: "tok" });
    const pending = await replayText(451, "H".repeat(4065), { message: topic });

    bindingRoute.mockImplementation(({ route }) =>
      createConfiguredBindingRoute(
        route,
        createConfiguredAcpTopicBinding("agent:main:acp:binding:telegram:default:held"),
      ),
    );
    bindingReady.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
      return { ok: false, error: "binding unavailable" };
    });

    stop.task = dispatchSpooledNativeStop({ updateId: 452, messageId: 452, message: topic });
    await preparationStarted.promise;

    expect(pending.isSettled()).toBe(true);
    await expect(pending.task).resolves.toEqual({ kind: "skipped" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(replySpy).not.toHaveBeenCalled();
    releasePreparation.resolve();
    await stop.task;
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("keeps separate text-batch replay settlements isolated when the next batch fails", async () => {
    configureOpenDm({ debounceMs: 300, userTimezone: "UTC" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const secondDispatchError = new Error("next batch failed before adoption");
    replySpy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(secondDispatchError);

    await createTelegramBot({ token: "tok" });
    const first = await replayText(213, "A".repeat(4050));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(first.task).resolves.toEqual({ kind: "completed" });
    const second = await replayText(214, "next message", { messageId: 215 });
    await vi.advanceTimersByTimeAsync(300);
    expect(second).not.toBe(first);
    await expect(second.task).resolves.toEqual({
      kind: "failed-retryable",
      error: secondDispatchError,
    });
    await expect(first.task).resolves.toEqual({ kind: "completed" });
    expectReplies([
      { RawBody: "A".repeat(4050), MessageSid: "213" },
      { RawBody: "next message", MessageSid: "215" },
    ]);
  });

  it.each([
    { name: "retries deferred adoption after durable commit failure", mode: "retry", id: 221 },
    {
      name: "serializes timeout behind an in-flight durable adoption commit",
      mode: "during",
      id: 225,
    },
    { name: "blocks buffered adoption after a participant times out", mode: "before", id: 223 },
  ])("$name", async ({ mode, id }) => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, userTimezone: "UTC" });
    autoRestore(vi.spyOn(globalThis, "setTimeout"));
    const queuedReply = captureDeferredReply();
    const commitError = new Error("durable dispatch commit failed");
    const commitStarted = createDeferred<void>();
    const commitGate = createDeferred<void>();
    const commit = autoRestore(
      vi.spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay"),
    );
    const release = autoRestore(
      vi.spyOn(messageDispatchDedupe, "releaseTelegramMessageDispatchReplay"),
    );
    if (mode === "retry") {
      commit.mockRejectedValueOnce(commitError);
    }
    if (mode === "during") {
      commit.mockImplementationOnce(async () => {
        commitStarted.resolve();
        await commitGate.promise;
      });
    }
    onCleanup(async () => {
      commitGate.resolve();
    });
    await createTelegramBot({ token: "tok" });
    const [first, second] = await createBufferedReplayPair(id);
    takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
    const { turnAdoptionLifecycle: lifecycle, abortSignal } = await queuedReply;
    expect(lifecycle?.onAdopted).toEqual(expect.any(Function));
    if (mode === "retry") {
      let firstSettled = false,
        secondSettled = false;
      void first.task.then(() => {
        firstSettled = true;
      });
      void second.task.then(() => {
        secondSettled = true;
      });
      await expect(lifecycle?.onAdopted?.()).rejects.toBe(commitError);
      await flushTelegramTestMicrotasks();
      expect([firstSettled, secondSettled]).toEqual([false, false]);
      await lifecycle?.onAdopted?.();
      await expectResults("completed", first.task, second.task);
      expect(commit).toHaveBeenCalledTimes(2);
      lifecycle?.onSettled?.();
    } else if (mode === "during") {
      let modelTurnRan = false;
      const runQueuedTurn = async () => {
        await lifecycle?.onAdopted?.();
        if (abortSignal?.aborted) {
          throw abortSignal.reason;
        }
        modelTurnRan = true;
        lifecycle?.onSettled?.();
      };
      expect(runQueuedTurn).toEqual(expect.any(Function));
      const queuedTurn = runQueuedTurn();
      await commitStarted.promise;
      const timeoutError = new Error("spooled replay timed out during durable adoption");
      let firstSettled = false;
      void first.task.then(() => {
        firstSettled = true;
      });
      first.settle({ kind: "failed-retryable", error: timeoutError });
      await flushTelegramTestMicrotasks();
      expect(firstSettled).toBe(false);
      expect(first.abortSignal.aborted).toBe(false);
      expect(release).not.toHaveBeenCalled();
      commitGate.resolve();
      await queuedTurn;
      expect(modelTurnRan).toBe(true);
      expect(abortSignal?.aborted).toBe(false);
      await expectResults("completed", first.task, second.task);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    } else {
      const timeoutError = new Error("spooled replay timed out before admission");
      first.settle({ kind: "failed-retryable", error: timeoutError });
      await vi.waitFor(() => {
        expect(abortSignal?.aborted).toBe(true);
      });
      await expect(second.task).resolves.toEqual({ kind: "failed-retryable", error: timeoutError });
      await expect(lifecycle?.onAdopted?.()).rejects.toBe(timeoutError);
      expect(commit).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
    }
  });

  it("dispatches native poll messages through the ordinary inbound handler", async () => {
    configureTelegram({ dmPolicy: "open", allowFrom: ["*"] });
    await createTelegramBot({ token: "tok" });

    await getMessageHandler()(
      makePrivateTextContext({
        text: "",
        messageId: 551,
        message: {
          text: undefined,
          poll: {
            id: "poll-551",
            question: "Approve deployment?",
            options: [
              { persistent_id: "yes", text: "Yes", voter_count: 3 },
              { persistent_id: "no", text: "No", voter_count: 0 },
            ],
            total_voter_count: 3,
            is_closed: false,
            is_anonymous: false,
            type: "regular",
            allows_multiple_answers: false,
          },
        },
      }),
    );

    expect(replySpy).toHaveBeenCalledOnce();
    const payload = requireValue(reply(0), "inbound poll payload");
    expectIncludes(
      payload.BodyForAgent,
      "[Poll] Approve deployment?",
      "1. Yes — 3 votes",
      "2. No — 0 votes",
      "Total voters: 3",
    );
  });

  it("preserves a bot mention split across ordinary long-paste fragments", async () => {
    configureInbound({}, { groupPolicy: "open", groups: { "*": { requireMention: true } } });
    autoRestore(vi.spyOn(globalThis, "setTimeout"));
    let flush: (() => void) | undefined;
    onCleanup(async () => {
      flush?.();
      await Promise.allSettled(replayWork);
    });
    await createTelegramBot({ token: "tok" });
    const fragments = ["A".repeat(4090) + " @open", "claw_bot help"];
    for (const [index, text] of fragments.entries()) {
      await replayText(8300 + index, text, {
        message: { chat: { id: -1008300, type: "supergroup", title: "Long paste" } },
      });

      flush = takeLatestTimerCallback(1_500);
    }
    requireValue(flush, "long-paste flush")();
    await Promise.all(replayWork);
    expect(replySpy).toHaveBeenCalledOnce();
    expect(reply(0).RawBody).toBe(fragments.join(""));
  });

  it.each([false, true])(
    "keeps forwarded contact mentions separate from text (contactFirst=%s)",
    async (contactFirst) => {
      configureTelegram({ groupPolicy: "open", groups: { "*": { requireMention: true } } });
      autoRestore(vi.spyOn(globalThis, "setTimeout"));
      let flush: (() => void) | undefined;
      onCleanup(async () => {
        flush?.();
        await Promise.allSettled(replayWork);
      });
      await createTelegramBot({ token: "tok" });
      let id = contactFirst ? 8100 : 8200;
      for (const text of ["hello", "@openclaw_bot help"]) {
        replySpy.mockClear();
        const segments = [
          { text },
          { contact: { first_name: "@openclaw_bot", phone_number: "+15550100001" } },
        ];
        if (contactFirst) {
          segments.reverse();
        }
        for (const segment of segments) {
          await replayText(++id, "", {
            messageId: id,
            message: {
              ...segment,
              chat: { id: -1008100, type: "supergroup", title: "Contact batch" },
              forward_origin: { type: "hidden_user", date: 500, sender_user_name: "Original" },
            },
          });

          flush = takeLatestTimerCallback(1_000);
        }
        requireValue(flush, "contact batch flush")();
        await Promise.all(replayWork);
        expect(replySpy).toHaveBeenCalledTimes(text === "hello" ? 0 : 1);
        if (text !== "hello") {
          expect(reply(0).BodyForAgent).toContain("[Shared contact] @openclaw_bot, +15550100001");
        }
      }
    },
  );

  it.each([false, true])(
    "preserves forwarded origin and formatting across debounce (multiple=%s)",
    async (multiple) => {
      configureOpenDm({ userTimezone: "UTC" });
      autoRestore(vi.spyOn(globalThis, "setTimeout"));
      let flushForward: (() => void) | undefined;

      onCleanup(async () => {
        flushForward?.();
        await Promise.allSettled(replayWork);
      });
      await createTelegramBot({ token: "tok" });
      const messages = multiple
        ? ([
            [561, "😀 bold", [{ type: "bold", offset: 3, length: 4 }], "Original A"],
            [
              562,
              "read docs",
              [{ type: "text_link", offset: 5, length: 4, url: "https://docs.example" }],
              "Original B",
            ],
          ] as const)
        : ([[121, "single forwarded note", [], "Original A"]] as const);
      for (const [messageId, text, entities, origin] of messages) {
        await replayText(messageId, text, {
          messageId,
          date: 1736380800 + messageId,
          message: {
            ...(multiple ? { entities } : {}),
            forward_origin: {
              type: "hidden_user",
              date: 500 + messageId,
              sender_user_name: origin,
            },
          },
        });

        flushForward = takeLatestTimerCallback(1_000);
      }

      requireValue(flushForward, "forwarded debounce callback")();
      await Promise.all(replayWork);
      expect(replySpy).toHaveBeenCalledOnce();
      const payload = requireValue(reply(0), "formatted forwarded batch payload");
      if (multiple) {
        expect(payload).toMatchObject({
          RawBody: "😀 **bold**\nread [docs](https://docs.example)",
          CommandBody: "😀 **bold**\nread [docs](https://docs.example)",
        });
        expect(payload.ForwardedFrom).toBeUndefined();
        expect(payload.BodyForAgent).toMatch(
          /\[Forwarded from Original A[^\]]*\]\n😀 \*\*bold\*\*\n\[Forwarded from Original B[^\]]*\]\nread \[docs\]\(https:\/\/docs\.example\)/,
        );
        expect(payload.BodyForAgent).not.toContain("Conversation info:");
      } else {
        expect(payload.Body).toContain("[Forwarded from Original A");
        expect(payload.ForwardedFrom).toBe("Original A");
      }
    },
  );

  it("does not let an unauthorized group stop cancel pending text", async () => {
    const text = "B".repeat(4065);
    const chatId = ++forumCacheChatId;
    configureTelegram(
      { dmPolicy: "pairing", groupPolicy: "open", groups: { "*": { requireMention: false } } },
      {
        agents: { defaults: { userTimezone: "UTC" } },
        messages: { inbound: { debounceMs: INBOUND_DEBOUNCE_MS } },
      },
    );

    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    replySpy.mockResolvedValue(undefined);

    onCleanup(async () => {
      await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS);
      await Promise.all(replayWork);
    });
    await createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();

    const pending = await replayText(104, text, {
      date: 1736380804,
      message: {
        chat: { id: chatId, type: "supergroup", title: "OpenClaw Ops" },
        from: { id: 42, first_name: "Ada", is_bot: false },
      },
    });

    await dispatchPrivateText(messageHandler, {
      updateId: 105,
      messageId: 105,
      text: "stop",
      date: 1736380805,
      message: { chat: { id: chatId, type: "supergroup", title: "OpenClaw Ops" } },
    });

    await vi.advanceTimersByTimeAsync(INBOUND_DEBOUNCE_MS);
    await expect(pending.task).resolves.toEqual({ kind: "completed" });
    expect(replySpy.mock.calls.map(([ctx]) => ctx.RawBody)).toContain(text);
  });

  it("routes opaque payloads to their registered plugin without text fallback", async () => {
    const data = buildTelegramOpaqueCallbackData("code-agent:approve-123 ");
    const namespace = "code-agent";
    const pluginHandler = vi.fn(async (ctx) => {
      expect(ctx.callback.namespace).toBe(namespace);
      expect(ctx.callback.payload).toBe("approve-123");
      await ctx.respond.clearButtons();
      return { handled: true };
    });
    expect(registerInteractive("openclaw-code-agent", namespace, pluginHandler)).toEqual({
      ok: true,
    });

    await createTelegramBot({ token: "tok" });
    await tap("cbq-plugin-1", data, {
      text: "Approve this code-agent action?",
      message: button("Approve", data),
    });

    expect(pluginHandler).toHaveBeenCalledTimes(1);
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-1");
  });

  it("respects native command callback ownership", async () => {
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractive("namespace-collision", "tgcmd", pluginHandler)).toEqual({
      ok: true,
    });
    await createTelegramBot({ token: "tok" });
    await tap("cbq-command-1", "tgcmd:/fast status");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-command-1");
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = reply();
    expect(pluginHandler).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ CommandBody: "/fast status", CommandSource: "native" });
  });

  it("retries generic callbacks after transient button cleanup failures", async () => {
    const error = "edit boom";
    await createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const id = "cbq-generic-clear-1";
    const ctx = makeGenericCallbackContext({ id, updateId: 779 });
    editMessageReplyMarkupSpy.mockRejectedValueOnce(new Error(error));
    await expect(runTelegramMiddlewareChain(ctx, callbackHandler)).rejects.toThrow(error);
    expect(replySpy).not.toHaveBeenCalled();
    await runTelegramMiddlewareChain(ctx, callbackHandler);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = reply();
    expect(payload.Body).toContain("skip nightly build tonight");
  });

  it.each([
    { name: "live tap", durableReceivedAtMs: undefined },
    { name: "durable replay", durableReceivedAtMs: 1_736_381_700_000 },
  ])("stamps generic callbacks with receipt time for $name", async ({ durableReceivedAtMs }) => {
    // Fixture card was sent at 1_736_380_800; the tap arrives 20 minutes later.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_736_382_000_000);

    await createTelegramBot({ token: "tok" });
    const callbackContext = makeGenericCallbackContext({ id: "cbq-generic-time-1" });
    const ctx = {
      ...callbackContext,
      update: { update_id: 780, callback_query: callbackContext.callbackQuery },
    };
    const rawUpdate = JSON.stringify(ctx.update);
    if (durableReceivedAtMs !== undefined) {
      recordTelegramUpdateReceivedAt(ctx.update, durableReceivedAtMs);
    }
    expect(JSON.stringify(ctx.update)).toBe(rawUpdate);
    await getOnHandler("callback_query")(ctx);
    const payload = reply();
    const expectedMs = durableReceivedAtMs ?? 1_736_382_000_000;
    expect(payload).toMatchObject({ Timestamp: expectedMs, ProviderMessageTimestamp: expectedMs });
  });

  it("preserves trailing whitespace in OC_MULTI values without routing generic messages", async () => {
    const value = "env|prod ";
    const data = `OC_MULTI|toggle|${value}`;
    await createTelegramBot({ token: "tok" });
    await tap("cbq-multi-toggle-1", data, {
      message: {
        business_connection_id: "biz-multi-1",
        reply_markup: { inline_keyboard: [[{ text: "Prod", callback_data: data }]] },
      },
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      business_connection_id: "biz-multi-1",
      reply_markup: { inline_keyboard: [[{ text: "✅ Prod", callback_data: data }]] },
    });
    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-multi-toggle-1");
  });

  it.each([
    {
      id: "cbq-multi-submit-1",
      data: "OC_MULTI|submit",
      buttons: [
        [{ text: "✅ Prod", callback_data: "OC_MULTI|toggle|env|prod" }],
        [{ text: "Blue", callback_data: "OC_MULTI|toggle|blue" }],
      ],
      text: "Multi-select submitted: env|prod",
      clearsButtons: false,
    },
    {
      id: "cbq-select-1",
      data: "OC_SELECT|env|canary",
      buttons: [[{ text: "Canary", callback_data: "OC_SELECT|env|canary" }]],
      text: "Single-select submitted: env|canary",
      clearsButtons: true,
    },
  ])(
    "submits $data as a synthetic inbound message",
    async ({ id, data, buttons, text, clearsButtons }) => {
      await createTelegramBot({ token: "tok" });
      const ctx = receivedCallback(
        makeCallback(id, data, {
          message: { date: 1_736_380_800, reply_markup: { inline_keyboard: buttons } },
        }),
        781,
        1_736_382_000_000,
      );
      await getCallbackHandler()(ctx);
      if (clearsButtons) {
        expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
          reply_markup: { inline_keyboard: [] },
        });
      }
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = reply();
      expect(payload.Body).toContain(text);
      expect(payload.ProviderMessageTimestamp).toBe(1_736_382_000_000);
    },
  );

  it("uses callback receipt time for plugin text submissions", async () => {
    registerInteractive("timestamp-test", "timestamp", async () => ({
      handled: true,
      submitText: "Plugin submission",
    }));
    await createTelegramBot({ token: "tok" });
    const ctx = receivedCallback(
      makeCallback("plugin-submit-time", buildTelegramOpaqueCallbackData("timestamp:submit")),
      782,
      1_736_382_000_000,
    );
    await getCallbackHandler()(ctx);
    const payload = reply();
    expect(payload.Body).toContain("Plugin submission");
    expect(payload.ProviderMessageTimestamp).toBe(1_736_382_000_000);
  });

  it.each([
    { data: "tgcmd:/login codex", namespace: "tgcmd" },
    { data: "tgcb1:invalid", namespace: "missing-plugin" },
  ])(
    "terminalizes $data after inline buttons are disabled without raw-text fallthrough",
    async ({ data, namespace }) => {
      const pluginHandler = vi.fn(async () => ({ handled: true }));
      registerInteractive("disabled-native-collision", namespace, pluginHandler);
      configureInbound(
        {},
        { dmPolicy: "open", allowFrom: ["*"], capabilities: { inlineButtons: "off" } },
      );

      await createTelegramBot({ token: "tok" });
      await tap("cbq-disabled-native", data, {
        message: { reply_markup: { inline_keyboard: [[{ text: "Action", callback_data: data }]] } },
      });

      expect(pluginHandler).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
      expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
        reply_markup: { inline_keyboard: [] },
      });
      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        "This action is no longer available.",
        undefined,
      );
    },
  );

  it.each([false, true])(
    "allows a Codex login callback only for an owner (owner=%s)",
    async (owner) => {
      const login = vi
        .fn<typeof providerAuth.runModelsAuthLoginFlow>()
        .mockImplementation(async ({ prompter }) => {
          await prompter.deviceCode?.({
            title: "OpenAI Codex device code",
            code: "OWNER-CODE",
            message: "URL: https://auth.openai.com/codex/device",
          });
          return {
            providerId: "openai",
            methodId: "device-code",
            authRefresh: "refreshed",
            profiles: [{ profileId: "openai:codex", provider: "openai", mode: "oauth" }],
          };
        });
      const runLogin = providerAuth.runProviderChannelLoginFlow;
      autoRestore(vi.spyOn(providerAuth, "runProviderChannelLoginFlow")).mockImplementation(
        (params) => runLogin({ ...params, runLoginFlow: login }),
      );
      configureInbound(
        {
          commands: { native: true, ownerAllowFrom: [owner ? "9" : "999"] },
          ...(owner ? { agents: { entries: { main: {} } } } : {}),
        },
        owner ? { dmPolicy: "pairing" } : OPEN_DM,
      );
      await createTelegramBot({ token: "tok" });
      await tap(owner ? "cbq-login-owner" : "cbq-login-nonowner", "tgcmd:/login codex", {
        message: button("Log in to Codex", "tgcmd:/login codex"),
      });
      if (owner) {
        expect(login).toHaveBeenCalledOnce();
        expect(sendMessageSpy).toHaveBeenCalledWith(
          1234,
          expect.stringContaining("Code: <code>OWNER-CODE</code>"),
          expect.objectContaining({ parse_mode: "HTML" }),
        );
      } else {
        expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
        expect(login).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledWith(
          1234,
          "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
          {},
        );
      }
    },
  );

  it.each(["polling", "spooled replay"] as const)(
    "keeps pairing store failures retryable during %s",
    async (mode) => {
      configureInbound({}, { dmPolicy: "pairing" });
      readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
      if (mode === "polling") {
        readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);
      }
      const onUpdateId = vi.fn();

      await createTelegramBot({
        token: "tok",
        ...(mode === "spooled replay" ? { updateOffset: { lastUpdateId: 700, onUpdateId } } : {}),
      });
      const handler = getMessageHandler();
      const sender = { id: 123456789, username: "testuser" };
      const ctx = makePrivateTextContext({
        chatId: 1234,
        text: "hello",
        messageId: mode === "polling" ? 10 : 9,
        from: sender,
        downloadable: true,
      });
      if (mode === "spooled replay") {
        const update = { update_id: 701, message: ctx.message };
        await expect(
          runWithTelegramSpooledReplayUpdate(update, () =>
            runTelegramMiddlewareChain({ ...ctx, update }, handler),
          ),
        ).rejects.toMatchObject({
          name: TelegramSpooledReplayProcessingError.name,
          cause: expect.objectContaining({ name: "TelegramPairingStoreReadError" }),
        });
        expect(onUpdateId).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
      } else {
        await handler(ctx);
        await handler(
          makePrivateTextContext({
            chatId: 1234,
            text: "still there?",
            messageId: 11,
            date: 1736380801,
            from: sender,
            downloadable: true,
          }),
        );
        expect(readChannelAllowFromStore).toHaveBeenCalledTimes(2);
        expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy.mock.calls[0]?.[1]).toMatch(/please try again/i);
        expect(replySpy).toHaveBeenCalledTimes(1);
      }
    },
  );

  const self = { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" };
  const selfMessage = {
    chat: { id: 1234, type: "private", first_name: "Harold" },
    message_id: 1884,
    date: 1736380800,
    from: self,
  };
  it.each([
    {
      name: "self-authored updates",
      requireTopic: false,
      me: self,
      message: {
        ...selfMessage,
        pinned_message: {
          ...selfMessage,
          message_id: 1883,
          date: 1736380799,
          text: "Binding: Review pull request 54118 (openclaw)",
        },
      },
    },
    {
      name: "topic-required root DMs",
      requireTopic: true,
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 413,
        date: 1736380870,
        text: "root dm without topic",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
    },
  ])("drops $name before issuing pairing challenges", async ({ requireTopic, message, me }) => {
    configureInbound(
      {},
      {
        dmPolicy: "pairing",
        ...(requireTopic ? { direct: { "1234": { requireTopic: true } } } : {}),
      },
    );
    readChannelAllowFromStore.mockResolvedValue([]);
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()({
      message,
      me,
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it.each([
    { name: "text DM", edited: false },
    { name: "edited DM", edited: true },
  ])("excludes blocked $name content from authorized prompt context", expectBlockedContentExcluded);

  it.each(["disabled", "pairing"] as const)(
    "blocks unauthorized DM photo downloads with %s policy",
    async (dmPolicy) => {
      configureInbound({}, { dmPolicy });
      if (dmPolicy === "pairing") {
        readChannelAllowFromStore.mockResolvedValue([]);
        upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
      }
      const senderId = dmPolicy === "pairing" ? Number(`${Date.now()}02`.slice(-9)) : 999;
      const fetchSpy = autoRestore(vi.spyOn(globalThis, "fetch")).mockImplementation(
        async () =>
          new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
      );
      const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

      await createTelegramBot({
        token: "tok",
        ...(dmPolicy === "pairing" ? { testTimings: TELEGRAM_TEST_TIMINGS } : {}),
      });
      const handler = getMessageHandler();

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 412,
          ...(dmPolicy === "pairing" ? { media_group_id: "dm-album-1" } : {}),
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: senderId, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      if (dmPolicy === "pairing") {
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
        expectIncludes(pairingText, "Pairing code:", "<pre><code>");
        expect(sendMessageSpy.mock.calls.at(0)?.[2]).toMatchObject({ parse_mode: "HTML" });
      } else {
        expect(sendMessageSpy).not.toHaveBeenCalled();
      }
      expect(replySpy).not.toHaveBeenCalled();
    },
  );

  it("dedupes duplicate updates for callback_query, message, and channel_post", async () => {
    configureInbound(
      {},
      {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: { "-100777111222": { enabled: true, requireMention: false } },
      },
    );

    await createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    const messageHandler = getMessageHandler();
    const channelPostHandler = getOnHandler("channel_post");

    const callbackCtx = (id: string, data: string) =>
      makeCallback(id, data, {
        updateId: 222,
        messageId: 9001,
        from: { id: 789, username: "testuser" },
        message: { chat: { id: 123, type: "private" } },
      });
    const resolveQuestion = autoRestore(
      vi.spyOn(questionGatewayRuntime, "resolveOption"),
    ).mockRejectedValue(new Error("Unexpected duplicate question resolution"));

    // Admission owns dedupe state; the duplicate handler must still acknowledge its button.
    await runTelegramMiddlewareChain(callbackCtx("cb-1", "ping"), callbackHandler);
    await callbackHandler(
      callbackCtx("cb-question-duplicate", "tgq1:ask_0123456789abcdef0123456789abcdef:1"),
    );
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cb-question-duplicate");
    expect(resolveQuestion).not.toHaveBeenCalled();

    replySpy.mockClear();

    for (let attempt = 0; attempt < 2; attempt++) {
      await messageHandler(
        makePrivateTextContext({
          updateId: 111,
          chatId: 123,
          from: { id: 456, username: "testuser" },
          text: "hello",
          messageId: 42,
          downloadable: true,
        }),
      );
    }
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    for (let attempt = 0; attempt < 2; attempt++) {
      await channelPostHandler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
          message_id: 777,
          text: "wake check",
          date: 1736380800,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });
    }
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes a replayed Telegram message after handler recreation while dispatch is pending", async () => {
    configureOpenDm();

    const firstDispatchStarted = createDeferred<void>();
    const finishFirstDispatch = createDeferred<void>();
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      firstDispatchStarted.resolve();
      await finishFirstDispatch.promise;
      return undefined;
    });

    const replayedCtx = () =>
      makePrivateTextContext({
        updateId: 8488602,
        chatId: 123,
        from: { id: 456, username: "testuser" },
        text: "replay while pending",
        messageId: 43,
        downloadable: true,
      });

    await createTelegramBot({ token: "tok" });
    const firstRun = getMessageHandler()(replayedCtx());
    await firstDispatchStarted.promise;
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()(replayedCtx());

    expect(replySpy).toHaveBeenCalledTimes(1);
    finishFirstDispatch.resolve();
    await firstRun;
    await getMessageHandler()(replayedCtx());
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("settles recorded dispatch failures during polling", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 500,
    });
    const update = { update_id: 501 };
    const dispatchError = new Error("dispatch exploded");
    await runMiddlewareChain({ update }, async () => {
      recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: dispatchError });
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501]);
    await runMiddlewareChain({ update: { update_id: 502 } }, async () => {});
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501, 502]);
  });

  it("retries a deferred spooled update after its queued turn is abandoned", async () => {
    configureOpenDm();
    // The first dispatch hydrates the per-test message cache before getReply
    // runs; wait on the lifecycle itself instead of racing a polling timeout.
    const queuedReply = captureDeferredReply();
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.turnAdoptionLifecycle?.onAdopted?.();
      return { text: "recovered" };
    });
    const { onUpdateId } = await setupUpdateOffsetTracker({ lastUpdateId: 701 });
    const messageHandler = getMessageHandler();

    const retryMessage = {
      updateId: 702,
      messageId: 702,
      text: "retry after queued turn abandonment",
    };
    const replay = () => dispatchSpooledPrivateText(messageHandler, retryMessage);
    const firstReplayPromise = replay();
    const { turnAdoptionLifecycle: queuedLifecycle } = await queuedReply;
    expect(queuedLifecycle?.onAbandoned).toEqual(expect.any(Function));
    queuedLifecycle?.onAbandoned?.();
    const firstReplay = await firstReplayPromise;
    const firstDeferredWork = requireValue(firstReplay.deferredWork, "first deferred spooled work");
    await expect(firstDeferredWork.task).resolves.toMatchObject({ kind: "failed-retryable" });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    const secondReplay = await replay();
    const secondDeferredWork = requireValue(
      secondReplay.deferredWork,
      "second deferred spooled work",
    );
    await expect(secondDeferredWork.task).resolves.toEqual({ kind: "completed" });
    await flushTelegramTestMicrotasks();
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([702]);

    const duplicateReplay = await replay();
    expect(duplicateReplay.deferredWork).toBeUndefined();
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("reloads topic agent overrides between messages without recreating the bot", async () => {
    let topicAgentId = "topic-a";
    const configForTopicAgent = () => ({
      session: { typingMode: "never" },
      messages: { inbound: { debounceMs: 0 } },
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          direct: {
            "123": { topics: { "99": { agentId: topicAgentId } } },
            "124": { topics: { "99": { agentId: topicAgentId } } },
          },
        },
      },
      agents: { entries: { "topic-a": {}, "topic-b": {} } },
      bindings: [{ agentId: "topic-a", match: { channel: "telegram", accountId: "default" } }],
    });
    loadConfig.mockImplementation(configForTopicAgent);

    await createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    replySpy.mockImplementation(async () => undefined);

    const sendTopicMessage = async (chatId: number, messageId: number, text: string) => {
      await handler({
        ...makePrivateTextContext({
          chatId,
          messageId,
          text,
          from: { id: chatId, username: `user${chatId}` },
          date: 1736380800 + messageId,
          message: { message_thread_id: 99 },
          downloadable: true,
        }),
        me: { username: "openclaw_bot", has_topics_enabled: true },
      });
    };

    await sendTopicMessage(123, 44, "topic one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expectIncludes(reply(0).SessionKey, "agent:topic-a:", "thread:123:99");

    topicAgentId = "topic-b";
    await sendTopicMessage(124, 45, "topic two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expectIncludes(reply(1).SessionKey, "agent:topic-b:", "thread:124:99");
  });

  it("authorizes and routes channel-DM messages with the canonical topic identity", async () => {
    const chatId = -100123456700;
    configureInbound(
      { agents: { entries: { "channel-topic-agent": {} } } },
      {
        groupPolicy: "allowlist",
        groupAllowFrom: ["701"],
        groups: {
          [String(chatId)]: {
            allowFrom: ["701"],
            requireMention: false,
            topics: {
              "77": { agentId: "channel-topic-agent", allowFrom: ["700"], requireMention: false },
            },
          },
        },
      },
    );

    await dispatchMessage({
      me: { id: 999, username: "openclaw_bot" },
      message: {
        chat: { id: chatId, type: "supergroup", title: "Channel Inbox", is_direct_messages: true },
        from: { id: 700, first_name: "Ada" },
        text: "route this topic",
        date: 1736380800,
        message_id: 7700,
        direct_messages_topic: { topic_id: 77 },
        message_thread_id: 999,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = reply();
    expect(payload).toMatchObject({
      MessageThreadId: 77,
      OriginatingTo: `telegram:${chatId}:direct-topic:77`,
    });
    expectIncludes(payload.SessionKey, "agent:channel-topic-agent:", ":direct-topic:77");
  });

  it.each([
    {
      name: "topic allows and base chat denies",
      baseAllowFrom: ["701"],
      topicAllowFrom: ["700"],
      expectedCalls: 1,
    },
    {
      name: "topic denies and base chat allows",
      baseAllowFrom: ["700"],
      topicAllowFrom: ["701"],
      expectedCalls: 0,
    },
  ])("authorizes channel-DM callbacks from the canonical topic: $name", async (testCase) => {
    const chatId = -100123456701;
    const pluginHandler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractive("channel-topic-actions", "channel-topic", pluginHandler)).toEqual({
      ok: true,
    });
    configureInbound(
      {},
      {
        groupPolicy: "allowlist",
        groupAllowFrom: testCase.baseAllowFrom,
        groups: {
          [String(chatId)]: {
            allowFrom: testCase.baseAllowFrom,
            topics: { "77": { allowFrom: testCase.topicAllowFrom } },
          },
        },
      },
    );

    await createTelegramBot({ token: "tok" });
    await getCallbackHandler()({
      ...makeCallback(`channel-topic-${testCase.expectedCalls}`, "channel-topic:run", {
        from: { id: 700, first_name: "Ada" },
        messageId: 7701,
        message: {
          chat: {
            id: chatId,
            type: "supergroup",
            title: "Channel Inbox",
            is_direct_messages: true,
          },
          direct_messages_topic: { topic_id: 77 },
          message_thread_id: 999,
        },
      }),
      me: { id: 999, username: "openclaw_bot" },
    });

    expect(pluginHandler).toHaveBeenCalledTimes(testCase.expectedCalls);
  });

  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
  }) {
    await createTelegramBot({ token: "tok" });
    await getMessageHandler()({
      message: params.message,
      me: params.me ?? { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
  }

  const groupMessage = {
    chat: { id: -100123456789, type: "group", title: "Test Group" },
    from: { id: 123456789, username: "testuser" },
    text: "hello",
    date: 1736380800,
  };
  const groupConfig = (
    groupPolicy: "open" | "allowlist",
    requireMention: boolean,
  ): TelegramConfig => ({ groupPolicy, groups: { "*": { requireMention } } });
  const groupGateCases: Array<
    [
      string,
      TelegramConfig,
      {
        message?: Record<string, unknown>;
        me?: Record<string, unknown>;
        storeAllowFrom?: string[];
        immediate?: boolean;
        expected?: number;
      },
    ]
  > = [
    [
      "no bot username",
      groupConfig("open", true),
      {
        message: {
          message_id: 1,
          chat: { id: 789, type: "group", title: "No Me" },
          text: "hello",
          date: 1736380800,
        },
        me: {},
        expected: 1,
        immediate: true,
      },
    ],
    ["allowlist without groupAllowFrom", groupConfig("allowlist", false), {}],
    [
      "groups map without wildcard",
      { groups: { "123": { requireMention: false } } },
      {
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "@openclaw_bot hello",
          date: 1736380800,
        },
      },
    ],
    [
      "DM pairing cannot override group sender allowlist",
      {
        ...groupConfig("allowlist", false),
        groupAllowFrom: ["222222222"],
      },
      { storeAllowFrom: ["123456789"], immediate: true },
    ],
  ];
  it.each(groupGateCases)("enforces group policy: %s", async (_name, telegram, options) => {
    const { message = groupMessage, me, storeAllowFrom, immediate, expected = 0 } = options;
    configureTelegram(telegram, immediate ? { messages: { inbound: { debounceMs: 0 } } } : {});
    if (storeAllowFrom) {
      readChannelAllowFromStore.mockResolvedValueOnce(storeAllowFrom);
    }
    await dispatchMessage({ message, me });
    expect(replySpy).toHaveBeenCalledTimes(expected);
  });
  it("routes generic-path control commands as text slash when native commands are off", async () => {
    onSpy.mockClear();
    configureInbound({ commands: { text: false, native: false } });

    await createTelegramBot({ token: "tok" });
    await getMessageHandler()(
      makePrivateTextContext({ chatId: 1234, text: "/compact", messageId: 5, downloadable: true }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = reply();
    expect(payload).toMatchObject({
      CommandSource: "text",
      CommandTurn: { kind: "text-slash", source: "text", authorized: true },
    });
  });

  it("retries model callback updates after a bubbled preflight failure", async () => {
    configureInbound({ agents: { defaults: { model: "openai/gpt-5.4" } } });

    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as BuildModelsProviderDataMock;

    await createTelegramBot({ token: "tok" });
    const ctx = makeCallback("cbq-model-retry-1", "mdl_prov", { updateId: 666, messageId: 18 });

    buildModelsProviderDataMock.mockImplementationOnce(async () => {
      throw new Error("providers boom");
    });
    await expect(runCallback(ctx)).rejects.toThrow("providers boom");
    await runCallback(ctx);

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls.at(0)?.slice(2)).toMatchObject([
      expect.stringContaining("Select a provider:"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "openai (1)", callback_data: "mdl_list_openai_1" }]],
        },
      },
    ]);
  });

  it("settles command pagination after a permanent edit failure", async () => {
    const onUpdateId = vi.fn();
    await createTelegramBot({ token: "tok", updateOffset: { lastUpdateId: 776, onUpdateId } });
    const ctx = makeCallback("cbq-commands-edit-1", "commands_page_2:main", {
      updateId: 777,
      messageId: 20,
    });
    editMessageTextSpy.mockRejectedValueOnce(
      new Error("400: Bad Request: message can't be edited"),
    );
    await expect(runCallback(ctx)).resolves.toBeUndefined();
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(777);
    await runCallback(ctx);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("retries plugin binding approval callbacks after a bubbled resolution failure", async () => {
    await createTelegramBot({ token: "tok" });
    const resolvePluginBindingApprovalSpy = autoRestore(
      vi.spyOn(conversationRuntime, "resolvePluginConversationBindingApproval"),
    );
    resolvePluginBindingApprovalSpy.mockRejectedValueOnce(new Error("binding boom"));

    const ctx = makeCallback(
      "cbq-plugin-binding-retry-1",
      buildPluginBindingApprovalCustomId("binding-1", "allow-once"),
      { updateId: 888, messageId: 20, text: "Plugin approval required." },
    );

    await expect(runCallback(ctx)).rejects.toThrow("binding boom");
    await runCallback(ctx);

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls.at(0)?.[1]).toContain("plugin bind approval");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
