import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect } from "vitest";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "./test-helpers.js";

export function usePendingInputFixture(prefix: string) {
  const fixture = useTempSessionsFixture(prefix);
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:consumed-release",
    sessionId: "consumed-session",
    storePath: fixture.storePath(),
  });
  const options = () => toDatabaseOptions(resolveSqliteScope(scope()));
  const database = () => openOpenClawAgentDatabase(options());
  const receipts: SessionPendingInputReceipt[] = [];
  const closeDatabases = async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  };
  const rotateLifecycle = async () => {
    rotateAgentEventLifecycleGeneration();
    await Promise.all(receipts.map((receipt) => receipt.finish("interrupted")));
  };
  const message = (id: string, content = "Synthetic accepted input") => ({
    role: "user" as const,
    content,
    timestamp: 1,
    idempotencyKey: `${id}:user`,
  });
  const stage = async (
    id: string,
    stageOptions: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
  ) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: id,
        message: message(id),
        assertCurrent: () => {},
        ...stageOptions,
      }),
      "Expected staged input custody",
    );
    receipts.push(receipt);
    return receipt;
  };
  const promoteSync = (receipt: SessionPendingInputReceipt) =>
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });
  const promote = (receipt: SessionPendingInputReceipt) =>
    receipt.run(() => appendTranscriptMessage(scope(), { message: receipt.message }));

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    for (const receipt of receipts.splice(0)) {
      await receipt.finish("interrupted");
    }
    await closeDatabases();
  });

  return {
    scope,
    options,
    database,
    receipts,
    closeDatabases,
    rotateLifecycle,
    message,
    stage,
    promoteSync,
    promote,
  };
}
