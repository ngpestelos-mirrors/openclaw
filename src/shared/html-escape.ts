/** Escapes ampersands and tag delimiters without changing literal quotes. */
export function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes text for safe insertion into HTML text and quoted attribute values. */
export function escapeHtml(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
