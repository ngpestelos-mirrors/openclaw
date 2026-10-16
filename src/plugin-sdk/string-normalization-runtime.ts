/**
 * Browser-safe record/string normalization and literal text rendering.
 */
export {
  ensureRecord,
  hasOnlyKeys,
  isStringArray,
  normalizeOptionalTrimmedStringRecord,
} from "../../packages/normalization-core/src/record-coerce.js";
export {
  containsAsciiControlCharacter,
  collapseWhitespace,
  collapseWhitespaceLower,
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "../../packages/normalization-core/src/string-normalization.js";
export { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
export { escapeHtmlText } from "../shared/html-escape.js";
export { extractPlainTextContent } from "../shared/chat-content.js";
export { escapeChatDisplayText, sanitizeChatDisplayText } from "../shared/text/chat-display.js";
export { shellEscape, shellEscapeBackslash } from "../shared/shell-quote.js";
