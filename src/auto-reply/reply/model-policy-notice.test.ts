import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { attachModelPolicyNotice } from "./model-policy-notice.js";

const storage = vi.hoisted(() => ({ current: undefined as SessionEntry | undefined }));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: async (
    _scope: object,
    update: (entry: SessionEntry) => Partial<SessionEntry> | null,
  ) => {
    if (!storage.current) {
      return null;
    }
    const patch = update(storage.current);
    if (!patch) {
      return null;
    }
    Object.assign(storage.current, patch);
    return storage.current;
  },
}));

function session(): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    providerOverride: "openai",
    modelOverride: "old-model",
  };
}

function reply(
  entry: SessionEntry,
  payloads: [ReplyPayload, ...ReplyPayload[]] = [{ text: "Answer" }],
) {
  return attachModelPolicyNotice({
    payloads,
    pinnedModel: `${entry.providerOverride}/${entry.modelOverride}`,
    primaryModel: "openai/default-model",
    sessionEntry: entry,
    sessionKey: "agent:main:main",
    storePath: "/tmp/policy-notice-test/sessions.json",
  });
}

beforeEach(() => {
  storage.current = session();
});

describe("model policy reply notice", () => {
  it("preserves the pin and repeats until successful delivery, then stays quiet", async () => {
    const entry = session();
    const first = reply(entry);
    expect(first[0].text).toContain("Pinned model openai/old-model is not in your allow list");
    expect(first[0].text).toContain("used the default (openai/default-model)");
    expect(first[0].text).toContain("Use /model to change it.\n\nAnswer");
    expect(entry.modelPolicyNotice).toBeUndefined();
    expect(reply(entry)[0].text).toBe(first[0].text);
    await getReplyPayloadMetadata(first[0])?.onFinalDeliverySuccess?.();
    expect(storage.current?.modelPolicyNotice).toEqual({
      sessionId: "session-1",
      pinnedModel: "openai/old-model",
    });
    expect(reply(entry)).toEqual([{ text: "Answer" }]);
    expect(entry).toMatchObject({ providerOverride: "openai", modelOverride: "old-model" });
  });

  it.each(["pin", "session"])("does not acknowledge a stale %s after delivery", async (changed) => {
    const entry = session();
    const payload = reply(entry)[0];
    storage.current = {
      ...entry,
      ...(changed === "pin" ? { modelOverride: "different-model" } : { sessionId: "session-2" }),
    };
    await getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess?.();
    expect(storage.current.modelPolicyNotice).toBeUndefined();
    expect(entry.modelPolicyNotice).toBeUndefined();
  });

  it("notifies again after the pin changes or a new session starts", async () => {
    const entry = session();
    await getReplyPayloadMetadata(reply(entry)[0])?.onFinalDeliverySuccess?.();
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "openai", model: "another-model" },
    });
    expect(reply(entry)[0].text).toContain("openai/another-model");
    entry.modelPolicyNotice = { sessionId: "old-session", pinnedModel: "openai/another-model" };
    expect(reply(entry)[0].text).toContain("Use /model");
  });

  it("explains an unavailable primary without consuming the success notice", async () => {
    const entry = session();
    const payload = reply(entry, [{ text: "No credentials", isError: true }])[0];
    expect(payload.text).toContain("configured default could not answer. Use /model");
    expect(payload.text).toContain("No credentials");
    await getReplyPayloadMetadata(payload)?.onFinalDeliverySuccess?.();
    expect(entry.modelPolicyNotice).toBeUndefined();
  });

  it("does not create speech from silence or reasoning", () => {
    const entry = session();
    for (const payload of [{ text: "NO_REPLY" }, { text: "thinking", isReasoning: true }]) {
      expect(reply(entry, [payload])).toEqual([payload]);
    }
    expect(reply(entry, [{ text: "NO_REPLY" }, { text: "Answer" }, { text: "More" }])).toEqual([
      { text: "NO_REPLY" },
      { text: expect.stringContaining("Use /model to change it.\n\nAnswer") },
      { text: "More" },
    ]);
  });
});
