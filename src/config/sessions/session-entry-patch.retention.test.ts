import "./session-entry-patch-delivery.test-support.js";
import { MessageChannel } from "node:worker_threads";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadAgentTrajectoryOperations } from "../../state/openclaw-agent-execution-operations.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginTrajectoryRuntimeRetention,
  prepareTrajectoryRuntimeRetention,
} from "../../trajectory/runtime-retention.sqlite.js";
import {
  readExactSessionEntryRow,
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { commitSessionEntryPatch } from "./session-entry-patch.worker.js";

it.each([
  { route: "prepared", interleaving: "metadata" },
  { route: "prepared", interleaving: "replacement" },
  { route: "prepared", interleaving: "local before" },
  { route: "prepared", interleaving: "local after" },
  { route: "prepared", interleaving: "local before commit" },
  { route: "prepared", interleaving: "foreign before" },
  { route: "prepared", interleaving: "foreign after" },
  { route: "prepared", interleaving: "rollback" },
  { route: "prepared", interleaving: "revoked lease" },
  { route: "reducer", interleaving: "metadata" },
  { route: "reducer", interleaving: "replacement" },
] as const)(
  "preserves retention freshness without trajectory reads ($route/$interleaving)",
  async ({ route, interleaving }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const options = { agentId: database.agentId, path: database.path };
      const sessionKey = "agent:main:patch-worker";
      const now = Date.parse("2026-07-26T00:00:00.000Z");
      runOpenClawAgentWriteTransaction((current) => {
        writeSessionEntry(current, sessionKey, {
          sessionId: "original",
          updatedAt: 1,
          label: "initial",
        });
        writeSessionEntry(current, "agent:main:retention-history", {
          sessionId: "history",
          updatedAt: 1,
        });
        const insert = current.db.prepare(`INSERT INTO trajectory_runtime_events
        (session_id, seq, run_id, event_json, created_at) VALUES (?, 0, 'run', ?, ?)`);
        insert.run("original", '{"type":"current"}', now);
        insert.run("history", '{"type":"expired"}', now - 15 * 24 * 60 * 60 * 1_000);
      }, options);
      const events = () =>
        database.db
          .prepare("SELECT * FROM trajectory_runtime_events ORDER BY session_id, seq")
          .all();
      const before = events();
      const operations = await loadAgentTrajectoryOperations();
      const prepared = readSessionEntrySelectionSnapshot(database, sessionKey, false);
      const writeBase = prepared[0]!.entry;
      const lease = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(lease, 0, 1);
      const sweepId = beginTrajectoryRuntimeRetention(database.db, lease);
      const snapshot = prepareTrajectoryRuntimeRetention(
        database.db,
        { sessionId: "original" },
        now,
      );
      const competing = new (requireNodeSqlite().DatabaseSync)(database.path);
      const { port1, port2 } = new MessageChannel();
      const refreshHistory = (connection: typeof database.db) => {
        connection
          .prepare(
            "UPDATE trajectory_runtime_events SET created_at = ? WHERE session_id = 'history'",
          )
          .run(now);
      };
      const context: Parameters<typeof commitSessionEntryPatch>[1] = {
        options,
        open: () => database,
        admit() {},
        writeTransaction: (operationLabel, _owner, write) =>
          runOpenClawAgentWriteTransaction(write, options, { operationLabel }),
      };
      const counter = trackSqliteStatementExecutions(database.db, ["trajectory"], (sql) =>
        /^select\b/i.test(sql) && sql.includes('"trajectory_runtime_events"') ? "trajectory" : null,
      );
      const metadata = {
        sessionId: interleaving === "replacement" ? "replacement" : "original",
        label: "metadata committed",
        skillsSnapshot: { prompt: "synthetic cold metadata", skills: [] },
      };
      try {
        if (interleaving === "local before") {
          refreshHistory(database.db);
        } else if (interleaving === "foreign before") {
          refreshHistory(competing);
        }
        const patch = () =>
          admission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
            commitSessionEntryPatch(
              {
                selection: { kind: "entry", sessionKey, exact: false },
                sessionKey,
                ...(route === "reducer"
                  ? { operation: { kind: "fields" as const, patch: metadata } }
                  : { prepared, writeBase, next: { ...writeBase, ...metadata } }),
                operationLabel: "session-entry.patch",
                validateCanonicalKeys: false,
              },
              {
                ...context,
                writeTransaction: (operationLabel, _owner, write) =>
                  runOpenClawAgentWriteTransaction(
                    (current) => {
                      const result = write(current);
                      if (interleaving === "local before commit") {
                        refreshHistory(current.db);
                      } else if (interleaving === "rollback") {
                        throw new Error("synthetic entry rollback");
                      } else if (interleaving === "revoked lease") {
                        Atomics.store(lease, 0, 0);
                      }
                      return result;
                    },
                    options,
                    { operationLabel },
                  ),
              },
            ),
          );
        if (interleaving === "rollback") {
          expect(patch).toThrow("synthetic entry rollback");
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("initial");
        } else {
          patch();
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe(
            "metadata committed",
          );
        }
        expect(counter.counts.trajectory).toBe(0);
        counter.restore();
        if (interleaving === "local after") {
          refreshHistory(database.db);
        } else if (interleaving === "foreign after") {
          refreshHistory(competing);
        }
        const unchanged = interleaving === "metadata" || interleaving === "replacement";
        if (unchanged || interleaving === "rollback" || interleaving === "revoked lease") {
          expect(events()).toEqual(before);
        }
        const result = operations["trajectory.retention.delete"]({ sweepId, snapshot }, context);
        expect(result).toMatchObject({
          complete: unchanged,
          refresh: !unchanged,
          deleted: unchanged ? 1 : 0,
        });
        expect(events().map((row) => row.session_id)).toEqual(
          unchanged ? ["original"] : ["history", "original"],
        );
      } finally {
        counter.restore();
        Atomics.store(lease, 0, 0);
        competing.close();
        port1.close();
        port2.close();
      }
    });
  },
);
