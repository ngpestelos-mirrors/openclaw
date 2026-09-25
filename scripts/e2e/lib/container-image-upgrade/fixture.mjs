import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

const state = "/home/node/.openclaw";
const workspace = path.join(state, "workspace");
const agentPath = path.join(state, "agents/main/agent/openclaw-agent.sqlite");
const sharedPath = path.join(state, "state/openclaw.sqlite");
const recordPath = path.join(state, "container-image-fixture.json");
const sessionKey = "agent:main:container-image-upgrade";
const sessionId = "container-image-upgrade";
const marker = "CONTAINER_IMAGE_RETAINED_SESSION";
const setup = { version: 1, setupCompletedAt: "2026-07-02T00:00:00.000Z" };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const schemaVersions = readJson("/app/package.json").openclaw.schemaVersions;
function open(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    return fn(db);
  } finally {
    db.close();
  }
}
function logicalSnapshot(file) {
  return open(file, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      schema: db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name, sql",
        )
        .all(),
      tables: Object.fromEntries(
        tables.map(({ name }) => [
          name,
          db
            .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .toSorted(),
        ]),
      ),
    };
  });
}
function assertSession(file) {
  return open(file, (db) => {
    const row = db
      .prepare("SELECT current_session_id FROM session_nodes WHERE session_key=?")
      .get(sessionKey);
    assert.equal(row?.current_session_id, sessionId);
    const events = db
      .prepare(
        `SELECT ${sqliteTranscriptPayloadColumns(db)} FROM transcript_events WHERE session_id=? ORDER BY seq`,
      )
      .all(sessionId);
    const expected = readJson(recordPath).events;
    assert.deepEqual(
      events.map((event) => JSON.parse(readSqliteTranscriptPayload(event))),
      expected,
    );
  });
}
function backups(file) {
  return fs
    .readdirSync(path.dirname(file))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(file)}.pre-startup-migration-`) && name.endsWith(".bak"),
    )
    .map((name) => path.join(path.dirname(file), name));
}
function verifyBackup(file, expected) {
  const matches = backups(file);
  assert.equal(matches.length, 1, `Expected exactly one retained-schema backup: ${file}`);
  assert.deepEqual(logicalSnapshot(matches[0]), expected, "Backup changed retained rows/schema");
  const backupId = path
    .basename(matches[0])
    .slice(`${path.basename(file)}.pre-startup-migration-`.length, -".bak".length);
  assert.match(backupId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  return { path: matches[0], backupId, sha256: sha(fs.readFileSync(matches[0])) };
}
function verifyWorkspace(required) {
  const legacy = path.join(workspace, "openclaw-workspace-state.json");
  if (!required && fs.existsSync(legacy)) {
    assert.deepEqual(readJson(legacy), setup);
    return { legacyPreserved: true };
  }
  assert(!fs.existsSync(legacy), "Legacy workspace state was not retired");
  const archives = fs
    .readdirSync(workspace)
    .filter((name) => name.startsWith("openclaw-workspace-state.json.migrated."));
  assert.equal(archives.length, 1);
  assert.deepEqual(readJson(path.join(workspace, archives[0])), setup);
  open(sharedPath, (db) => {
    const rows = db
      .prepare("SELECT setup_completed_at FROM workspace_setup_state WHERE workspace_path=?")
      .all(workspace);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].setup_completed_at, setup.setupCompletedAt);
  });
  return { archive: archives[0] };
}
function seed(unsafe) {
  assert(!fs.existsSync(sharedPath) && !fs.existsSync(agentPath));
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const schema = fs.readFileSync("/proof/openclaw-agent-schema-v19.sql", "utf8");
  assert.equal(sha(schema), "fe93217454642e911608f81afc53c9fb3bb7c20cc32bc73f8f6eeaaf232b91b8");
  const sharedFixture = fs.readFileSync("/proof/openclaw-state-v2026.7.1-2.sqlite.gz");
  assert.equal(
    sha(sharedFixture),
    "c775499d9a46462ae2368090a0c4ec75877784c40694046dd3af63df77b8737c",
  );
  fs.writeFileSync(sharedPath, gunzipSync(sharedFixture));
  const now = Date.now();
  const events = [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(now).toISOString(),
      cwd: workspace,
    },
    {
      type: "message",
      id: "retained-message",
      parentId: null,
      timestamp: new Date(now + 1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: marker }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
      },
    },
  ];
  const db = new DatabaseSync(agentPath);
  try {
    db.exec(schema);
    db.exec("PRAGMA user_version=19");
    db.prepare(
      "INSERT INTO schema_meta (meta_key,role,schema_version,agent_id,app_version,created_at,updated_at) VALUES ('primary','agent',?,'main','2026.9.4',1,1)",
    ).run(unsafe ? 18 : 19);
    db.prepare(
      "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,?)",
    ).run(sessionKey, sessionId, JSON.stringify({ sessionId, updatedAt: now }), now);
    db.prepare(
      "INSERT INTO session_windows (session_id,session_key,reason,created_at,updated_at) VALUES (?,?,'initial',?,?)",
    ).run(sessionId, sessionKey, now, now);
    for (const [seq, event] of events.entries()) {
      db.prepare(
        "INSERT INTO transcript_events (session_id,seq,event_json,created_at) VALUES (?,?,?,1)",
      ).run(sessionId, seq, JSON.stringify(event));
    }
  } finally {
    db.close();
  }
  fs.writeFileSync(path.join(workspace, "openclaw-workspace-state.json"), JSON.stringify(setup));
  fs.writeFileSync(
    path.join(state, "openclaw.json"),
    JSON.stringify(
      {
        gateway: {
          mode: "local",
          auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN },
        },
        plugins: { enabled: false },
        agents: { defaults: { workspace } },
      },
      null,
      2,
    ),
  );
  const record = {
    unsafe,
    events,
    schemaSha256: sha(schema),
    agentSha256: sha(fs.readFileSync(agentPath)),
    sharedSha256: sha(fs.readFileSync(sharedPath)),
    agent: logicalSnapshot(agentPath),
    shared: logicalSnapshot(sharedPath),
  };
  assert.equal(record.shared.version, 1);
  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
function verify(mode) {
  const before = readJson(recordPath);
  assertSession(agentPath);
  if (mode !== "migrated") {
    assert.equal(
      sha(fs.readFileSync(agentPath)),
      before.agentSha256,
      "Refusal mutated protected agent bytes",
    );
    assert.deepEqual(logicalSnapshot(agentPath), before.agent);
    if (mode === "old-shape") {
      assert.equal(
        sha(fs.readFileSync(sharedPath)),
        before.sharedSha256,
        "Startup control repaired shared state",
      );
      assert.deepEqual(readJson(path.join(workspace, "openclaw-workspace-state.json")), setup);
    } else if (sha(fs.readFileSync(sharedPath)) !== before.sharedSha256) {
      verifyBackup(sharedPath, before.shared);
    }
    console.log(
      JSON.stringify({
        mode,
        protectedAgentSha256: before.agentSha256,
        workspace: verifyWorkspace(false),
      }),
    );
    return;
  }
  for (const [file, expected] of [
    [agentPath, schemaVersions.agent],
    [sharedPath, schemaVersions.state],
  ]) {
    open(file, (db) => {
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, expected);
      assert.equal(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get()
          .schema_version,
        expected,
      );
    });
  }
  const agentBackup = verifyBackup(agentPath, before.agent);
  const sharedBackup = verifyBackup(sharedPath, before.shared);
  assert.equal(agentBackup.backupId, sharedBackup.backupId, "Migration backups are not paired");
  assertSession(agentBackup.path);
  console.log(
    JSON.stringify({
      mode,
      agentBackup,
      sharedBackup,
      workspace: verifyWorkspace(true),
    }),
  );
}
async function ready() {
  const response = await fetch("http://127.0.0.1:18789/readyz", {
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${process.env.OPENCLAW_GATEWAY_TOKEN}` },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ready, true);
  console.log(JSON.stringify(result));
}
function rpc(method, params) {
  const result = spawnSync(
    process.execPath,
    [
      "/app/openclaw.mjs",
      "gateway",
      "call",
      method,
      "--token",
      process.env.OPENCLAW_GATEWAY_TOKEN,
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const match of result.stdout.matchAll(/^[ \t]*[[{]/gm)) {
    try {
      return JSON.parse(result.stdout.slice(match.index));
    } catch {
      /* CLI diagnostics may precede JSON. */
    }
  }
  throw new Error("Missing public RPC JSON response");
}
const [action, mode] = process.argv.slice(2);
if (action === "seed") {
  seed(mode === "unsafe");
} else if (action === "verify") {
  verify(mode);
} else if (action === "ready") {
  await ready();
} else if (action === "history") {
  rpc("update.status", {});
  const value = rpc("chat.history", { sessionKey, limit: 100 });
  assert(
    value.messages?.some((entry) => {
      const message = entry.message ?? entry;
      return (
        message.role === "assistant" &&
        message.content?.some((part) => part.type === "text" && part.text === marker)
      );
    }),
    "Retained assistant message is missing from public chat.history",
  );
  console.log(JSON.stringify(value));
} else {
  throw new Error(`Unknown fixture action: ${action}`);
}
