import { expect, it } from "vitest";
import { escapeHtml, escapeHtmlText } from "./html-escape.js";

it("keeps quote escaping specific to quoted HTML attributes", () => {
  const value = `<a title="Peter's & friends">🦞</a>`;
  expect(escapeHtmlText(value)).toBe(`&lt;a title="Peter's &amp; friends"&gt;🦞&lt;/a&gt;`);
  expect(escapeHtml(value)).toBe(
    "&lt;a title=&quot;Peter&#39;s &amp; friends&quot;&gt;🦞&lt;/a&gt;",
  );
});
