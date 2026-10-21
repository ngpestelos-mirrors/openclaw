import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { issuePairingChallenge } from "./pairing-challenge.js";

describe("issuePairingChallenge", () => {
  function issue(
    code: string,
    overrides: Partial<Parameters<typeof issuePairingChallenge>[0]> = {},
  ) {
    return issuePairingChallenge({
      channel: "forum",
      senderId: "123",
      senderIdLine: "Your forum user id: 123",
      upsertPairingRequest: async () => ({ code, created: true }),
      sendPairingReply: async () => {},
      ...overrides,
    });
  }
  function hooks(...entries: Parameters<typeof createMockPluginRegistry>[0]) {
    initializeGlobalHookRunner(createMockPluginRegistry(entries));
  }

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("supports custom reply text builder", async () => {
    const sendPairingReply = vi.fn(async (_text: string) => {});
    const result = await issue("ZXCV", {
      buildReplyText: ({ code }) => `custom ${code}`,
      sendPairingReply,
    });
    expect(result).toEqual({ created: true, code: "ZXCV" });
    expect(sendPairingReply.mock.calls).toEqual([["custom ZXCV"]]);
  });

  it("calls onCreated and forwards meta to upsert", async () => {
    const onCreated = vi.fn();
    const upsertPairingRequest = vi.fn(async () => ({ code: "1111", created: true }));
    const result = await issue("1111", {
      meta: { name: "alice" },
      upsertPairingRequest,
      onCreated,
    });
    expect(result).toEqual({ created: true, code: "1111" });
    expect(upsertPairingRequest).toHaveBeenCalledWith({ id: "123", meta: { name: "alice" } });
    expect(onCreated).toHaveBeenCalledWith({ code: "1111" });
  });

  it("captures reply errors through onReplyError", async () => {
    const error = new Error("send failed");
    const onReplyError = vi.fn();
    const result = await issue("9999", {
      onReplyError,
      sendPairingReply: async () => {
        throw error;
      },
    });
    expect(result).toEqual({ created: true, code: "9999" });
    expect(onReplyError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("fires channel_pairing_requested only for newly created requests", async () => {
    const handler = vi.fn(async () => {});
    hooks({ hookName: "channel_pairing_requested", handler });

    await issue("HOOK1234", {
      accountId: "alerts",
      meta: { username: "alice" },
    });
    await issue("EXISTS12", {
      accountId: "alerts",
      upsertPairingRequest: async () => ({ code: "EXISTS12", created: false }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        channel: "forum",
        accountId: "alerts",
        senderId: "123",
        code: "HOOK1234",
        metadata: { username: "alice" },
      },
      { channelId: "forum", accountId: "alerts", senderId: "123" },
    );
  });

  it("does not block pairing replies when pairing-request hooks fail or stall", async () => {
    const throwingHook = vi.fn(() => {
      throw new Error("notification failed");
    });
    const stallingHook = vi.fn(() => new Promise<void>(() => {}));
    hooks(
      { hookName: "channel_pairing_requested", handler: throwingHook, pluginId: "throwing" },
      { hookName: "channel_pairing_requested", handler: stallingHook, pluginId: "stalling" },
    );
    const sendPairingReply = vi.fn(async () => {});

    const result = await issue("FAST1234", { sendPairingReply });

    expect(result).toEqual({ created: true, code: "FAST1234" });
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(stallingHook).toHaveBeenCalledTimes(1);
    expect(sendPairingReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("FAST1234"));
  });
});
