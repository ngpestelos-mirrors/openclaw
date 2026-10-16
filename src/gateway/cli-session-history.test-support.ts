import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hashCliReseedPrompt } from "../agents/cli-runner/reseed-envelope.js";
import type { CliSessionReseedReceipt, SessionEntry } from "../config/sessions.js";
import { withEnvAsync } from "../test-utils/env.js";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";
import {
  resolveClaudeCliHistorySource,
  visitClaudeCliSessionMessages,
  type ClaudeCliHistoryParams,
} from "./cli-session-history.claude-snapshot.js";

export async function readClaudeCliSessionMessagesAsync(
  params: ClaudeCliHistoryParams,
): Promise<Record<string, unknown>[]> {
  const source = await resolveClaudeCliHistorySource(params);
  const messages: Record<string, unknown>[] = [];
  if (source) {
    await visitClaudeCliSessionMessages(
      source[0],
      params,
      (message) => messages.push(message),
      source[2],
    );
  }
  return messages;
}

export function mergeImportedChatHistoryMessages(params: {
  localMessages: unknown[];
  importedMessages: unknown[];
}): unknown[] {
  const index = new CliSessionHistoryIndex();
  try {
    index.appendLocal(
      params.localMessages.map((message, position) => ({ message, seq: position + 1 })),
    );
    for (const message of params.importedMessages) {
      index.appendImported(message);
    }
    index.finish();
    const messages: unknown[] = [];
    for (const row of index.rows(0, index.count)) {
      const message =
        row.local_seq === null ? index.message(row.id) : params.localMessages[row.local_seq - 1];
      const record = asOptionalRecord(message);
      messages.push(
        record
          ? { ...record, ...(row.metadata ? { __openclaw: JSON.parse(row.metadata) } : {}) }
          : message,
      );
    }
    return messages;
  } finally {
    index.close();
  }
}
export function cliMeta(externalId: string, cliSessionId: string | null = "session-1") {
  return {
    importedFrom: "claude-cli",
    externalId,
    ...(cliSessionId === null ? {} : { cliSessionId }),
  };
}

export function answer(
  timestamp?: number,
  externalId?: string,
  cliSessionId: string | null = "session-1",
) {
  return {
    role: "assistant",
    content: "Repeated answer",
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(externalId === undefined ? {} : { __openclaw: cliMeta(externalId, cliSessionId) }),
  };
}

export function boundEntry(sessionId: string): SessionEntry {
  return {
    sessionId: "openclaw-session",
    updatedAt: 1,
    cliSessionBindings: { "claude-cli": { sessionId } },
  };
}

export function receipt(
  prompt: string,
  localSessionId = "openclaw-session",
): CliSessionReseedReceipt {
  return {
    version: 1,
    promptHash: hashCliReseedPrompt(prompt),
    localSessionId,
    userTurnDisposition: "persisted",
  };
}

export function user(content: unknown, timestamp?: number, meta?: Record<string, unknown>) {
  return {
    role: "user",
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(meta ? { __openclaw: meta } : {}),
  };
}

export function claudeUser(content: unknown, fields: Record<string, unknown> = {}) {
  return { type: "user", ...fields, message: { role: "user", content } };
}

export function createClaudeTextHistoryLines(
  entries: Array<{ content: string; role: "assistant" | "user"; uuid: string }>,
): string {
  return entries
    .map((entry, index) =>
      JSON.stringify({
        type: entry.role,
        uuid: entry.uuid,
        timestamp: new Date(Date.parse("2026-03-26T16:29:54.800Z") + index).toISOString(),
        message: { role: entry.role, content: entry.content },
      }),
    )
    .join("\n");
}

type ClaudeHistoryReadOptions = Omit<
  Parameters<typeof readClaudeCliSessionMessagesAsync>[0],
  "cliSessionId" | "homeDir"
>;

export async function withClaudeProjectsDir<T>(
  run: (params: {
    homeDir: string;
    sessionId: string;
    filePath: string;
    readMessages: (
      options?: ClaudeHistoryReadOptions,
    ) => ReturnType<typeof readClaudeCliSessionMessagesAsync>;
  }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf-8");
  try {
    return await withEnvAsync({ HOME: homeDir }, () =>
      run({
        homeDir,
        sessionId,
        filePath,
        readMessages: (options) =>
          readClaudeCliSessionMessagesAsync({ cliSessionId: sessionId, homeDir, ...options }),
      }),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export function buildLegacyReseedPrompt(current = "current"): string {
  return [
    "Continue this conversation using the OpenClaw transcript below as prior session history.",
    "Treat it as authoritative context for this fresh CLI session.",
    "",
    "<conversation_history>",
    "User: previous",
    "</conversation_history>",
    "",
    "<next_user_message>",
    current,
    "</next_user_message>",
  ].join("\n");
}

function createClaudeHistoryLines(sessionId: string) {
  const message = (
    role: "user" | "assistant",
    id: number,
    time: string,
    content: unknown,
    fields: Record<string, unknown> = {},
  ) => ({
    type: role,
    uuid: `${role}-${id}`,
    timestamp: `2026-03-26T16:29:${time}Z`,
    message: {
      role,
      ...(role === "assistant" ? { model: "claude-sonnet-4-6" } : {}),
      content,
      ...fields,
    },
  });
  return [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-03-26T16:29:54.722Z",
      sessionId,
      content: "[Thu 2026-03-26 16:29 GMT] Reply with exactly: AGENT CLI OK.",
    },
    message(
      "user",
      1,
      "54.800",
      'Sender: ⟦openclaw:ctx⟧\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
    ),
    message("assistant", 1, "55.500", [{ type: "text", text: "hello from Claude" }], {
      stop_reason: "end_turn",
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 22 },
    }),
    message(
      "assistant",
      2,
      "56.000",
      [{ type: "tool_use", id: "toolu_123", name: "Bash", input: { command: "pwd" } }],
      {
        stop_reason: "tool_use",
      },
    ),
    message("user", 2, "56.400", [
      { type: "tool_result", tool_use_id: "toolu_123", content: "/tmp/demo" },
    ]),
    { type: "last-prompt", sessionId, lastPrompt: "ignored" },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
}
