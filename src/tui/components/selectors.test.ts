import { describe, expect, it } from "vitest";
import { modelSelectItems, createSearchableSelectList } from "./selectors.js";

describe("modelSelectItems", () => {
  it("collapses only non-recommended models of providers that recommend some", () => {
    const items = modelSelectItems(
      [
        { provider: "alpha", id: "a1", name: "a1", recommended: true },
        { provider: "alpha", id: "a2", name: "a2" },
        { provider: "alpha", id: "a3", name: "a3" },
        { provider: "beta", id: "b1", name: "b1" },
        { provider: "beta", id: "b2", name: "b2" },
      ],
      "alpha/a3",
    );

    expect(items.map((item) => [item.value, item.collapsed ?? false])).toEqual([
      ["alpha/a1", false],
      ["alpha/a3", false],
      ["beta/b1", false],
      ["beta/b2", false],
      ["all-models", false],
      ["alpha/a2", true],
    ]);
    expect(items[4]?.label).toBe("All models (1)");
  });
});

it("retains an authoritative empty recommendation set, selected exception and searchable folded rows", () => {
  const models = [
    { provider: "nvidia", id: "selected", name: "Selected", recommended: false },
    { provider: "nvidia", id: "folded", name: "Folded", recommended: false },
    { provider: "other", id: "ordinary", name: "Ordinary" },
  ];
  const items = modelSelectItems(models, "nvidia/selected");
  expect(items.map((item) => [item.value, item.collapsed ?? false])).toEqual([
    ["nvidia/selected", false],
    ["other/ordinary", false],
    ["all-models", false],
    ["nvidia/folded", true],
  ]);
  const list = createSearchableSelectList(items);
  expect(list.render(100).join("\n")).not.toContain("nvidia/folded");
  list.handleInput("folded");
  expect(list.render(100).join("\n")).toContain("nvidia/folded");
});
