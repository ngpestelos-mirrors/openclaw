import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { readUserBackgroundCommand } from "../../state/user-background.kernel.js";
import {
  ensureUserBackgroundSchema,
  writeUserBackgroundImage,
} from "../../state/user-background.store.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { runSqliteReadSnapshotSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL background reads", () => {
  useMixedAgentPair("postgres", "postgres");
  it("reads backgrounds while a writer holds the store lock and joins enclosing snapshots", async () => {
    const options = { env: process.env };
    const blocker = new pg.Client({ connectionString: mixedAgentConnection });
    await blocker.connect();
    try {
      const { database, first, second, facts } = withEngineStoreAdmission(() => {
        const firstProfile = ensureProfileForEmail("first@example.test", options);
        const secondProfile = ensureProfileForEmail("second@example.test", options);
        const opened = openOpenClawStateDatabase(options);
        const physical = getPostgresPhysicalFacts(opened.db);
        assert(physical, "Expected PostgreSQL state admission");
        opened.db.exec("SET lock_timeout = '100ms'");
        ensureUserBackgroundSchema(options);
        writeUserBackgroundImage(opened.db, {
          profile_id: secondProfile.id,
          asset_id: "target-background",
          image: Buffer.from([255, 216, 255, 217]),
          width: 1,
          height: 1,
        });
        return { database: opened, first: firstProfile, second: secondProfile, facts: physical };
      });
      const read = () => {
        const reply = readUserBackgroundCommand(database.db, {
          type: "userBackground.snapshot",
          profileId: first.id,
        });
        assert(reply.type === "userBackground.snapshot", "Expected background snapshot");
        return reply;
      };
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        createHash("sha256").update(facts.storeId).digest().readBigInt64BE().toString(),
      ]);
      const empty = { status: "ok", asset: null, preference: null };
      expect(withEngineStoreAdmission(read).result).toEqual(empty);
      await blocker.query("ROLLBACK");

      withEngineStoreAdmission(() => {
        runSqliteReadSnapshotSync(database.db, () => {
          expect(read().result).toEqual(empty);
          expect(database.db.isTransaction).toBe(true);
          expect(
            database.db.prepare("SHOW transaction_read_only").get()?.transaction_read_only,
          ).toBe("on");
        });
        expect(() =>
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?").run(
                second.id,
                first.id,
              );
              expect(read().result).toEqual({
                status: "ok",
                asset: {
                  assetId: "target-background",
                  width: 1,
                  height: 1,
                  mime: "image/jpeg",
                  byteLength: 4,
                },
                preference: null,
              });
              expect(db.isTransaction).toBe(true);
              throw new Error("rollback enclosing write");
            },
            { database },
          ),
        ).toThrow("rollback enclosing write");
        expect(read().result).toEqual(empty);
      });
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });
});
