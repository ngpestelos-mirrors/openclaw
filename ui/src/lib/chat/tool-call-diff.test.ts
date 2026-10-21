// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildWriteDiffLines,
  computeLineDiff,
  joinDiffSections,
  parseDiffDetailsString,
  type DiffLine,
} from "./tool-call-diff.ts";

const skip: DiffLine = { kind: "skip", text: "" };
const source = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
const context = (texts: string[]): DiffLine[] => texts.map((text) => ({ kind: "ctx", text }));
function expectUnchanged(texts: string[], lines = context(texts)) {
  const body = texts.join("\n");
  expect(computeLineDiff(body, body)).toEqual({
    kind: "complete",
    lines,
    stat: { added: 0, removed: 0 },
  });
}
function changeAt(count: number, index: number, text: string) {
  const before = source(count),
    after = [...before];
  after[index] = text;
  return computeLineDiff(before.join("\n"), after.join("\n"));
}

describe("parseDiffDetailsString", () => {
  it("parses numbered add/del/ctx lines and skip markers", () => {
    const diff = " 455 before\n-456 old line\n+456 new line\n    ...\n 460 after";
    expect(parseDiffDetailsString(diff)).toEqual({
      kind: "complete",
      lines: [
        { kind: "ctx", lineNo: 455, text: "before" },
        { kind: "del", lineNo: 456, text: "old line" },
        { kind: "add", lineNo: 456, text: "new line" },
        skip,
        { kind: "ctx", lineNo: 460, text: "after" },
      ],
      stat: { added: 1, removed: 1 },
    });
  });

  it.each([
    ["whitespace-only input", "   \n  "],
    ["no added or removed lines", " 1 only context\n 2 more context"],
  ])("returns null for %s", (_label, diff) => {
    expect(parseDiffDetailsString(diff)).toBeNull();
  });

  it("truncates oversized diffs with a trailing skip line", () => {
    const diff = Array.from({ length: 450 }, (_, i) => `+${i + 1} line ${i + 1}`).join("\n");

    const lines = parseDiffDetailsString(diff);

    expect(lines).toMatchObject({ kind: "truncated" });
    expect(lines?.lines).toHaveLength(402);
    expect(lines?.lines.at(-1)).toEqual(skip);
  });
});

describe("computeLineDiff", () => {
  it("retains complete statistics for wholly replaced bounded inputs", () => {
    const oldText = source(600, "old").join("\n");
    const newText = source(600, "new").join("\n");
    const result = computeLineDiff(oldText, newText);
    expect(result).toMatchObject({ kind: "complete", stat: { added: 600, removed: 600 } });
    expect(result.lines).toHaveLength(401);
    expect(result.lines.at(-1)).toEqual(skip);
  });

  it("reports an incomplete comparison when the only change is beyond the work budget", () => {
    expect(changeAt(700, 650, "outside budget")).toMatchObject({
      kind: "truncated",
      lines: [skip],
    });
  });

  it("returns exact zero statistics for a normal unchanged comparison", () => {
    expectUnchanged(["alpha", "beta"]);
    expectUnchanged(source(700), [...context(source(400)), skip]);
  });

  it("keeps a late change instead of spending the preview budget on context", () => {
    const { lines } = changeAt(500, 450, "changed late");
    expect(lines).toContainEqual({ kind: "add", text: "changed late" });
    expect(lines).toContainEqual({ kind: "del", text: "line 450" });
    expect(lines.length).toBeLessThanOrEqual(401);
  });
});

it("buildWriteDiffLines truncates past 80 lines with a skip marker", () => {
  const content = Array.from({ length: 81 }, (_, index) => `line ${index + 1}`).join("\n");
  const lines = buildWriteDiffLines(content);
  expect(lines).toHaveLength(81);
  expect(lines[0]).toEqual({ kind: "add", lineNo: 1, text: "line 1" });
  expect(lines[79]).toEqual({ kind: "add", lineNo: 80, text: "line 80" });
  expect(lines[80]).toEqual(skip);
});

it("joinDiffSections separates non-empty sections with skip lines and drops empty ones", () => {
  const first: DiffLine[] = [{ kind: "del", text: "old" }];
  const second: DiffLine[] = [{ kind: "add", text: "new" }];

  expect(
    joinDiffSections([
      { kind: "complete", lines: first, stat: { added: 0, removed: 1 } },
      { kind: "complete", lines: [], stat: { added: 0, removed: 0 } },
      { kind: "complete", lines: second, stat: { added: 1, removed: 0 } },
    ]),
  ).toEqual({
    kind: "complete",
    lines: [...first, skip, ...second],
    stat: { added: 1, removed: 1 },
  });
});
