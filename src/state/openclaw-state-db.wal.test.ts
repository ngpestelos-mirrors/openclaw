import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  });
});

beforeAll(() => {
  expect(isMainThread, "Shared-state host admission requires a real process main thread").toBe(
    true,
  );
});

function openWithPeriodicMaintenance(databasePath: string) {
  const intervals = vi.spyOn(globalThis, "setInterval");
  try {
    const database = openOpenClawStateDatabase({ path: databasePath });
    const timers = intervals.mock.calls.filter(([, delay]) => delay === 30 * 60 * 1000);
    expect(timers).toHaveLength(1);
    const periodic = timers[0]?.[0];
    if (typeof periodic !== "function") {
      throw new Error("Shared-state open did not register periodic WAL maintenance");
    }
    return { database, periodic };
  } finally {
    intervals.mockRestore();
  }
}

function observeCheckpoints(pathname: string) {
  const databasePath = sqliteReaderDatabasePathKey(pathname);
  const observations: string[] = [];
  const first = createDeferred();
  const stop = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === databasePath) {
      observations.push(observation.health.state);
      first.resolve();
    }
  });
  return {
    observations,
    stop,
    wait: () => withTestTimeout(first.promise, 5_000, "WAL checkpoint observation timed out"),
  };
}

function sqliteBytes(databasePath: string) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const file = databasePath + suffix;
      return [
        suffix,
        fs.existsSync(file)
          ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
          : null,
      ];
    }),
  );
}

it("yields before periodic maintenance and never waits for a competing SQLite writer", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-native-writer-"), "openclaw.sqlite"),
  );
  const writer = new DatabaseSync(database.path);
  const { observations, wait, stop } = observeCheckpoints(database.path);
  const prepare = database.db.prepare.bind(database.db);
  const nativeTimeouts: unknown[] = [];
  const checkpoint = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("PRAGMA wal_checkpoint(")) {
      nativeTimeouts.push(prepare("PRAGMA busy_timeout").get()?.timeout);
    }
    return prepare(sql);
  });
  try {
    writer.exec("BEGIN IMMEDIATE");
    const nextTurn = setImmediate();
    periodic();
    expect(observations).toEqual([]);
    await nextTurn;
    await wait();
    expect(writer.isTransaction).toBe(true);
    expect(observations.every((state) => state === "complete" || state === "blocked")).toBe(true);
    expect(nativeTimeouts.length).toBeGreaterThan(0);
    expect(nativeTimeouts.every((timeout) => timeout === 0)).toBe(true);
    expect(prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5_000);
  } finally {
    checkpoint.mockRestore();
    stop();
    if (writer.isTransaction) {
      writer.exec("ROLLBACK");
    }
    writer.close();
  }
  // Join the prior scheduler continuation before admitting a new timer tick.
  await setImmediate();
  const afterRelease = observeCheckpoints(database.path);
  try {
    periodic();
    await afterRelease.wait();
    expect(afterRelease.observations[0]).toBe("complete");
  } finally {
    afterRelease.stop();
  }
});

it("refuses checkpoints without borrowing the timer caller's maintenance authority", async () => {
  const { database, periodic } = openWithPeriodicMaintenance(
    path.join(tempDirs.make("state-wal-maintenance-authority-"), "openclaw.sqlite"),
  );
  const owner = acquireGatewayStateOwner({ databasePath: database.path });
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: owner.assertCurrent,
    assertDatabaseAccess: owner.assertDatabaseAccess,
  });
  const before = sqliteBytes(database.path);
  const { observations, wait, stop } = observeCheckpoints(database.path);
  const prepare = vi.spyOn(database.db, "prepare");
  try {
    maintenance.run(() => periodic());
    await wait();
    expect(observations).toEqual(["error"]);
    expect(database.walMaintenance.health?.error).toContain("offline maintenance");
    expect(prepare).not.toHaveBeenCalled();
    expect(database.walMaintenance.checkpoint()).toBe(false);
    expect(observations).toEqual(["error", "error"]);
    expect(prepare).not.toHaveBeenCalled();
    expect(database.db.isOpen).toBe(true);
    expect(sqliteBytes(database.path)).toEqual(before);
  } finally {
    prepare.mockRestore();
    stop();
    try {
      await maintenance.close();
    } finally {
      owner.release();
    }
  }
  await setImmediate();
  const afterRelease = observeCheckpoints(database.path);
  try {
    periodic();
    await afterRelease.wait();
    expect(afterRelease.observations[0]).toBe("complete");
  } finally {
    afterRelease.stop();
  }
});

// Windows cannot rename a directory while SQLite retains its native files.
it.runIf(process.platform !== "win32")(
  "refuses a physically replaced database after periodic admission yields",
  async () => {
    const root = tempDirs.make("state-wal-replacement-");
    const originalDirectory = path.join(root, "original");
    const replacementDirectory = path.join(root, "replacement");
    const displacedDirectory = path.join(root, "displaced");
    const { database, periodic } = openWithPeriodicMaintenance(
      path.join(originalDirectory, "openclaw.sqlite"),
    );
    const replacement = openOpenClawStateDatabase({
      path: path.join(replacementDirectory, "openclaw.sqlite"),
    });
    replacement.db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("replacement", "preserved", "{}", 1);
    await closeOpenClawStateDatabaseByPathAsync(replacement.path);
    const replacementBytes = sqliteBytes(replacement.path);
    const { observations, wait, stop } = observeCheckpoints(database.path);
    let originalMoved = false;
    let replacementInstalled = false;
    try {
      periodic();
      expect(observations).toEqual([]);
      fs.renameSync(originalDirectory, displacedDirectory);
      originalMoved = true;
      fs.renameSync(replacementDirectory, originalDirectory);
      replacementInstalled = true;
      await wait();
      expect(database.walMaintenance.health).toMatchObject({
        state: "error",
        error: expect.stringContaining(
          "SQLite database file identity changed before existing-only open",
        ),
      });
      expect(observations).toEqual(["error"]);
      expect(sqliteBytes(database.path)).toEqual(replacementBytes);
    } finally {
      stop();
      // Restore each SQLite file family before closing the old native connection.
      if (replacementInstalled) {
        fs.renameSync(originalDirectory, replacementDirectory);
      }
      if (originalMoved) {
        fs.renameSync(displacedDirectory, originalDirectory);
      }
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  },
);

it.each(["synchronous", "asynchronous"] as const)(
  "cancels queued periodic maintenance during %s close without replaying it",
  async (mode) => {
    const { database, periodic } = openWithPeriodicMaintenance(
      path.join(tempDirs.make("state-wal-close-"), "openclaw.sqlite"),
    );
    database.db
      .prepare(
        "INSERT INTO diagnostic_events(scope,event_key,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run("maintenance-close", "preserved", "{}", 1);
    const { observations, stop } = observeCheckpoints(database.path);
    try {
      periodic();
      periodic();
      expect(observations).toEqual([]);
      const closed =
        mode === "synchronous"
          ? closeOpenClawStateDatabaseByPath(database.path)
          : await closeOpenClawStateDatabaseByPathAsync(database.path);
      expect(closed).toBe(true);
      expect(database.db.isOpen).toBe(false);
      expect(observations).toEqual(["complete"]);
      periodic();
      await setImmediate();
      expect(observations).toEqual(["complete"]);
      const reopened = openOpenClawStateDatabase({ path: database.path });
      expect(
        reopened.db
          .prepare("SELECT event_key FROM diagnostic_events WHERE scope=?")
          .all("maintenance-close"),
      ).toEqual([{ event_key: "preserved" }]);
    } finally {
      stop();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  },
);
