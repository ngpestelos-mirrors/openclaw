import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { collapseWhitespace } from "@openclaw/normalization-core/string-normalization";

/** Concatenates plain text blocks without changing their whitespace or separators. */
export function extractPlainTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    const candidate = asOptionalObjectRecord(block);
    if (candidate?.type === "text" && typeof candidate.text === "string") {
      text += candidate.text;
    }
  }
  return text;
}

/** Coerces arbitrary provider content values into displayable text without throwing. */
export function coerceChatContentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol"
  ) {
    return String(value);
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "";
    }
  }
  return "";
}

/** Extracts normalized plain text from string content or OpenAI-style text blocks. */
export function extractTextFromChatContent(
  content: unknown,
  opts?: {
    sanitizeText?: (text: string) => string;
    joinWith?: string;
    normalizeText?: (text: string) => string;
  },
): string | null {
  const normalize = opts?.normalizeText ?? collapseWhitespace;
  const joinWith = opts?.joinWith ?? " ";
  const sanitize = (text: unknown): string => {
    const raw = coerceChatContentText(text);
    return opts?.sanitizeText ? opts.sanitizeText(raw) : raw;
  };

  if (typeof content === "string") {
    const value = sanitize(content);
    const normalized = normalize(value);
    return normalized ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const chunks: string[] = [];
  for (const block of content) {
    const candidate = asOptionalObjectRecord(block);
    // Non-text blocks can contain media or tool payloads; callers here need visible text only.
    if (candidate?.type !== "text") {
      continue;
    }
    const value = sanitize(candidate.text);
    if (value.trim()) {
      chunks.push(value);
    }
  }

  const joined = normalize(chunks.join(joinWith));
  return joined ? joined : null;
}
