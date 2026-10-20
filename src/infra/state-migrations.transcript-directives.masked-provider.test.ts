import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { prepareTrajectoryPayload } from "../trajectory/runtime-payload.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { encodeArchiveContent } from "./state-migrations.transcript-directives-archives.js";
import { migrateHistoricalTranscriptDirectives as migrate } from "./state-migrations.transcript-directives.js";
import {
  type FixtureEvent,
  insertSession,
  messageEvent,
  readEventJson,
  readGeneration,
  readMigrationCursor,
} from "./state-migrations.transcript-directives.test-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("historical transcript masked provider repair", () => {
  const MASKED = '"provider":"***"';
  const copilotFact = { modelId: "claude-opus-5.5", provider: "github-copilot" };
  const restored = (event: FixtureEvent, provider = "github-copilot") =>
    JSON.stringify(event).replace(MASKED, `"provider":"${provider}"`);

  function fixture() {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "transcript-masked-provider-") };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const read = (session: string, seq: number) => readEventJson(opened.path, session, seq);
    return {
      env,
      read,
      databasePath: opened.path,
      database: requireNativeSqliteDatabase(opened.db),
    };
  }

  function singleSession(content?: string, sessionId = "session") {
    const context = fixture();
    const masked = maskedAssistant("masked", copilotFact.modelId, 1);
    const tagged =
      content === undefined
        ? undefined
        : messageEvent({
            content: [{ type: "text", text: content }],
            id: "tagged",
            role: "assistant",
            timestamp: 2,
          });
    insertSession(context.database, {
      events: tagged ? [masked, tagged] : [masked],
      generation: "g",
      sessionId,
    });
    insertTrajectory(context.database, sessionId, [copilotFact]);
    return { ...context, masked, tagged };
  }

  function maskedAssistant(id: string, model: string, timestamp: number): FixtureEvent {
    const event = messageEvent({
      content: [{ type: "text", text: `Answer ${id}` }],
      id,
      role: "assistant",
      timestamp,
    });
    Object.assign(event.message as Record<string, unknown>, { model, provider: "***" });
    return event;
  }

  function insertTrajectory(
    database: import("node:sqlite").DatabaseSync,
    sessionId: string,
    facts: Array<{ modelId: string; provider: string }>,
    mixedStorage = false,
  ): void {
    const insert = database.prepare(
      `INSERT INTO trajectory_runtime_events(
         session_id,seq,run_id,event_json,created_at,event_payload,event_codec,event_utf8_bytes
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const [seq, fact] of facts.entries()) {
      const data = {
        messagesSnapshot: [{ role: "user", content: "retained payload ".repeat(256) }],
      };
      const eventJson = JSON.stringify({
        type: "model.completed",
        sessionId,
        ...fact,
        ...(mixedStorage ? { data } : {}),
      });
      const payload =
        mixedStorage && seq % 2 === 0 ? prepareTrajectoryPayload(database, eventJson) : null;
      if (payload) {
        expect(payload.event_codec).not.toBeNull();
      }
      insert.run(
        sessionId,
        seq,
        "run",
        payload ? payload.event_json : eventJson,
        seq,
        payload?.event_payload ?? null,
        payload?.event_codec ?? null,
        payload?.event_utf8_bytes ?? null,
      );
    }
  }

  function compressTranscriptRows(database: import("node:sqlite").DatabaseSync): void {
    const update = database.prepare(
      "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = ?",
    );
    for (const row of database
      .prepare("SELECT session_id, seq, event_json FROM transcript_events")
      .all() as Array<{ event_json: string; seq: number; session_id: string }>) {
      const payload = prepareTranscriptPayload(database, row.event_json);
      expect(payload.event_zstd).not.toBeNull();
      update.run(
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
        row.session_id,
        row.seq,
      );
    }
  }

  function writeCursor(database: import("node:sqlite").DatabaseSync, cursor: unknown): void {
    database
      .prepare(
        `INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run("historical-transcript-directives-v1", "agent", 1, "main", JSON.stringify(cursor), 1, 1);
  }

  it.each(["identity", "zstd"])(
    "restores %s masked providers from recorded session facts and leaves ambiguity masked",
    async (storage) => {
      const { env, databasePath, database, read } = fixture();
      const copilot = maskedAssistant("copilot", "claude-opus-5.5", 1);
      const user = messageEvent({ content: "next", id: "user", role: "user", timestamp: 2 });
      const openai = maskedAssistant("openai", "gpt-6.1-sol", 3);
      // A masked-looking value outside message.provider is not a candidate.
      const toolCall = messageEvent({
        content: [{ type: "toolCall", id: "call", name: "probe", arguments: { provider: "***" } }],
        id: "tool-call",
        role: "assistant",
        timestamp: 4,
      });
      const ambiguous = maskedAssistant("ambiguous", "claude-opus-5.5", 5);
      const unrecorded = maskedAssistant("unrecorded", "claude-opus-5.5", 6);
      if (storage === "zstd") {
        for (const event of [copilot, user, openai, toolCall, ambiguous, unrecorded]) {
          event.fixturePadding = "compression fixture ".repeat(256);
        }
      }
      const sessions = {
        multi: [copilot, user, openai, toolCall],
        ambiguous: [ambiguous],
        unrecorded: [unrecorded],
        archived: [],
      };
      for (const [name, events] of Object.entries(sessions)) {
        insertSession(database, {
          events,
          generation: `${name}-before`,
          sessionId: `${name}-session`,
        });
      }
      if (storage === "zstd") {
        compressTranscriptRows(database);
      }
      insertTrajectory(
        database,
        "multi-session",
        [
          copilotFact,
          copilotFact,
          { modelId: "gpt-6.1-sol", provider: "openai" },
          { modelId: "gpt-6.1-sol", provider: "***" },
        ],
        storage === "zstd",
      );
      insertTrajectory(
        database,
        "ambiguous-session",
        [copilotFact, { modelId: "claude-opus-5.5", provider: "openrouter" }],
        storage === "zstd",
      );
      insertTrajectory(database, "archived-session", [copilotFact], storage === "zstd");

      const archived = maskedAssistant("archived", "claude-opus-5.5", 7);
      const archivedUser = messageEvent({
        content: "hi",
        id: "a-user",
        role: "user",
        timestamp: 8,
      });
      const archiveContent = `${JSON.stringify(archived)}\n${JSON.stringify(archivedUser)}\n`;
      const archiveEncoding = storage === "zstd" ? "zstd" : "identity";
      const archiveBytes = encodeArchiveContent(archiveContent, archiveEncoding, "fixture");
      const archiveName = `archived-session.jsonl.deleted.2026-01-01T00-00-00.000Z.archive-gen${archiveEncoding === "zstd" ? SESSION_ARCHIVE_ZSTD_SUFFIX : ""}`;
      database
        .prepare(
          `INSERT INTO session_transcript_archives(
          session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,
          archive_name,created_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "archived-session",
          "archive-gen",
          "agent:main:archived-session",
          "deleted",
          archiveEncoding,
          archiveBytes,
          createHash("sha256").update(archiveBytes).digest("hex"),
          archiveName,
          7,
          8,
        );
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: "main",
        path: databasePath,
      });
      fs.mkdirSync(archiveDirectory, { recursive: true });
      const archivePath = path.join(archiveDirectory, archiveName);
      fs.writeFileSync(archivePath, archiveBytes);
      closeOpenClawAgentDatabasesForTest();

      const result = await migrate({ env });

      expect(result).toMatchObject({
        changes: [
          `Restored masked provider on 3 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
          `Repaired historical transcripts in ${databasePath}: 1 active session(s), 1 archived transcript(s).`,
        ],
        warnings: [
          `Left 2 historical transcript row(s) with masked provider "***" in ${databasePath}: no single provider was recorded for their session and model.`,
        ],
        warningDisposition: "recoverable",
      });
      // Only the provider value changes; every other byte of the event is preserved.
      expect([0, 1, 2, 3].map((seq) => read("multi-session", seq))).toEqual([
        restored(copilot),
        JSON.stringify(user),
        restored(openai, "openai"),
        JSON.stringify(toolCall),
      ]);
      expect(read("ambiguous-session", 0)).toBe(JSON.stringify(ambiguous));
      expect(read("unrecorded-session", 0)).toBe(JSON.stringify(unrecorded));
      expect(readGeneration(databasePath, "multi-session")).not.toBe("multi-before");
      expect(readGeneration(databasePath, "ambiguous-session")).toBe("ambiguous-before");
      const restoredArchive = `${restored(archived)}\n${JSON.stringify(archivedUser)}\n`;
      expect(readSessionArchiveContentSync(archivePath)).toBe(restoredArchive);
      expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
      {
        using migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
        // Provider restores record their rows instead of a full database backup.
        const row = migrated
          .prepare("SELECT app_version FROM schema_meta WHERE meta_key = ?")
          .get("historical-transcript-masked-provider-restored-v1") as { app_version: string };
        expect(JSON.parse(row.app_version)).toEqual({
          archiveLines: ["archived-session:archive-gen:1"],
          transcriptRows: { "multi-session": [0, 2] },
        });
        // The session index holds no provider, so it stays current without a rebuild.
        expect(
          migrated
            .prepare(
              "SELECT needs_rebuild, indexed_seq FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get("multi-session"),
        ).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
      }
      expect(
        fs
          .readdirSync(path.dirname(databasePath))
          .filter((name) => name.startsWith("openclaw-transcript-directives-recovery-")),
      ).toEqual([]);

      const archiveAfterFirstRun = fs.readFileSync(archivePath);
      const generationAfterFirstRun = readGeneration(databasePath, "multi-session");
      await expect(migrate({ env })).resolves.toEqual({ changes: [], warnings: [] });
      expect(readGeneration(databasePath, "multi-session")).toBe(generationAfterFirstRun);
      expect(fs.readFileSync(archivePath)).toEqual(archiveAfterFirstRun);
    },
  );

  it("reopens a completed version 1 pass once for masked providers only", async () => {
    // Version 1 completion means directives were already handled; this pass must not reparse them.
    const { env, databasePath, database, masked, tagged, read } = singleSession(
      "[[reply_to_current]] kept",
    );
    writeCursor(database, { phase: "complete" });
    closeOpenClawAgentDatabasesForTest();

    const result = await migrate({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(
      `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
    );
    expect(read("session", 0)).toBe(restored(masked));
    expect(read("session", 1)).toBe(JSON.stringify(tagged));
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
    await expect(migrate({ env })).resolves.toEqual({ changes: [], warnings: [] });
  });

  it("backs up and reindexes a session whose rows also need directive normalization", async () => {
    const { env, databasePath, masked, read } = singleSession("[[reply_to_current]] Final answer");
    closeOpenClawAgentDatabasesForTest();

    const result = await migrate({ env });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      expect.stringMatching(/^Saved pre-repair SQLite backup: /u),
      `Restored masked provider on 1 historical transcript row(s) in ${databasePath} from recorded session runtime facts.`,
      `Repaired historical transcripts in ${databasePath}: 1 active session(s), 0 archived transcript(s).`,
    ]);
    expect(read("session", 0)).toBe(restored(masked));
    expect(JSON.parse(read("session", 1))).toMatchObject({
      message: { content: [{ type: "text", text: "Final answer" }] },
    });
    using migrated = openNodeSqliteDatabase(databasePath, { readOnly: true });
    // Stripped directive text leaves the search index only through a rebuild.
    expect(
      migrated
        .prepare("SELECT 1 FROM session_transcript_fts WHERE session_transcript_fts MATCH ?")
        .all('"reply_to_current"'),
    ).toEqual([]);
  });

  it("restarts an interrupted version 1 pass from the first session", async () => {
    const { env, databasePath, database, masked, read } = singleSession(undefined, "a-session");
    // Version 1 stopped after this session id; earlier sessions never saw the provider repair.
    writeCursor(database, { phase: "transcripts", sessionId: "z-session" });
    closeOpenClawAgentDatabasesForTest();

    const result = await migrate({ env });

    expect(result.warnings).toEqual([]);
    expect(read("a-session", 0)).toBe(restored(masked));
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete", version: 2 });
  });

  it("leaves masked rows untouched while the agent database writer is active", async () => {
    const { env, databasePath, database, masked } = singleSession();
    writeCursor(database, { phase: "complete" });
    closeOpenClawAgentDatabasesForTest();
    const leaseId = claimOpenClawAgentDatabaseLease({ agentId: "main", path: databasePath, env });

    const result = await migrate({ env }).finally(() => {
      releaseOpenClawAgentDatabaseLease(leaseId, { env });
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("database is still open in another process"),
    ]);
    expect(readEventJson(databasePath, "session", 0)).toBe(JSON.stringify(masked));
    expect(readMigrationCursor(databasePath)).toEqual({ phase: "complete" });
  });
});
