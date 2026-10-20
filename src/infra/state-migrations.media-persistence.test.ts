import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import * as maintenanceLease from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";
import { withSqliteReadOnlyWorkerScope } from "./sqlite-readonly-worker.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent as createFixtureEvent,
  createLegacyDatabaseFixture,
  PREVIOUS_VERSION,
  readDatabaseSnapshot,
  writeArchive,
  type FixtureEvent,
} from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(() => cleanupMediaPersistenceFixtures(tempDirs));

const mediaEnv = (prefix: string) => ({ OPENCLAW_STATE_DIR: makeTempDir(tempDirs, prefix) });
type EventOptions = Parameters<typeof createFixtureEvent>[0];
function createEvent(options: Pick<EventOptions, "message"> & Partial<EventOptions>) {
  return createFixtureEvent({ id: "event-1", parentId: null, timestamp: 1000, ...options });
}

const openDatabase = (pathname: string, readOnly = false) =>
  new (requireNodeSqlite().DatabaseSync)(pathname, { readOnly });

function insertTrajectory(database: DatabaseSync, events: string[]) {
  const insert = database.prepare(
    "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
  );
  events.forEach((event, seq) => insert.run("session-a", seq, "run-1", event, 4000 + seq));
}

const media = (...entries: Record<string, unknown>[]) => ({
  __openclaw: { media: entries.map((entry) => expect.objectContaining(entry)) },
});
const expectNoMigration = async (env: NodeJS.ProcessEnv) =>
  expect(await migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });

