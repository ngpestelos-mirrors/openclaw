import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeEvalArgs, resolveTestNodeExecPath } from "../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retires abandoned statement diagnostics at native collection, while retained statements keep their readers", () => {
  const databasePath = path.join(tempDirs.make("sqlite-reader-gc-"), "reader.sqlite");
  const source = `
    import fs from "node:fs";
    import { setImmediate } from "node:timers/promises";
    import { openNodeSqliteDatabase } from ${JSON.stringify(new URL("./node-sqlite.ts", import.meta.url).href)};
    import { readSqliteReaderDiagnosticsForPath, withSqliteReaderOwner } from ${JSON.stringify(new URL("./sqlite-reader-lifecycle.ts", import.meta.url).href)};
    import { onSqliteWalCheckpoint } from ${JSON.stringify(new URL("./sqlite-wal-checkpoint.ts", import.meta.url).href)};
    const pathname = ${JSON.stringify(databasePath)};
    const writer = openNodeSqliteDatabase(pathname);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0; CREATE TABLE events(value TEXT); INSERT INTO events VALUES ('one'), ('two'); PRAGMA wal_checkpoint(TRUNCATE)");
    const reader = openNodeSqliteDatabase(pathname, { readOnly: true });
    let checkpointEvents = 0;
    const unsubscribe = onSqliteWalCheckpoint(() => { checkpointEvents++; });
    const inspect = () => ({
      busy: writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy,
      readers: readSqliteReaderDiagnosticsForPath(pathname).readerCount,
      walBytes: fs.statSync(pathname + "-wal").size,
    });
    // Weak native wrappers and their dependent statements finalize between jobs.
    // Fixed GC/job turns exercise that dependency; no condition is polled.
    const collect = async () => {
      for (let turn = 0; turn < 4; turn++) { await setImmediate(); globalThis.gc(); }
      await setImmediate();
    };
    function abandonPrivate() {
      const statement = reader.prepare("SELECT value FROM events");
      statement.iterate().next();
      return new WeakRef(statement);
    }
    function abandonIterator(statement) {
      const iterator = statement.iterate();
      iterator.next();
      return new WeakRef(iterator);
    }
    try {
      const privateStatement = withSqliteReaderOwner({ operation: "fixture.abandoned-reader", ownerKind: "main" }, abandonPrivate);
      writer.exec("INSERT INTO events VALUES ('three')");
      const before = inspect();
      await collect();
      const collected = { ...inspect(), statementCollected: privateStatement.deref() === undefined };
      const retained = reader.prepare("SELECT value FROM events");
      const iterator = withSqliteReaderOwner({ operation: "fixture.retained-reader", ownerKind: "main" }, () => abandonIterator(retained));
      writer.exec("INSERT INTO events VALUES ('four')");
      await collect();
      const retainedReader = { ...inspect(), iteratorCollected: iterator.deref() === undefined };
      retained.get();
      const released = inspect();
      process.stdout.write(JSON.stringify({ before, collected, retainedReader, released, checkpointEvents }));
    } finally { unsubscribe(); reader.close(); writer.close(); }
  `;
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--disable-warning=ExperimentalWarning",
      "--expose-gc",
      ...createNodeEvalArgs(source, { imports: ["tsx"] }),
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    before: { busy: 1, readers: 1, walBytes: expect.any(Number) },
    collected: { busy: 0, readers: 0, walBytes: 0, statementCollected: true },
    retainedReader: { busy: 1, readers: 1, walBytes: expect.any(Number), iteratorCollected: true },
    released: { busy: 0, readers: 0, walBytes: 0 },
    checkpointEvents: 0,
  });
});
