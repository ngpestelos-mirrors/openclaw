import fs from "node:fs/promises";
import { expect, test } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import { directSessionReq, sessionStoreEntry } from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createSessionStoreDir, initializeRemoteBackedGitWorkspace } =
  setupGatewaySessionsWorktreeTestHarness();

test("sessions.create reset-in-place detaches only its shared-worktree membership", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-reset-shared-worktree-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-shared-reset-parent") } });
  let worktreeId: string | undefined;
  try {
    const owner = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true, worktree: true },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(owner.ok).toBe(true);
    worktreeId = owner.payload!.worktree.id;
    const record = getRegistryWorktree(process.env, worktreeId)!;
    const peer = await directSessionReq<{ key: string }>(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: record.name },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(peer.ok).toBe(true);

    const reset = await directSessionReq(
      "sessions.create",
      { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
      { client: { connect: { scopes: ["operator.write"] } } as never },
    );

    expect(reset.ok).toBe(true);
    await expect(fs.access(record.path)).resolves.toBeUndefined();
    expect(managedWorktrees.listSessionBindings(worktreeId)).toEqual([peer.payload!.key]);
  } finally {
    if (worktreeId && getRegistryWorktree(process.env, worktreeId)?.removedAt === undefined) {
      await managedWorktrees.remove({
        id: worktreeId,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    testState.sessionConfig = undefined;
    await state.cleanup();
  }
});
