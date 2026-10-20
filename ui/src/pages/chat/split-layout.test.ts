// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeChatSplitLayout } from "./split-layout-persistence.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import {
  applyUiCommandToSplitLayout,
  closePane,
  findPane,
  insertPane,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
} from "./split-layout.ts";

const makePane = <Id extends string | number>(id: Id, sessionKey: string) => ({ id, sessionKey });
const makeColumn = <Id extends string | number>(
  id: string,
  panes: { id: Id; sessionKey: string }[],
  paneWeights: number[],
) => ({ id, panes, paneWeights });

function createSinglePaneLayout(sessionKey: string): ChatSplitLayout {
  return {
    columns: [makeColumn("c1", [makePane("p1", sessionKey)], [1])],
    columnWeights: [1],
    activePaneId: "p1",
  };
}

function createSplitLayout(sessionKey: string): ChatSplitLayout {
  return insertPane(createSinglePaneLayout(sessionKey), "p1", sessionKey, "right");
}

function threePaneLayout(): ChatSplitLayout {
  return insertPane(createSplitLayout("main"), "p2", "agent:main:second", "down");
}

describe("chat split layout", () => {
  it.each(["up", "down"] as const)("inserts %s and halves only the target weight", (edge) => {
    const layout = insertPane(createSplitLayout("main"), "p1", edge, edge);
    const panes = [makePane("p1", "main"), makePane("p3", edge)];
    expect(layout.columns[0]?.panes).toEqual(edge === "up" ? panes.toReversed() : panes);
    expect(layout.columns[0]?.paneWeights).toEqual([0.5, 0.5]);
    expect(layout.activePaneId).toBe("p3");
  });

  it("closes panes, collapses columns, and chooses the specified adjacent active pane", () => {
    const layout = threePaneLayout();
    const previousInColumn = closePane(layout, "p3");
    expect(previousInColumn?.activePaneId).toBe("p2");
    expect(previousInColumn?.columns.at(1)?.paneWeights).toEqual([1]);

    const activeFirstInSecondColumn = setActivePane(layout, "p2");
    const previousColumn = closePane(activeFirstInSecondColumn, "p2");
    expect(previousColumn?.activePaneId).toBe("p1");
    expect(previousColumn?.columns.at(1)?.panes).toEqual([makePane("p3", "agent:main:second")]);

    const threeColumns = insertPane(createSplitLayout("main"), "p1", "third", "right");
    const collapsedColumn = closePane(threeColumns, "p3");
    expect(collapsedColumn?.columns.map((column) => column.id)).toEqual(["c1", "c2"]);
    expect(collapsedColumn?.columnWeights.at(0)).toBeCloseTo(1 / 3);
    expect(collapsedColumn?.columnWeights.at(1)).toBeCloseTo(2 / 3);
    expect(collapsedColumn?.activePaneId).toBe("p1");

    const collapsed = closePane(createSplitLayout("main"), "p1");
    expect(collapsed).toBeUndefined();
  });

  it("updates pane session and active pane without mutating the input", () => {
    const layout = createSplitLayout("main");
    const sessionChanged = setPaneSession(layout, "p1", "agent:main:new");
    const activeChanged = setActivePane(sessionChanged, "p1");
    expect(findPane(activeChanged, "p1")?.pane.sessionKey).toBe("agent:main:new");
    expect(activeChanged.activePaneId).toBe("p1");
    expect(layout.columns.at(0)?.panes.at(0)?.sessionKey).toBe("main");
    expect(panesOf(layout)).not.toBe(layout.columns.at(0)?.panes);
  });

  it("maps UI split and focus commands onto pane state", () => {
    const initial = setActivePane(setPaneSession(createSplitLayout("main"), "p2", "source"), "p1");
    const split = applyUiCommandToSplitLayout(
      initial,
      {
        kind: "split",
        direction: "down",
        sessionKey: "agent:main:new",
      },
      "source",
    );
    expect(split && panesOf(split).map((pane) => pane.sessionKey)).toEqual([
      "main",
      "source",
      "agent:main:new",
    ]);
    expect(split?.activePaneId).toBe("p3");

    const focused = applyUiCommandToSplitLayout(split!, {
      kind: "focus",
      sessionKey: "main",
    });
    expect(focused?.activePaneId).toBe("p1");
  });

  it("resizes only a boundary pair and clamps each side to fifteen percent", () => {
    const layout = insertPane(createSplitLayout("main"), "p1", "third", "right");
    const columns = resizeColumns(layout, 0, 0.8);
    expect(columns.columnWeights.at(0)).toBeCloseTo(0.4);
    expect(columns.columnWeights.at(1)).toBeCloseTo(0.1);
    expect(columns.columnWeights.at(2)).toBe(0.5);
    const clampedColumns = resizeColumns(layout, 0, 0.99).columnWeights;
    expect(clampedColumns.at(0)).toBeCloseTo(0.425);
    expect(clampedColumns.at(1)).toBeCloseTo(0.075);
    expect(clampedColumns.at(2)).toBe(0.5);

    const panes = resizePanes(threePaneLayout(), "c2", 0, 0.2);
    expect(panes.columns.at(1)?.paneWeights).toEqual([0.2, 0.8]);
    expect(resizePanes(threePaneLayout(), "c2", 0, -1).columns.at(1)?.paneWeights).toEqual([
      0.15, 0.85,
    ]);
  });

  it("normalizes recoverable input and repairs weights, ids, and active pane", () => {
    expect(
      normalizeChatSplitLayout({
        columns: [
          makeColumn(
            "same",
            [makePane("same", " main "), makePane("same", " second "), makePane("empty", " ")],
            [2, 1, 1],
          ),
          makeColumn("same", [makePane(4, "third")], [0]),
        ],
        columnWeights: [0, 3],
        activePaneId: "missing",
      }),
    ).toEqual({
      columns: [
        makeColumn("same", [makePane("same", "main"), makePane("p1", "second")], [2 / 3, 1 / 3]),
        makeColumn("c1", [makePane("p2", "third")], [1]),
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "same",
    });
  });

  it("returns undefined for unrecoverable values and drops empty columns", () => {
    expect(normalizeChatSplitLayout(null)).toBeUndefined();
    expect(normalizeChatSplitLayout({ columns: "no" })).toBeUndefined();
    expect(normalizeChatSplitLayout({ columns: [] })).toBeUndefined();
    expect(
      normalizeChatSplitLayout({
        columns: [{ id: "c1", panes: [makePane("p1", " ")] }],
      }),
    ).toBeUndefined();
    expect(
      normalizeChatSplitLayout({
        columns: [{ id: "c1", panes: [makePane("p1", "main")] }],
      }),
    ).toBeUndefined();
  });

  it("returns an unchanged clone when the target pane is unknown", () => {
    const layout = createSplitLayout("main");
    const unchanged = insertPane(layout, "missing", "new", "right");
    expect(unchanged).toEqual(layout);
    expect(unchanged).not.toBe(layout);
  });
});