describe("legacy media persistence doctor migration", () => {
  it.each([undefined, "full"] as const)(
    "honors %s during pre-v17 media migration",
    async (mode) => {
      const env = mediaEnv("media-integrity-");
      const message = { role: "user", content: "preserved", MediaPath: "/media/image.png" };
      const event = createEvent({ id: "kept", timestamp: 1, message });
      const pathname = createLegacyDatabaseFixture({
        env,
        schemaVersion: 16,
        eventsBySession: { media: [event] },
      });
      const before = readDatabaseSnapshot(pathname);
      const hostQueries: string[] = [];
      const sql = observeHostDataSql((query, database) => {
        if (database?.location() === pathname) {
          hostQueries.push(query);
        }
      });
      const checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      try {
        const result = await migrateLegacyMediaPersistence({ env, integrityCheck: mode });
        expect(result.warnings).toEqual([]);
        const after = readDatabaseSnapshot(pathname);
        expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
        expect(after.identities).toEqual(before.identities);
        expect(after.rows).toHaveLength(1);
        const migratedMessage = JSON.parse(after.rows[0]!.event_json).message;
        expect(migratedMessage).toMatchObject({
          content: message.content,
          __openclaw: { media: [{ path: message.MediaPath }] },
        });
        const requests = checks.mock.calls
          .filter(([file]) => file === pathname)
          .map((call) => call[5]);
        expect([...new Set(requests.map((check) => check?.check))]).toEqual([mode ?? "quick"]);
        if (mode === "full") {
          expect(hostQueries.some((query) => /\bPRAGMA\s+quick_check\b/iu.test(query))).toBe(false);
        } else {
          expect(requests.some((check) => check?.tables?.includes("transcript_events"))).toBe(true);
          expect(
            hostQueries.filter((query) => /^PRAGMA\s+integrity_check\s*(?:;|$|\(\d)/iu.test(query)),
          ).toEqual([]);
        }
      } finally {
        checks.mockRestore();
        sql.restore();
      }
    },
  );

  it("renews maintenance while a synchronous transcript scan outlasts its lease", async () => {
    const env = mediaEnv("media-persistence-slow-scan-");
    createLegacyDatabaseFixture({
      env,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      eventsBySession: {
        slow: Array.from({ length: 65 }, (_, index) =>
          createEvent({
            id: `event-${index}`,
            timestamp: index + 1,
            message: { role: "user", content: "preserved" },
          }),
        ),
      },
    });
    const originalLease = maintenanceLease.withAgentDatabaseMaintenanceLease;
    const leaseSpy = vi
      .spyOn(maintenanceLease, "withAgentDatabaseMaintenanceLease")
      .mockImplementation((options, run) => originalLease({ ...options, leaseMs: 3_000 }, run));
    const { DatabaseSync } = requireNodeSqlite();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original DatabaseSync receiver below.
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = originalPrepare.call(this, sql);
      if (sql.includes('from "transcript_events"') && sql.includes('as "event_json"')) {
        // A real blocked parent and independent heartbeat are the failure boundary.
        // Shorten the lease and emulate expensive native payload hydration per row.
        const delay = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70);
        const all = statement.all.bind(statement);
        statement.all = () =>
          all().map((row) => {
            delay();
            return row;
          });
        const iterate = statement.iterate.bind(statement);
        statement.iterate = function* (): Generator<Record<string, SQLOutputValue>, undefined> {
          for (const row of iterate()) {
            delay();
            yield row;
          }
          return undefined;
        };
      }
      return statement;
    });
    try {
      await expectNoMigration(env);
    } finally {
      prepareSpy.mockRestore();
      leaseSpy.mockRestore();
    }
  });

  it("repairs the next agent after another agent loses maintenance ownership", async () => {
    const env = mediaEnv("media-persistence-agent-lease-loss-");
    const eventsBySession = {
      media: [
        createEvent({
          timestamp: 1,
          message: { role: "user", content: "preserved", MediaPath: "/media/image.png" },
        }),
      ],
    };
    const first = createLegacyDatabaseFixture({
      env,
      agentId: "main",
      eventsBySession,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    const second = createLegacyDatabaseFixture({
      env,
      agentId: "small",
      eventsBySession,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    const before = readDatabaseSnapshot(first);
    const { DatabaseSync } = requireNodeSqlite();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its original DatabaseSync receiver below.
    const originalPrepare = DatabaseSync.prototype.prepare;
    let revoked = false;
    using _ = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = originalPrepare.call(this, sql);
      if (this.location() === first && sql.startsWith('update "transcript_events"')) {
        const run = statement.run.bind(statement);
        statement.run = new Proxy(run, {
          apply(target, receiver, args) {
            const result = Reflect.apply(target, receiver, args);
            if (revoked) {
              return result;
            }
            const database = new (requireNodeSqlite().DatabaseSync)(
              resolveOpenClawStateSqlitePath(env),
            );
            try {
              database.exec(
                "DELETE FROM state_leases WHERE scope = 'core:agent-database-maintenance' AND lease_key = 'global'",
              );
            } finally {
              database.close();
            }
            revoked = true;
            return result;
          },
        });
      }
      return statement;
    });
    let preparedPaths: string[] = [];
    const result = await migrateLegacyMediaPersistence({
      env,
      onPreparedRepairTargets: (targets) => {
        preparedPaths = targets.map((target) => target.path);
      },
    });
    expect(revoked).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(`Skipped agent database migration for ${first}:`);
    expect(result.warnings[0]).toContain("lease");
    expect(preparedPaths).toEqual([second]);
    expect(readDatabaseSnapshot(first)).toEqual(before);
    expect(result.changes).toContainEqual(
      expect.stringContaining(`Migrated media persistence in ${second}:`),
    );
    const snapshot = readDatabaseSnapshot(second);
    expect(JSON.parse(snapshot.rows[0]!.event_json)).toMatchObject({
      message: {
        __openclaw: { media: [expect.objectContaining({ path: "/media/image.png" })] },
      },
    });
  });

  it("converges pending same-version agent schema during an update", async () => {
    const env = { ...mediaEnv("update-pending-agent-schema-"), OPENCLAW_UPDATE_IN_PROGRESS: "1" };
    const pathname = createLegacyDatabaseFixture({
      env,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      eventsBySession: {},
    });
    {
      using database = openDatabase(pathname);
      database.exec("DROP TABLE session_reactions;");
    }
    await expectNoMigration(env);
    using repaired = openDatabase(pathname, true);
    expect(
      repaired.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_reactions'").get(),
    ).toEqual({ "1": 1 });
  });

  it("reports skipped embedding cache rows as recoverable Doctor warnings after a schema-21 upgrade", async () => {
    const env = mediaEnv("memory-cache-migration-warning-");
    const pathname = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 21 });
    {
      using database = openDatabase(pathname);
      database.exec(`INSERT INTO memory_embedding_cache
        (rowid, provider, model, provider_key, hash, embedding, dims, updated_at) VALUES
        (7, 'p', 'm', 'k', 'oversized', '[1]' || replace(hex(zeroblob(524288)), '0', ' '), 1, 1),
        (8, 'p', 'm', 'k', 'malformed', 'invalid', 1, 1),
        (9, 'p', 'm', 'k', 'valid', '[1]', 1, 1)`);
    }
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.warningDisposition).toBe("recoverable");
    expect(result.warnings).toEqual([
      expect.stringContaining("Skipped 2 memory_embedding_cache rows"),
    ]);
    expect(result.warnings[0]).toContain("7, 8");
    {
      using migrated = openDatabase(pathname, true);
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        migrated
          .prepare("SELECT rowid, typeof(embedding) AS storage FROM memory_embedding_cache")
          .all(),
      ).toEqual([{ rowid: 9, storage: "blob" }]);
    }
    await expectNoMigration(env);
  });

  it("retains a completed FULL schema crossing's integrity proof on reopen", async () => {
    const env = {
      ...mediaEnv("media-persistence-crossing-proof-"),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
    };
    const pathname = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 21 });
    using checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const result = await migrateLegacyMediaPersistence({ env, integrityCheck: "full" });
    expect(result.warnings).toEqual([]);
    expect(checks.mock.calls.filter(([file]) => file === pathname)).toHaveLength(1);
    using sql = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    const reopened = openOpenClawAgentDatabase({ agentId: "main", env });
    expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    expect(
      sql.mock.calls.filter(
        ([query], index) =>
          sql.mock.contexts[index] === reopened.db && /PRAGMA\s+integrity_check/iu.test(query),
      ),
    ).toEqual([]);
  });

  it("cancels pending integrity before migrating the agent schema", async () => {
    const env = mediaEnv("media-persistence-interruption-");
    const pathname = createLegacyDatabaseFixture({ env, eventsBySession: {}, schemaVersion: 21 });
    const controller = new AbortController();
    const interruption = new Error("Doctor interrupted by SIGTERM");
    let entered!: () => void;
    const checking = new Promise<boolean>((resolve) => {
      entered = () => resolve(true);
    });
    const check = vi
      .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
      .mockImplementation(async () => {
        entered();
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(interruption), {
            once: true,
          });
        });
      });
    const migration = withSqliteReadOnlyWorkerScope(() => migrateLegacyMediaPersistence({ env }), {
      signal: controller.signal,
      deadlineOwnedByCaller: false,
    });
    try {
      expect(await Promise.race([checking, migration.then(() => false)])).toBe(true);
    } finally {
      controller.abort(interruption);
      try {
        await expect(migration).rejects.toBe(interruption);
      } finally {
        check.mockRestore();
      }
    }
    using database = openDatabase(pathname, true);
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(21);
  });

  it("preserves the typed maintenance cause when lease acquisition fails", async () => {
    const env = mediaEnv("media-persistence-lease-");
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    closeOpenClawStateDatabaseForTest();
    const location = nodeSqlite.resolveExistingSqliteFileUri(resolveOpenClawStateSqlitePath(env));
    const originalOpen = nodeSqlite.openNodeSqliteDatabase;
    using _ = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
      if (file === location && !options?.readOnly) {
        throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
      }
      return originalOpen(file, options);
    });
    const result = await migrateLegacyMediaPersistence({ env });
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
    ]);
  });

  it("rewrites every active shape and trajectory snapshot, migrates mixed archives, and reruns as a no-op", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-migration-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const legacy = createEvent({
      id: "event-legacy",
      message: {
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        MediaPaths: ["/media/a.ogg", "/media/b.png"],
        MediaTypes: ["audio", "image/png"],
        MediaTranscribedIndexes: [0],
        MediaWorkspaceDir: "/workspace",
      },
    });
    const conflict = createEvent({
      id: "event-conflict",
      parentId: "event-legacy",
      timestamp: 2000,
      message: {
        role: "user",
        content: "conflict",
        MediaPath: "/legacy.png",
        MediaType: "image/png",
        __openclaw: {
          traceId: "trace-1",
          media: [{ path: "/canonical.jpg", contentType: "image/jpeg" }],
        },
      },
    });
    const databasePath = createLegacyDatabaseFixture({
      env,
      eventsBySession: {
        "session-a": [legacy, conflict],
        "session-b": [
          createEvent({
            id: "event-sparse",
            timestamp: 3000,
            message: {
              role: "user",
              content: "sparse",
              MediaPaths: ["", "/media/c.pdf"],
              MediaTypes: ["", "application/pdf"],
            },
          }),
        ],
      },
    });
    const emptyCarrierEventJson = JSON.stringify({
      type: "model.completed",
      data: {
        messagesSnapshot: [
          { role: "user", content: "empty", media: [], MediaPaths: [], MediaTypes: [] },
        ],
        modelOutput: "empty",
      },
    });
    {
      using database = openDatabase(databasePath);
      // Individually safe timestamps must not overflow an aggregate migration fingerprint.
      database
        .prepare("UPDATE transcript_events SET created_at = ?")
        .run(Math.floor(Number.MAX_SAFE_INTEGER / 2) + 100);
      insertTrajectory(database, [
        JSON.stringify({
          type: "model.completed",
          data: {
            messagesSnapshot: [legacy.message],
            modelOutput: "done",
            timing: { totalMs: 125 },
            toolTraces: [{ name: "read", durationMs: 5 }],
          },
        }),
        JSON.stringify({ data: { toolArguments: { MediaPath: "/not-a-message-field" } } }),
        JSON.stringify({
          data: {
            messagesSnapshot: [{ role: "user", media: [{ path: "/legacy-top-level.png" }] }],
          },
        }),
        emptyCarrierEventJson,
      ]);
    }

    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const plainArchive = path.join(archiveDir, "cold-plain.jsonl.deleted.2026-07-24T01-02-03.000Z");
    const compressedArchive = `${path.join(
      archiveDir,
      "cold-zstd.jsonl.reset.2026-07-24T01-02-04.000Z",
    )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
    writeArchive(plainArchive, [legacy], false);
    writeArchive(compressedArchive, [conflict], true);

    const before = readDatabaseSnapshot(databasePath);
    const sql = observeMainThreadSql();
    let result: Awaited<ReturnType<typeof migrateLegacyMediaPersistence>>;
    let preparedPaths: string[] = [];
    try {
      result = await migrateLegacyMediaPersistence({
        env,
        onPreparedRepairTargets: (targets) => {
          preparedPaths = targets.map((target) => target.path);
        },
      });
      expect(preparedPaths).toEqual([databasePath]);
      const statements = sql.calls.flatMap((call) =>
        call.mock.calls.map(([statement]) => statement),
      );
      expect(
        statements.filter(
          (statement) =>
            typeof statement === "string" &&
            /\bsum\s*\(/iu.test(statement) &&
            /\b(?:transcript_events|trajectory_runtime_events)\b/iu.test(statement) &&
            !/\bwhere\b/iu.test(statement),
        ),
      ).toEqual([]);
    } finally {
      sql.restore();
    }
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(5);
    expect(result.changes).toEqual(
      expect.arrayContaining([
        `Upgraded agent database schema in ${databasePath}: v16 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated media persistence in ${databasePath}: 2 transcript session(s), 2 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
        `Migrated archived transcript media in ${plainArchive}.`,
        `Migrated archived transcript media in ${compressedArchive}.`,
      ]),
    );

    const recoveryDirectories = () =>
      fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw-media-persistence-recovery-"));
    const backups = recoveryDirectories();
    expect(backups).toHaveLength(1);
    const preserved = readDatabaseSnapshot(
      path.join(path.dirname(databasePath), backups[0]!, "database.sqlite"),
    );
    expect(preserved.rows).toEqual(before.rows);
    expect(preserved.trajectoryRows).toEqual(before.trajectoryRows);

    const after = readDatabaseSnapshot(databasePath);
    expect(after.version.user_version).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(after.trajectoryCount).toBe(4);
    expect(after.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row)).toEqual(
      before.trajectoryRows.map(({ event_json: _eventJson, ...row }) => row),
    );
    const migratedTrajectory = JSON.parse(after.trajectoryRows[0]?.event_json ?? "null") as {
      data?: Record<string, unknown>;
    };
    expect(migratedTrajectory.data).toMatchObject({
      modelOutput: "done",
      timing: { totalMs: 125 },
      toolTraces: [{ name: "read", durationMs: 5 }],
    });
    const migratedMessagesSnapshot = migratedTrajectory.data?.messagesSnapshot;
    expect(migratedMessagesSnapshot).toBeInstanceOf(Array);
    const migratedTrajectoryMessage = (
      migratedMessagesSnapshot as Array<Record<string, unknown>>
    )[0];
    expect(migratedTrajectoryMessage).not.toHaveProperty("MediaPaths");
    expect(migratedTrajectoryMessage).toMatchObject(
      media({ path: "/media/a.ogg" }, { path: "/media/b.png" }),
    );
    expect(after.trajectoryRows[1]?.event_json).toBe(before.trajectoryRows[1]?.event_json);
    const topLevelMediaMessage = (
      JSON.parse(after.trajectoryRows[2]?.event_json ?? "null") as {
        data: { messagesSnapshot: Array<Record<string, unknown>> };
      }
    ).data.messagesSnapshot[0];
    expect(topLevelMediaMessage).not.toHaveProperty("media");
    expect(topLevelMediaMessage).toMatchObject(media({ path: "/legacy-top-level.png" }));
    expect(after.trajectoryRows[3]?.event_json).toBe(emptyCarrierEventJson);
    expect(after.rows.map((row) => row.created_at)).toEqual(
      before.rows.map((row) => row.created_at),
    );
    expect(after.generations).not.toEqual(before.generations);
    expect(after.identities).toEqual(before.identities);
    expect(after.activeBranch).toEqual(before.activeBranch);
    expect(after.windows).toEqual(before.windows);
    const messages = after.rows.map((row) => (JSON.parse(row.event_json) as FixtureEvent).message);
    expect(messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "legacy",
        idempotencyKey: "idem-legacy",
        ...media({ kind: "audio", transcribed: true }, { contentType: "image/png" }),
      }),
      expect.objectContaining({
        __openclaw: {
          traceId: "trace-1",
          media: [expect.objectContaining({ path: "/canonical.jpg" })],
        },
      }),
      expect.objectContaining({
        __openclaw: {
          media: [expect.any(Object), expect.objectContaining({ path: "/media/c.pdf" })],
        },
      }),
    ]);
    for (const message of messages) {
      expect(JSON.stringify(message)).not.toMatch(/"Media(?:Path|Paths|Type|Types|Url|Urls)/u);
    }
    expect(readSessionArchiveContentSync(plainArchive)).toContain('"__openclaw"');
    expect(readSessionArchiveContentSync(compressedArchive)).toContain('"__openclaw"');

    await appendTranscriptMessage(
      { agentId: "main", env, sessionId: "session-a", sessionKey: "agent:main:session-a" },
      {
        eventId: "current-writer",
        message: { role: "assistant", content: "after repair", MediaPath: "/media/new.png" },
      },
    );
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      await expectNoMigration(env);
      expect(checks.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(1);
      expect(
        reads.mock.calls.filter(
          ([query]) =>
            /from "(?:transcript_events|trajectory_runtime_events)"/u.test(query) &&
            query.includes('as "event_json"'),
        ),
      ).toEqual([]);
    } finally {
      checks.mockRestore();
      reads.mockRestore();
    }
    const appended = readDatabaseSnapshot(databasePath).rows.find(
      (row) => JSON.parse(row.event_json).id === "current-writer",
    );
    expect(recoveryDirectories()).toEqual(backups);
    expect(JSON.parse(appended!.event_json).message).toMatchObject({
      role: "assistant",
      content: "after repair",
      ...media({ path: "/media/new.png" }),
    });
  });

  it("defers current-schema media maintenance during updates and repairs it in explicit Doctor", async () => {
    const env = mediaEnv("media-persistence-message-roles-");
    const databasePath = createLegacyDatabaseFixture({
      env,
      schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      eventsBySession: {
        roles: [
          createEvent({
            id: "event-assistant",
            message: { role: "assistant", content: "result", MediaPath: "/media/result.png" },
          }),
          createEvent({
            id: "event-roleless",
            parentId: "event-assistant",
            timestamp: 2000,
            message: { content: "imported", MediaPath: "/media/imported.png" },
          }),
        ],
      },
    });

    const beforeUpdate = readDatabaseSnapshot(databasePath);
    const checks = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    let preparedPaths: string[] = [];
    try {
      expect(
        await migrateLegacyMediaPersistence({
          env: { ...env, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
          onPreparedRepairTargets: (targets) => {
            preparedPaths = targets.map((target) => target.path);
          },
        }),
      ).toEqual({ changes: [], warnings: [] });
      expect(readDatabaseSnapshot(databasePath)).toEqual(beforeUpdate);
      expect(preparedPaths).toEqual([databasePath]);
      expect(checks.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(0);
    } finally {
      checks.mockRestore();
    }

    const scope = createOpenClawDatabaseMaintenanceScope();
    scope.addAgentSchemaMigrationCheck(() => {
      throw new Error("Same-schema media cleanup must not require versioned backup coverage");
    });
    let result: Awaited<ReturnType<typeof migrateLegacyMediaPersistence>>;
    try {
      result = await scope.run(() => migrateLegacyMediaPersistence({ env }));
    } finally {
      await scope.close();
    }
    expect(result).toEqual({
      changes: [
        expect.stringMatching(/^Saved pre-repair SQLite backup: /),
        `Migrated media persistence in ${databasePath}: 1 transcript session(s), 0 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
      ],
      warnings: [],
    });
    const messages = readDatabaseSnapshot(databasePath).rows.map(
      (row) => (JSON.parse(row.event_json) as FixtureEvent).message,
    );
    expect(messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        ...media({ path: "/media/result.png" }),
      }),
      expect.objectContaining(media({ path: "/media/imported.png" })),
    ]);
    for (const message of messages) {
      expect(message).not.toHaveProperty("MediaPath");
    }
    await expectNoMigration(env);
  });

  it.each([
    { schemaVersion: PREVIOUS_VERSION, kind: "transcript" },
    { schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION, kind: "trajectory" },
  ])(
    "rolls back late invalid $kind JSON at schema v$schemaVersion",
    async ({ schemaVersion, kind }) => {
      const env = mediaEnv("media-persistence-corrupt-");
      const databasePath = createLegacyDatabaseFixture({
        env,
        schemaVersion,
        eventsBySession: {
          corrupt: Array.from({ length: kind === "transcript" ? 65 : 1 }, (_, index) =>
            createEvent({
              id: `event-${index}`,
              parentId: index === 0 ? null : `event-${index - 1}`,
              timestamp: 1000 + index,
              message: {
                role: "user",
                content: "preserved",
                ...(index === 0 ? { MediaPath: "/media/a.png" } : {}),
              },
            }),
          ),
        },
      });
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(databasePath);
      if (kind === "transcript") {
        database
          .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 64")
          .run("{broken", "corrupt");
      } else {
        const insert = database.prepare(
          "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,?,?,?,?)",
        );
        for (let seq = 0; seq <= 64; seq += 1) {
          insert.run(
            "corrupt",
            seq,
            "run-1",
            seq === 64
              ? "{broken"
              : JSON.stringify({
                  data: {
                    messagesSnapshot: [{ role: "user", MediaPath: "/media/trajectory.png" }],
                  },
                }),
            2000 + seq,
          );
        }
      }
      database.close();

      if (schemaVersion === PREVIOUS_VERSION) {
        expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
          "run openclaw doctor --fix to migrate persisted media",
        );
        closeOpenClawAgentDatabasesForTest();
      }
      const before = readDatabaseSnapshot(databasePath);
      const result = await migrateLegacyMediaPersistence({ env });
      expect(result.warnings).toHaveLength(1);
      expect(result.changes).toEqual([
        expect.stringContaining(
          `Saved pre-repair SQLite backup: ${path.join(path.dirname(databasePath), "openclaw-media-persistence-recovery-")}`,
        ),
      ]);
      expect(result.warnings[0]).toContain(`Skipped agent database migration for ${databasePath}:`);
      expect(result.warnings[0]).toContain(`invalid ${kind} JSON`);
      expect(readDatabaseSnapshot(databasePath)).toEqual(before);
      const failed = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          failed
            .prepare("SELECT 1 FROM schema_meta WHERE meta_key = 'media-persistence-rows-v1'")
            .get(),
        ).toBeUndefined();
      } finally {
        failed.close();
      }
      expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(
        schemaVersion === PREVIOUS_VERSION
          ? []
          : [expect.objectContaining({ path: databasePath, schemaVersion })],
      );
      expect(
        listOpenClawRegisteredAgentDatabases({
          env,
          includeIncompatibleSchemaVersions: true,
        }),
      ).toEqual([expect.objectContaining({ path: databasePath, schemaVersion })]);
    },
  );

  it("preserves an archive replaced before its atomic media repair", async () => {
    const env = mediaEnv("media-persistence-drift-");
    const event = createEvent({
      message: { role: "user", content: "before", MediaPath: "/media/a.png" },
    });
    createLegacyDatabaseFixture({ env, eventsBySession: { drift: [event] } });
    const archivePath = path.join(
      env.OPENCLAW_STATE_DIR,
      "agents",
      "main",
      "sessions",
      "drift.jsonl.deleted.2026-07-24T01-02-03.000Z",
    );
    writeArchive(archivePath, [event], false);
    const open = fs.openSync;
    using archiveOpen = vi.spyOn(fs, "openSync");
    archiveOpen.mockImplementation((candidate, flags, mode) => {
      if (flags === "wx" && String(candidate).startsWith(`${archivePath}.media-retirement.`)) {
        fs.writeFileSync(archivePath, "replacement\n");
      }
      return open(candidate, flags, mode);
    });
    const archiveDrift = await migrateLegacyMediaPersistence({ env });
    expect(archiveDrift.warnings.join("\n")).toContain("changed before atomic");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement\n");
  });
});

function createArchiveFixture(bytes: Uint8Array): {
  archivePath: string;
  env: NodeJS.ProcessEnv;
} {
  const stateDir = fs.realpathSync(makeTempDir(tempDirs, "media-persistence-archive-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabasesForTest();
  const archivePath = path.join(
    stateDir,
    "agents",
    "main",
    "sessions",
    "fixture.jsonl.deleted.2026-07-24T01-02-03.000Z",
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, bytes);
  return { archivePath, env };
}

describe("legacy media persistence NUL-tail recovery", () => {
  it("atomically removes a terminal NUL suffix from an otherwise valid archive", async () => {
    const valid = Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n`);
    const { archivePath, env } = createArchiveFixture(Buffer.concat([valid, Buffer.alloc(284)]));
    using rename = vi.spyOn(fs, "renameSync");

    const result = await migrateLegacyMediaPersistence({ env });
    const replacements = rename.mock.calls.filter(
      ([, destination]) => destination === archivePath,
    ).length;

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated archived transcript media in ${archivePath}.`);
    expect(replacements).toBe(1);
    expect(fs.readFileSync(archivePath)).toEqual(valid);
  });

  it.each([
    { name: "an all-NUL file", bytes: Buffer.alloc(284) },
    {
      name: "a blank record",
      bytes: Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n\n`),
    },
  ])("rejects and preserves $name", async ({ bytes }) => {
    const { archivePath, env } = createArchiveFixture(bytes);
    using rename = vi.spyOn(fs, "renameSync");

    const result = await migrateLegacyMediaPersistence({ env });
    const replacements = rename.mock.calls.filter(
      ([, destination]) => destination === archivePath,
    ).length;

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Skipped archived transcript media migration");
    expect(result.warningDisposition).toBe("recoverable");
    expect(replacements).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
  });

  it("does not rewrite an empty file", async () => {
    const bytes = Buffer.alloc(0);
    const { archivePath, env } = createArchiveFixture(bytes);
    const before = fs.lstatSync(archivePath);
    using rename = vi.spyOn(fs, "renameSync");

    const result = await migrateLegacyMediaPersistence({ env });
    const replacements = rename.mock.calls.filter(
      ([, destination]) => destination === archivePath,
    ).length;

    const after = fs.lstatSync(archivePath);
    expect(result).toEqual({ changes: [], warnings: [] });
    expect(replacements).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    });
  });
});

