import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntryPatchInDatabase } from "./session-accessor.sqlite-entry-mutation.js";
import {
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry, patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import type { SessionEntry } from "./types.js";

it("skips unchanged entry and snapshot writes while retaining current transcript observation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:entry-noop" };
    const database = openOpenClawAgentDatabase(scope);
    const skillsSnapshot = { prompt: "saved prompt", skills: [] };
    runOpenClawAgentWriteTransaction(
      (writer) =>
        writeSessionEntry(writer, scope.sessionKey, {
          sessionId: "entry-noop",
          updatedAt: 10,
          skillsSnapshot,
        }),
      scope,
    );
    const assertCommitAllowed = vi.fn();
    const onCommitted = vi.fn();
    const patch = (fields: Partial<SessionEntry>) =>
      patchSessionEntryCore(scope, () => fields, {
        assertCommitAllowed,
        onCommitted,
        preserveActivity: true,
        skipMaintenance: true,
      });
    // Settle the initial transcript observation before measuring unchanged rows.
    await patch({});
    const sql = trackSqliteStatementExecutions(
      database.db,
      ["nodes", "windows", "snapshots"],
      (query) => {
        const table = /^(?:insert into|update|delete from) "([^"]+)"/iu.exec(query)?.[1];
        return table === "session_nodes"
          ? "nodes"
          : table === "session_windows"
            ? "windows"
            : table === "session_entry_snapshots"
              ? "snapshots"
              : null;
      },
    );
    try {
      assertCommitAllowed.mockClear();
      onCommitted.mockClear();
      await expect(
        patch({ skillsSnapshot: structuredClone(skillsSnapshot) }),
      ).resolves.toMatchObject({
        updatedAt: 10,
        skillsSnapshot,
      });
      expect(sql.counts).toEqual({ nodes: 0, windows: 0, snapshots: 0 });
      expect(assertCommitAllowed).toHaveBeenCalled();
      expect(onCommitted).toHaveBeenCalledOnce();

      await patch({
        lastRunError: "retained error",
        skillsSnapshot: structuredClone(skillsSnapshot),
      });
      expect(sql.counts).toEqual({ nodes: 1, windows: 0, snapshots: 0 });
      expect(loadExactSessionEntry(scope)?.entry).toMatchObject({
        lastRunError: "retained error",
        skillsSnapshot,
      });

      expect(
        appendTranscriptMessageSync(
          { ...scope, sessionId: "entry-noop" },
          { message: { role: "user", content: "new transcript content" } },
        ).ok,
      ).toBe(true);
      const before = { ...sql.counts };
      const watermark = () =>
        database.db
          .prepare(
            "SELECT transcript_observed_at, transcript_updated_at FROM session_windows WHERE session_id = ?",
          )
          .get("entry-noop");
      const unobserved = watermark();
      expect(unobserved?.transcript_observed_at).not.toBe(unobserved?.transcript_updated_at);
      await patch({ skillsSnapshot: structuredClone(skillsSnapshot) });
      expect(sql.counts).toEqual({ ...before, windows: before.windows + 1 });
      const observed = watermark();
      expect(observed?.transcript_observed_at).toBe(observed?.transcript_updated_at);
      const settled = { ...sql.counts };
      await patch({});
      expect(sql.counts).toEqual(settled);
    } finally {
      sql.restore();
    }
  });
});

it("reuses patch postimages only until a participant write changes the transaction", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:entry-postimage" };
    const database = openOpenClawAgentDatabase(scope);
    runOpenClawAgentWriteTransaction(
      (writer) =>
        writeSessionEntry(writer, scope.sessionKey, {
          sessionId: "entry-postimage",
          updatedAt: 10,
          skillsSnapshot: { prompt: "private saved prompt", skills: [] },
        }),
      scope,
    );
    recordSessionParticipant(scope, { identity: { type: "agent", id: "first" }, promptedAt: 10 });
    const sql = trackSqliteStatementExecutions(database.db, ["participants", "windows"], (query) =>
      /^select\b.*\bfrom "session_participants"/iu.test(query)
        ? "participants"
        : query.includes('from "session_windows" where "session_id" =')
          ? "windows"
          : null,
    );
    try {
      runOpenClawAgentWriteTransaction((writer) => {
        const fresh = readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true);
        const original = fresh[0]?.entry;
        if (!original) {
          throw new Error("Missing seeded entry");
        }
        const mutation = writeSessionEntryPatchInDatabase(writer, {
          sessionKey: scope.sessionKey,
          fresh,
          writeBase: original,
          next: { ...original, lastRunError: "updated" },
          options: {},
          reusePostimage: true,
        });
        if (!mutation.identity || !mutation.postimages) {
          throw new Error("Missing committed patch postimage");
        }
        expect(sql.counts.windows).toBe(0);
        const committed = {
          ...mutation.identity,
          pendingArchiveRecovery: false,
          maintenancePlans: [],
          membershipInvalidatedKeys: [],
        };
        const before = sql.counts.participants;
        const retained = prepareSessionEntryReplacementPublication(
          committed,
          writer,
          mutation.postimages,
        );
        expect(sql.counts.participants).toBe(before);
        expect(retained.current.get(scope.sessionKey)).toMatchObject({
          lastRunError: "updated",
          participants: [{ identity: { type: "agent", id: "first" } }],
          participantCount: 1,
        });
        expect(retained.current.get(scope.sessionKey)).not.toHaveProperty("skillsSnapshot");

        recordSessionParticipant(scope, {
          identity: { type: "agent", id: "later" },
          promptedAt: 20,
        });
        const afterWrite = sql.counts.participants;
        const refreshed = prepareSessionEntryReplacementPublication(
          committed,
          writer,
          mutation.postimages,
        );
        expect(sql.counts.participants).toBeGreaterThan(afterWrite);
        expect(refreshed.current.get(scope.sessionKey)).toMatchObject({
          participants: [
            { identity: { type: "agent", id: "first" } },
            { identity: { type: "agent", id: "later" } },
          ],
          participantCount: 2,
        });

        const stale = readSessionEntrySelectionSnapshot(writer, scope.sessionKey, true, true);
        const staleEntry = stale[0]?.entry;
        if (!staleEntry) {
          throw new Error("Missing patched entry");
        }
        writer.db
          .prepare("UPDATE session_windows SET transcript_updated_at = 123 WHERE session_id = ?")
          .run(staleEntry.sessionId);
        writeSessionEntryPatchInDatabase(writer, {
          sessionKey: scope.sessionKey,
          fresh: stale,
          writeBase: staleEntry,
          next: { ...staleEntry, lastRunError: "after transcript update" },
          options: {},
          reusePostimage: true,
        });
        expect(sql.counts.windows).toBe(1);
        expect(
          writer.db
            .prepare("SELECT transcript_observed_at FROM session_windows WHERE session_id = ?")
            .get(staleEntry.sessionId),
        ).toEqual({ transcript_observed_at: 123 });
      }, scope);
    } finally {
      sql.restore();
    }
  });
});
