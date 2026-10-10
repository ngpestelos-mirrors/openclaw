export const DURABLE_QUESTIONS_SCHEMA_VERSION = 26;

/** Historical contracts must not acquire durable question custody implicitly. */
export function withoutSessionQuestionsSchema(schema: string): string {
  const start = schema.indexOf("CREATE TABLE IF NOT EXISTS session_questions (");
  const end = schema.indexOf("CREATE TABLE IF NOT EXISTS transcript_events (", start);
  if (start < 0 || end < 0) {
    throw new Error("OpenClaw question schema markers are missing.");
  }
  return schema.slice(0, start) + schema.slice(end);
}
