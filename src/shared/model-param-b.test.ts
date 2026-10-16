// Model parameter B tests cover reasoning budget normalization and aliases.
import { describe, expect, it } from "vitest";
import { inferParamBFromIdOrName, isSmallModel } from "./model-param-b.js";

describe("shared/model-param-b", () => {
  it.each([
    [{ id: "qwen2.5-coder:1.5b-instruct" }, true],
    [{ id: "qwen3:4b" }, true],
    [{ id: "model", name: "Dense 32B" }, true],
    [{ id: "model", parameterCount: 32_000_000_000 }, true],
    [{ id: "model", parameterCount: 32_000_000_001 }, false],
    [{ id: "model-4b", parameterCount: 70_000_000_000 }, false],
    [{ id: "model-70b", parameterCount: 4_000_000_000 }, true],
    [{ id: "qwen3-235b-a22b" }, false],
    [{ id: "model", name: "Unknown size" }, false],
  ] as const)("classifies total model size for %j", (model, expected) => {
    expect(isSmallModel(model)).toBe(expected);
  });

  it("extracts the largest valid b-sized parameter token", () => {
    expect(inferParamBFromIdOrName("llama-8b mixtral-22b")).toBe(22);
    expect(inferParamBFromIdOrName("Qwen 0.5B Instruct")).toBe(0.5);
    expect(inferParamBFromIdOrName("prefix M7B and q4_32b")).toBe(32);
    expect(inferParamBFromIdOrName("(70b) + m1.5b + qwen-14b")).toBe(70);
  });

  it("matches both tokens when two are separated by a single delimiter", () => {
    expect(inferParamBFromIdOrName("8b 70b")).toBe(70);
    expect(inferParamBFromIdOrName("8b-70b")).toBe(70);
    expect(inferParamBFromIdOrName("7b-13b")).toBe(13);
  });

  it("ignores malformed, zero, and non-delimited matches", () => {
    expect(inferParamBFromIdOrName("abc70beta 0b x70b2")).toBeNull();
    expect(inferParamBFromIdOrName("model 0b")).toBeNull();
    expect(inferParamBFromIdOrName("model b5")).toBeNull();
    expect(inferParamBFromIdOrName("foo70bbar")).toBeNull();
    expect(inferParamBFromIdOrName("ab7b model")).toBeNull();
  });
});
