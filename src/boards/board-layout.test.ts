import { describe, expect, it } from "vitest";
import {
  applyBoardOps,
  BoardValidationError,
  insertBoardWidget,
  normalizeBoardLayout,
} from "./board-layout.js";

type BoardLayout = Parameters<typeof normalizeBoardLayout>[0];

function makeWidget(name: string, tabId: string, position: number): BoardLayout["widgets"][number] {
  return {
    name,
    tabId,
    position,
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    grantState: "none",
    revision: 1,
  };
}
const apply = (...ops: Parameters<typeof applyBoardOps>[1]) => applyBoardOps(layout(), ops);
const tabIds = (state: BoardLayout) => state.tabs.map((tab) => tab.tabId);

function layout(): BoardLayout {
  return {
    tabs: [
      { tabId: "one", title: "One", position: 4, chatDock: "right" },
      { tabId: "two", title: "Two", position: 8, chatDock: "bottom" },
    ],
    widgets: [
      makeWidget("alpha", "one", 3),
      makeWidget("beta", "one", 9),
      makeWidget("gamma", "two", 2),
    ],
  };
}

function widgetOrder(state: BoardLayout, tabId: string): string[] {
  return state.widgets
    .filter((widget) => widget.tabId === tabId)
    .toSorted((a, b) => a.position - b.position)
    .map((widget) => widget.name);
}

describe("board layout", () => {
  it("keeps nested widget metadata caller-owned across layout operations", () => {
    const original = layout();
    const widget = original.widgets[0]!;
    widget.props = { series: [1, 2] };
    widget.declared = { tools: ["sessions"] };
    widget.declaredSummary = ["Tool access: sessions"];
    const before = structuredClone(original);
    const inserted = { ...widget, name: "inserted" };
    const emptyBatch = applyBoardOps(original, []);
    expect(emptyBatch.tabs.map((tab) => tab.position)).toEqual([0, 1]);
    expect(emptyBatch.widgets.map((item) => item.position)).toEqual([0, 1, 0]);
    const results = [
      normalizeBoardLayout(original),
      applyBoardOps(original, [
        { kind: "widget_resize", name: "alpha", sizeW: 2, sizeH: 3 },
        { kind: "widget_move", name: "alpha", position: 1 },
      ]),
      insertBoardWidget(original, inserted, { tabId: "two" }),
      emptyBatch,
    ];
    for (const result of results) {
      const copied = result.widgets.find((candidate) => candidate.name === "alpha")!;
      copied.props!.series = [9];
      copied.declared!.tools!.push("usage");
      copied.declaredSummary!.push("changed");
      result.tabs[0]!.title = "changed";
    }
    results[2]!.widgets
      .find((candidate) => candidate.name === "inserted")!
      .declared!.tools!.push("cron");
    expect(original).toEqual(before);
    expect(inserted.declared).toEqual({ tools: ["sessions"] });
  });

  it("reorders widgets by position and after anchors, including cross-tab moves", () => {
    const reordered = apply(
      { kind: "widget_move", name: "beta", position: 0 },
      { kind: "widget_move", name: "gamma", tabId: "one", after: "beta" },
    );
    expect(widgetOrder(reordered, "one")).toEqual(["beta", "gamma", "alpha"]);
    expect(widgetOrder(reordered, "two")).toEqual([]);
  });

  it("rejects missing and self after anchors", () => {
    const move = (after: string) => apply({ kind: "widget_move", name: "alpha", after });
    expect(() => move("missing")).toThrow(BoardValidationError);
    expect(() => move("alpha")).toThrow("after itself");
  });

  it("clamps widget sizes to the grid bounds", () => {
    const resized = apply({ kind: "widget_resize", name: "alpha", sizeW: 99, sizeH: -5 });
    expect(resized.widgets.find((widget) => widget.name === "alpha")).toMatchObject({
      sizeW: 12,
      sizeH: 1,
    });
  });

  it("moves deleted-tab widgets to the first remaining tab", () => {
    const next = apply({ kind: "tab_delete", tabId: "one" });
    expect(tabIds(next)).toEqual(["two"]);
    expect(widgetOrder(next, "two")).toEqual(["gamma", "alpha", "beta"]);
  });

  it("allows deleting the last empty tab but rejects deleting it with widgets", () => {
    const state = layout();
    state.tabs = state.tabs.slice(0, 1);
    state.widgets = state.widgets.slice(0, 1);
    const remove = () => applyBoardOps(state, [{ kind: "tab_delete", tabId: "one" }]);
    expect(remove).toThrow("last board tab");
    state.widgets = [];
    expect(remove().tabs).toEqual([]);
  });

  it("requires tabs_reorder to be an exact permutation", () => {
    const reorder = (ids: string[]) => apply({ kind: "tabs_reorder", tabIds: ids });
    expect(tabIds(reorder(["two", "one"]))).toEqual(["two", "one"]);
    expect(() => reorder(["one", "one"])).toThrow("every tab exactly once");
  });
});
