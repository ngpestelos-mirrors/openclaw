import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createSessionEntryWithTranscript } from "./session-accessor.entry-mutation.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("large pending input reads", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-input-reads-");
  const receipts: SessionPendingInputReceipt[] = [];
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:pending-inputs",
    sessionId: "pending-session",
    storePath: fixture.storePath(),
  });
  const database = () => openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope())));
  const message = (runId: string, content: string): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });
  const stage = async (runId: string, options: { message: PersistedUserTurnMessage }) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId,
      ...options,
      assertCurrent: () => {},
    });
    if (!receipt) {
      throw new Error("Missing input fixture");
    }
    receipts.push(receipt);
    return receipt;
  };
  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
    }
    await closeOpenClawAgentDatabasesAsync();
  });
  it("reads large incognito inputs from their process-owned store", async () => {
    const target = {
      ...scope(),
      sessionKey: "agent:main:dashboard:incognito-pending",
      sessionId: "private-pending",
    };
    await createSessionEntryWithTranscript(target, () => ({
      ok: true,
      entry: { incognito: true, sessionId: target.sessionId, updatedAt: 1 },
    }));
    const input = message("private", "private ".repeat(160 * 1024));
    const receipt = await stageSessionPendingInput(target, {
      runId: "private",
      message: input,
      assertCurrent: () => {},
    });
    expect(receipt).toBeDefined();
    receipts.push(receipt!);
    expect(await listSessionPendingInputs(target)).toMatchObject({
      total: 1,
      items: [{ state: "queued", message: input }],
    });
    expect(await readSessionPendingInput(target, receipt!.inputId)).toMatchObject({
      state: "queued",
      message: input,
    });
  });

  it("bounds materialized pending pages by bytes without truncating input or skipping its cursor", async () => {
    const content = "x".repeat(Math.floor(MAX_PAYLOAD_BYTES / 2));
    const first = await stage("large-first", { message: message("large-first", content) });
    const second = await stage("large-second", { message: message("large-second", content) });
    const counter = trackSqliteStatementExecutions(database().db, ["payload"], (sqlText) =>
      sqlText.startsWith("select *") && sqlText.includes('from "session_pending_inputs"')
        ? "payload"
        : null,
    );
    try {
      const page = await listSessionPendingInputs(scope());
      expect(page.items.map((input) => input.id)).toEqual([second.inputId]);
      expect(page.items[0]?.message.content === content).toBe(true);
      expect(page.total).toBe(2);
      expect(page.nextBefore).toBeDefined();
      const older = await listSessionPendingInputs(scope(), { before: page.nextBefore });
      expect(older.items.map((input) => input.id)).toEqual([first.inputId]);
      expect(older.items[0]?.message.content === content).toBe(true);
      expect(older.nextBefore).toBeUndefined();
      expect(await readSessionPendingInput(scope(), first.inputId)).toMatchObject({
        state: "queued",
        message: { content },
      });
      expect(counter.textBytes.payload).toBe(0);
    } finally {
      counter.restore();
    }
  });
  it("keeps large row-count pages out of the host payload reader", async () => {
    const source = await stage("source", { message: message("source", "small") });
    runOpenClawAgentWriteTransaction(
      (current) => {
        const insert = current.db.prepare(`INSERT INTO session_pending_inputs
        (input_id, session_key, session_id, idempotency_key, run_id, request_hash, message_json, lifecycle_generation, state, accepted_at)
        SELECT ?, session_key, session_id, ?, ?, request_hash, ?, lifecycle_generation, 'interrupted', accepted_at
        FROM session_pending_inputs WHERE input_id = ?`);
        for (let index = 0; index < 1024; index++) {
          const id = `retained-${index}`;
          insert.run(id, `${id}:user`, id, JSON.stringify(message(id, "small")), source.inputId);
        }
      },
      toDatabaseOptions(resolveSqliteScope(scope())),
    );
    const counter = trackSqliteStatementExecutions(database().db, ["payload"], (sqlText) =>
      sqlText.startsWith("select *") && sqlText.includes('from "session_pending_inputs"')
        ? "payload"
        : null,
    );
    try {
      const page = await listSessionPendingInputs(scope());
      expect(page.total).toBe(1025);
      expect(page.items).toHaveLength(20);
      expect(page.items[0]?.runId).toBe("retained-1004");
      expect(page.items[19]?.runId).toBe("retained-1023");
      expect(page.nextBefore).toBeDefined();
      expect(counter.textBytes.payload).toBe(0);
    } finally {
      counter.restore();
    }
  });
});