describe("legacy media persistence archive doctor migration", () => {
  it("rejects ambiguous sparse arrays and ignores stale interrupted temp files", async () => {
    const env = mediaEnv("media-persistence-sparse-");
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    const archiveDir = path.join(env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    const archivePath = path.join(archiveDir, "sparse.jsonl.bak.2026-07-24T01-02-03.000Z");
    const event = createEvent({
      message: {
        role: "user",
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      },
    });
    writeArchive(archivePath, [event], false);
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "ambiguous sparse positional alignment",
    );
    fs.unlinkSync(archivePath);

    const corruptArchivePath = path.join(
      archiveDir,
      "corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
    );
    fs.writeFileSync(corruptArchivePath, "{broken\n");
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "invalid transcript JSON",
    );
    expect(fs.readFileSync(corruptArchivePath, "utf8")).toBe("{broken\n");
    fs.unlinkSync(corruptArchivePath);

    writeArchive(
      archivePath,
      [
        createEvent({
          message: { role: "user", MediaPath: "/media/a.png", MediaType: "image/png" },
        }),
      ],
      false,
    );
    fs.writeFileSync(`${archivePath}.media-retirement.999.interrupted.tmp`, "partial");
    expect((await migrateLegacyMediaPersistence({ env })).changes.join("\n")).toContain(
      "Migrated archived transcript media",
    );
    expect(readSessionArchiveContentSync(archivePath)).toContain('"__openclaw"');
  });
});
