import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, aroundEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { readSqliteReadOnlyWorkerValue } from "./sqlite-readonly-worker-protocol.js";
import { readSqliteSourceContentVersionSync } from "./sqlite-snapshot-source.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "./state-database-coordinator.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
aroundEach(async (runTest) => {
  await withStateDatabaseCoordinatorRuntimeDirectory(
    tempDirs.make("openclaw-content-coordinator-"),
    runTest,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["", "-wal", "-journal"])(
  "observes changed %s bytes even when size, inode, and observed timestamps match",
  (suffix) => {
    const root = tempDirs.make("openclaw-content-bytes-");
    const source = path.join(root, "source.sqlite");
    const family = [source, source + "-wal", source + "-journal"];
    // These are raw-byte fixtures: the content observer must not parse SQLite.
    for (const file of family) {
      fs.writeFileSync(file, "original");
    }
    const preload = path.join(root, "fixed-timestamps.mjs");
    const witness = path.join(root, "timestamp-witness.txt");
    fs.writeFileSync(
      preload,
      [
        'import fs from "node:fs";',
        "const paths = new Set(" + JSON.stringify(family) + ");",
        "const descriptors = new Set();",
        "const original = { open: fs.openSync, close: fs.closeSync, stat: fs.statSync, fstat: fs.fstatSync };",
        "const witness = " + JSON.stringify(witness) + ";",
        'function fixed(value) { fs.appendFileSync(witness, process.pid + " "); return Object.create(value, { mtimeNs: { value: 0n }, ctimeNs: { value: 0n } }); }',
        "fs.openSync = function(file, ...args) { const fd = original.open(file, ...args); if (paths.has(file)) descriptors.add(fd); return fd; };",
        "fs.closeSync = function(fd) { descriptors.delete(fd); return original.close(fd); };",
        "fs.statSync = function(file, ...args) { const value = original.stat(file, ...args); return paths.has(file) ? fixed(value) : value; };",
        "fs.fstatSync = function(fd, ...args) { const value = original.fstat(fd, ...args); return descriptors.has(fd) ? fixed(value) : value; };",
      ].join("\n"),
    );
    vi.stubEnv(
      "NODE_OPTIONS",
      [process.env.NODE_OPTIONS, "--import=" + pathToFileURL(preload).href]
        .filter(Boolean)
        .join(" "),
    );
    const beforeStat = fs.statSync(source + suffix);
    const before = readSqliteSourceContentVersionSync(source);
    fs.writeFileSync(source + suffix, "modified");
    const afterStat = fs.statSync(source + suffix);
    expect([afterStat.size, afterStat.ino]).toEqual([beforeStat.size, beforeStat.ino]);
    const after = readSqliteSourceContentVersionSync(source);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(after).toMatch(/^[a-f0-9]{64}$/);
    expect(after).not.toBe(before);
    expect(readSqliteSourceContentVersionSync(source)).toBe(after);
    const childPids = new Set(fs.readFileSync(witness, "utf8").trim().split(" ").map(Number));
    expect(childPids.size).toBe(3);
    expect(childPids.has(process.pid)).toBe(false);
  },
);

it("observes content in a child without releasing the parent writer's source lock", () => {
  const source = path.join(tempDirs.make("openclaw-content-lock-"), "source.sqlite");
  const database = new (requireNodeSqlite().DatabaseSync)(source);
  function assertWriterBlocked() {
    const attempt = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import { DatabaseSync } from "node:sqlite";',
          "const database = new DatabaseSync(process.argv[1]);",
          'try { database.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); process.stdout.write("unexpected writer"); database.exec("ROLLBACK"); }',
          "catch (error) { process.stdout.write(JSON.stringify({ blocked: error.errcode === 5 })); }",
          "finally { database.close(); }",
        ].join("\n"),
        source,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(attempt.status, attempt.stderr).toBe(0);
    expect(attempt.stdout).toBe('{"blocked":true}');
  }
  try {
    database.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE test(value); INSERT INTO test VALUES (1); BEGIN IMMEDIATE; UPDATE test SET value=2;",
    );
    assertWriterBlocked();
    const open = vi.spyOn(fs, "openSync");
    expect(readSqliteSourceContentVersionSync(source)).toMatch(/^[a-f0-9]{64}$/);
    expect(open.mock.calls.some(([file]) => file === source)).toBe(false);
    open.mockRestore();
    assertWriterBlocked();
  } finally {
    database.exec("ROLLBACK");
    database.close();
  }
});

it("validates content observation replies without accepting another operation", () => {
  const read = (value: unknown) =>
    readSqliteReadOnlyWorkerValue({ stdout: JSON.stringify(value), stderr: "" }, "content-version");
  expect(read({ ok: true, contentVersion: "a".repeat(64) })).toBe("a".repeat(64));
  expect(read({ ok: true, contentVersion: "" })).toBe("");
  for (const value of [
    { ok: true, contentVersion: "A".repeat(64) },
    { ok: true, contentVersion: "a".repeat(63) },
    { ok: true, contentVersion: "a".repeat(64), extra: true },
    { ok: true, location: "/another-operation" },
  ]) {
    expect(() => read(value)).toThrow(/invalid result|different operation/);
  }
});
