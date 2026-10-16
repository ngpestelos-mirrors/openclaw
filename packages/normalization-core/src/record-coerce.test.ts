import { describe, expect, it } from "vitest";
import {
  asNonArrayRecord,
  asNullableRecord,
  asOptionalRecord,
  ensureRecord,
  filterStringRecord,
  hasOnlyKeys,
  isStringArray,
  isStringRecord,
  normalizeOptionalTrimmedStringRecord,
} from "./record-coerce.js";

describe("record-coerce", () => {
  it("checks only present own enumerable keys against the allowed set", () => {
    const allowed = new Set(["allowed", "optional"]);
    expect(hasOnlyKeys({}, allowed)).toBe(true);
    expect(hasOnlyKeys({ allowed: true }, allowed)).toBe(true);
    expect(hasOnlyKeys({ unexpected: true }, allowed)).toBe(false);
    const inherited = Object.assign(Object.create({ unexpected: true }), { allowed: true });
    expect(hasOnlyKeys(inherited, allowed)).toBe(true);
  });

  it("retains an existing nested record and installs a fresh record for other values", () => {
    const existing = { enabled: true };
    const parent: Record<string, unknown> = { existing, array: ["value"], scalar: 1 };
    expect(ensureRecord(parent, "existing")).toBe(existing);
    const arrayReplacement = ensureRecord(parent, "array");
    const scalarReplacement = ensureRecord(parent, "scalar");
    const missingReplacement = ensureRecord(parent, "missing");
    expect(parent).toEqual({ existing, array: {}, scalar: {}, missing: {} });
    expect(parent.array).toBe(arrayReplacement);
    expect(parent.scalar).toBe(scalarReplacement);
    expect(parent.missing).toBe(missingReplacement);
    expect(arrayReplacement).not.toBe(scalarReplacement);
    expect(scalarReplacement).not.toBe(missingReplacement);
    expect(Object.getPrototypeOf(missingReplacement)).toBe(Object.prototype);
  });

  it.each([
    { value: [], expected: true },
    { value: ["", " ", "value"], expected: true },
    { value: ["value", 1], expected: false },
    { value: "value", expected: false },
    { value: { 0: "value", length: 1 }, expected: false },
    { value: null, expected: false },
  ])("checks string arrays without normalizing entries", ({ value, expected }) => {
    expect(isStringArray(value)).toBe(expected);
  });

  it("keeps record coercion behavior for optional and nullable variants", () => {
    expect(asOptionalRecord({ ok: true })).toEqual({ ok: true });
    expect(asOptionalRecord(null)).toBeUndefined();
    expect(asOptionalRecord([{ ok: true }])).toBeUndefined();
    expect(asNullableRecord({ ok: true })).toEqual({ ok: true });
    expect(asNullableRecord(null)).toBeNull();
    expect(asNullableRecord([{ ok: true }])).toBeNull();
  });

  it("preserves accepted record identity and returns fresh ordinary fallbacks", () => {
    class ExampleRecord {
      marker = true;
    }
    const record = Object.create(null) as Record<string, unknown>;
    const date = new Date();
    const instance = new ExampleRecord();
    const firstFallback = asNonArrayRecord(null);
    const secondFallback = asNonArrayRecord([]);

    expect(asNonArrayRecord(record)).toBe(record);
    expect(asNonArrayRecord(date)).toBe(date);
    expect(asNonArrayRecord(instance)).toBe(instance);
    expect(firstFallback).toEqual({});
    expect(Object.getPrototypeOf(firstFallback)).toBe(Object.prototype);
    expect(secondFallback).toEqual({});
    expect(secondFallback).not.toBe(firstFallback);
  });

  it("preserves the canonical proxy trap behavior", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => asNonArrayRecord(proxy)).toThrow(TypeError);
    expect(() => isStringRecord(proxy)).toThrow(TypeError);
  });

  it.each([
    { value: { first: "one", second: "two" }, expected: true },
    { value: Object.assign(Object.create(null), { first: "one" }), expected: true },
    { value: new Date(), expected: true },
    { value: { first: "one", second: 2 }, expected: false },
    { value: ["one"], expected: false },
    { value: null, expected: false },
  ])("validates all-or-nothing string records", ({ value, expected }) => {
    expect(isStringRecord(value)).toBe(expected);
  });

  it.each([null, undefined, [], "value", 1, {}, { count: 1, blank: "  " }])(
    "omits invalid or empty trimmed string records from %j",
    (value) => {
      expect(normalizeOptionalTrimmedStringRecord(value)).toBeUndefined();
    },
  );

  it("trims string values without changing keys or mutating the input record", () => {
    const input: Record<string, unknown> = Object.assign(Object.create({ inherited: "skip" }), {
      " key ": " value ",
      blank: " \t ",
      count: 2,
      second: " two ",
    });
    Object.defineProperty(input, "hidden", { value: "skip", enumerable: false });

    const result = normalizeOptionalTrimmedStringRecord(input);

    expect(result).toEqual({ " key ": "value", second: "two" });
    expect(Object.keys(result ?? {})).toEqual([" key ", "second"]);
    expect(input[" key "]).toBe(" value ");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("preserves ordinary assignment semantics for reserved record keys", () => {
    const input: unknown = JSON.parse(
      '{"__proto__":" ignored ","constructor":" ctor ","prototype":" proto "}',
    );
    const result = normalizeOptionalTrimmedStringRecord(input);

    expect(result).toEqual({ constructor: "ctor", prototype: "proto" });
    expect(Object.hasOwn(result ?? {}, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(
      normalizeOptionalTrimmedStringRecord(JSON.parse('{"__proto__":" ignored "}')),
    ).toBeUndefined();
  });

  const inheritedAndHidden = Object.create({ inherited: "skip" }) as Record<string, unknown>;
  Object.defineProperty(inheritedAndHidden, "hidden", { value: "skip", enumerable: false });
  Object.assign(inheritedAndHidden, {
    blank: "",
    ignored: 1,
    whitespace: "  ",
    first: "same",
    second: "same",
  });

  it.each([
    { value: null, expected: undefined },
    { value: ["value"], expected: undefined },
    { value: { count: 1, enabled: true }, expected: undefined },
    {
      value: inheritedAndHidden,
      expected: { blank: "", whitespace: "  ", first: "same", second: "same" },
    },
  ])("filters string-valued record entries from $value", ({ value, expected }) => {
    const result = filterStringRecord(value);

    expect(result).toEqual(expected);
    expect(result ? Object.keys(result) : undefined).toEqual(
      expected ? Object.keys(expected) : undefined,
    );
  });
});
