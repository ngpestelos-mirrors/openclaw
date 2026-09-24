import { createHash } from "node:crypto";
import type { Update } from "grammy/types";
import { expect } from "vitest";

export type TestTelegramMessageUpdate = Update & {
  message: NonNullable<Update["message"]> & { text: string };
};

export function telegramMessageUpdate(updateId: number, text: string): TestTelegramMessageUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_736_380_800,
      from: { id: 111, is_bot: false, first_name: "Ada" },
      chat: { id: 111, type: "private", first_name: "Ada" },
      text,
    },
  };
}

export function createNearLimitTelegramPayload(): { payload: string; sizeBytes: number } {
  const maxBytes = 1_024 * 1_024;
  const targetBytes = maxBytes - 4_096;
  const shell = telegramMessageUpdate(77_777, "");
  const shellSize = Buffer.byteLength(JSON.stringify(shell), "utf-8");
  const textLength = Math.max(1, targetBytes - shellSize);
  const pattern = "the quick brown fox jumps over the lazy dog ";
  const repeats = Math.ceil(textLength / pattern.length);
  const text = pattern.repeat(repeats).slice(0, textLength);
  const payload = JSON.stringify(telegramMessageUpdate(77_777, text));
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf-8") };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function expectSingleNearLimitUpdate(params: {
  seenUpdates: TestTelegramMessageUpdate[];
  expected: TestTelegramMessageUpdate;
}) {
  expect(params.seenUpdates).toHaveLength(1);
  expect(params.seenUpdates[0]?.update_id).toBe(params.expected.update_id);
  expect(params.seenUpdates[0]?.message.text.length).toBe(params.expected.message.text.length);
  expect(sha256(params.seenUpdates[0]?.message.text ?? "")).toBe(
    sha256(params.expected.message.text),
  );
}
