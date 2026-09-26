import fs from "node:fs";
import path from "node:path";
// Pruning keeps durable ingress retention bounded without loading retained rows.
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import { pruneChannelIngressInDatabase } from "./ingress-queue.kernel.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

describe("channel ingress pruning", () => {
  it("does not create a database when no retention work is requested", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      expect(await queue.prune({ protectIds: ["retained"] })).toBe(0);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    });
  });

  it("captures protected ids before worker preparation yields", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });
      await queue.enqueue("a", { text: "retained" });
      await queue.enqueue("z", { text: "expired" });
      const protectIds = new Set([" a ", ""]);
      const pruning = queue.prune({ pendingMaxEntries: 0, protectIds });
      protectIds.clear();
      expect(await pruning).toBe(1);
      expect((await queue.listPending()).map((row) => row.id)).toEqual(["a"]);
    });
  });

  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

      await queue.enqueue("0002", { text: "second" });
      await queue.enqueue("0001", { text: "first" });
      await queue.enqueue("0003", { text: "third" });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it("does not prune protected rows while enforcing max-entry limits", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      await queue.enqueue("z", { text: "first" });
      await queue.enqueue("a", { text: "second" });

      expect(await queue.prune({ pendingMaxEntries: 1, protectIds: ["a"] })).toBe(0);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(["a", "z"]);
    });
  });

  it.each(["pending", "completed", "failed"] as const)(
    "prunes %s overflow in the connection kernel without materializing the retained prefix",
    async (status) => {
      await withTempState(async (stateDir) => {
        let clock = 1;
        const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

        for (let index = 0; index < 520; index += 1) {
          const id = String(index).padStart(4, "0");
          await queue.enqueue(id, { text: String(index) });
          if (status === "completed") {
            await queue.complete(id);
          } else if (status === "failed") {
            await queue.fail(id, { reason: "fixture" });
          }
        }

        const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
        const reads = trackSqliteStatementExecutions(db, ["candidates"], (sql) =>
          sql.startsWith("select") && sql.includes('from "channel_ingress_events"')
            ? "candidates"
            : null,
        );
        try {
          const prune = () =>
            runOpenClawStateWriteTransaction(
              () =>
                pruneChannelIngressInDatabase(db, {
                  queueName: JSON.stringify(["test", "a"]),
                  pendingCutoff: null,
                  completedCutoff: null,
                  failedCutoff: null,
                  pendingMaxEntries: status === "pending" ? 2 : null,
                  completedMaxEntries: status === "completed" ? 2 : null,
                  failedMaxEntries: status === "failed" ? 2 : null,
                  protectIds: [],
                }),
              { env: { OPENCLAW_STATE_DIR: stateDir } },
            );
          expect(prune()).toBe(518);
          expect(reads.rowCounts.candidates).toBe(518);
          expect(prune()).toBe(0);
          expect(reads.rowCounts.candidates).toBe(518);
        } finally {
          reads.restore();
        }
        expect(
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
              .selectFrom("channel_ingress_events")
              .select("event_id")
              .orderBy("event_id", "asc"),
          ).rows.map((row) => row.event_id),
        ).toEqual(["0518", "0519"]);
      });
    },
  );
});
