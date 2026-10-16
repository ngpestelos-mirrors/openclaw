import { describe, expect, it } from "vitest";
import { shellEscape, shellEscapeBackslash } from "./shell-quote.js";

describe("POSIX shell argument quoting", () => {
  it.each(["", "plain", "two words", "$HOME; $(printf injected)", "hello\nworld", "🦞"])(
    "preserves literal argument bytes for %j",
    (value) => {
      expect(shellEscape(value)).toBe(`'${value}'`);
      expect(shellEscapeBackslash(value)).toBe(`'${value}'`);
    },
  );

  it("preserves both operator-visible spellings for embedded apostrophes", () => {
    expect(shellEscape("it's 'quoted'")).toBe("'it'\"'\"'s '\"'\"'quoted'\"'\"''");
    expect(shellEscapeBackslash("it's 'quoted'")).toBe("'it'\\''s '\\''quoted'\\'''");
  });
});
