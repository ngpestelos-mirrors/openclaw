import { describe, expect, it } from "vitest";
import {
  applyExistingStreamSchedulePatch as applyPatch,
  resolveCronCreateScheduleFromArgs as createSchedule,
  resolveCronEditScheduleRequest as editSchedule,
} from "./schedule-options.js";

const command = ["node", "events.mjs"];
const streamCommand = JSON.stringify(command);
const existing = { kind: "stream", command, mode: "match", match: "^ready:" } as const;

function patch(options: Parameters<typeof editSchedule>[0], batchMs?: number) {
  const request = editSchedule(options);
  if (request.kind !== "patch-existing-stream") {
    throw new Error("expected stream patch");
  }
  return applyPatch({ ...existing, batchMs }, request);
}

describe("resolveCronCreateScheduleFromArgs --stream-command", () => {
  it("builds an argv stream schedule with batching and match options", () => {
    expect(
      createSchedule({
        streamCommand,
        streamCwd: "/repo",
        streamMode: "match",
        streamMatch: "^ready:",
        streamBatchMs: "100",
        streamMaxBatchBytes: "2048",
      }),
    ).toEqual({
      kind: "stream",
      command,
      cwd: "/repo",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2048,
    });
  });

  it("requires a valid argv array and match expression when requested", () => {
    expect(() => createSchedule({ streamCommand: "node events.mjs" })).toThrow("JSON array");
    expect(() => createSchedule({ streamCommand, streamMode: "match" })).toThrow(
      "--stream-match is required",
    );
  });

  it("rejects stream-only options without a stream command", () => {
    expect(() => createSchedule({ every: "1m", streamBatchMs: "250" })).toThrow(
      "require --stream-command",
    );
  });

  it("patches an existing stream back to line mode without restating argv", () => {
    expect(patch({ streamMode: "line" }, 100)).toEqual({
      kind: "stream",
      command,
      mode: "line",
      match: undefined,
      batchMs: 100,
      cwd: undefined,
      maxBatchBytes: undefined,
    });
  });

  it("defers command replacement metadata checks until existing match settings are merged", () => {
    const replacement = '["node","replacement.mjs"]';
    const commandAndMatch = editSchedule({ streamCommand: replacement, streamMatch: "^updated:" });
    expect(commandAndMatch.kind).toBe("direct");
    expect(patch({ streamMatch: "^updated:" })).toMatchObject({
      mode: "match",
      match: "^updated:",
    });

    expect(() => editSchedule({ streamCommand: replacement, streamMode: "match" })).not.toThrow();
  });

  it("rejects time-schedule modifiers mixed into stream metadata edits", () => {
    expect(() => editSchedule({ streamBatchMs: "100", tz: "UTC" })).toThrow(
      "not valid with stream schedule edits",
    );
    expect(() => editSchedule({ streamMode: "line", exact: true })).toThrow(
      "not valid with stream schedule edits",
    );
  });
});
