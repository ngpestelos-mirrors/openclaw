import { expect, it } from "vitest";
import { decodeUtf8Input, Utf8InputError } from "./utf8-input.js";

it("preserves valid Unicode and the BOM rather than replacement-decoding", () => {
  const text = "\uFEFFcafé 😀";
  expect(decodeUtf8Input(Buffer.from(text), "fixture")).toBe(text);
});

it.for([[0xff], [0xc3], [0xed, 0xa0, 0x80]])(
  "rejects malformed UTF-8 %j with a stable error code",
  (bytes) => {
    expect(() => decodeUtf8Input(Uint8Array.from(bytes), "fixture")).toThrow(Utf8InputError);
    try {
      decodeUtf8Input(Uint8Array.from(bytes), "fixture");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ERR_INVALID_UTF8",
        message: "fixture must be valid UTF-8.",
      });
    }
  },
);
