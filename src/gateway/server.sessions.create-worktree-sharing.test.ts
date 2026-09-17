import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { testState } from "./test-helpers.js";
import { directSessionReq, getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";
import { setupGatewaySessionsWorktreeTestHarness } from "./test/server-sessions.worktree-fixture.js";

const { createSessionStoreDir, initializeRemoteBackedGitWorkspace } =
  setupGatewaySessionsWorktreeTestHarness();

test("sessions.create requires participation permission before attaching a named worktree", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-auth-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const owner = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "draft",
        worktree: true,
        worktreeName: "private-worktree",
      },
      { client: identifiedClient("profile-owner") },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;

    const denied = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "private-worktree" },
      { client: identifiedClient("profile-other") },
    );
    expect(denied).toMatchObject({ ok: false });
    expect(managedWorktrees.listSessionBindings(worktreeId, { activeOnly: true })).toEqual([
      owner.payload!.key,
    ]);
  } finally {
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});

test("sessions.create authorizes the worktree that wins concurrent name allocation", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-race-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  const originalCreate = managedWorktrees.createWithOutcome.bind(managedWorktrees);
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  let ownerFinished!: () => void;
  const ownerDone = new Promise<void>((resolve) => {
    ownerFinished = resolve;
  });
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const createSpy = vi
    .spyOn(managedWorktrees, "createWithOutcome")
    .mockImplementation(async (params) => {
      entered += 1;
      const ordinal = entered;
      if (ordinal === 1) {
        markFirstEntered();
      }
      if (ordinal === 2) {
        releaseBoth();
      }
      await bothEntered;
      if (ordinal === 1) {
        const result = await originalCreate(params);
        ownerFinished();
        return result;
      }
      await ownerDone;
      return await originalCreate(params);
    });
  let worktreeId: string | undefined;
  try {
    const ownerPromise = directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", visibility: "draft", worktree: true, worktreeName: "raced" },
      { client: identifiedClient("profile-owner") },
    );
    await firstEntered;
    const deniedPromise = directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "raced" },
      { client: identifiedClient("profile-other") },
    );
    const [owner, denied] = await Promise.all([ownerPromise, deniedPromise]);
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;
    expect(denied).toMatchObject({ ok: false });
    expect(managedWorktrees.listSessionBindings(worktreeId)).toEqual([owner.payload!.key]);
  } finally {
    createSpy.mockRestore();
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});

test("sessions.create removes a newly attached membership when lifecycle commit fails", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-rollback-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  testState.sessionConfig = { sharing: { drafts: false } };
  await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const owner = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "rollback-membership" },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;

    const failed = await directSessionReq(
      "sessions.create",
      {
        agentId: "main",
        visibility: "draft",
        worktree: true,
        worktreeName: "rollback-membership",
      },
      { client: { connect: { scopes: ["operator.admin"] } } as never },
    );
    expect(failed).toMatchObject({ ok: false });
    expect(managedWorktrees.listSessionBindings(worktreeId)).toEqual([owner.payload!.key]);
  } finally {
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
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

test("sessions.create rolls back attachment when peer authorization changes before filesystem access", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-revocation-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  let worktreeId: string | undefined;
  let restoreCreate = () => {};
  try {
    const owner = await directSessionReq<{
      key: string;
      sessionId: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "shared",
        worktree: true,
        worktreeName: "revoked-share",
      },
      { client: identifiedClient("profile-owner") },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;
    const originalCreate = managedWorktrees.createWithOutcome.bind(managedWorktrees);
    const createSpy = vi
      .spyOn(managedWorktrees, "createWithOutcome")
      .mockImplementationOnce(async (params) => {
        const outcome = await originalCreate(params);
        expect(outcome.sessionBindingPreviousState).toBe("absent");
        await patchSessionEntryCore(
          { storePath, sessionKey: owner.payload!.key },
          (entry) => ({ ...entry!, visibility: "draft" }),
          { skipMaintenance: true },
        );
        return outcome;
      });
    restoreCreate = () => createSpy.mockRestore();
    const denied = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "revoked-share" },
      { client: identifiedClient("profile-other") },
    );
    createSpy.mockRestore();

    expect(denied).toMatchObject({
      ok: false,
      error: { message: "session is draft for this connection" },
    });
    expect(managedWorktrees.listSessionBindings(worktreeId)).toEqual([owner.payload!.key]);
  } finally {
    restoreCreate();
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});

test("sessions.create denies a private archived membership before restoring its snapshot", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-restore-auth-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  await createSessionStoreDir();
  try {
    const ownerClient = identifiedClient("profile-owner");
    const owner = await directSessionReq<{
      key: string;
      sessionId: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "draft",
        worktree: true,
        worktreeName: "private-snapshot",
      },
      { client: ownerClient },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    expect(
      await directSessionReq(
        "sessions.patch",
        { key: owner.payload!.key, expectedSessionId: owner.payload!.sessionId, archived: true },
        { client: ownerClient },
      ),
    ).toMatchObject({ ok: true });
    await expect(fs.access(owner.payload!.worktree.path)).rejects.toThrow();

    const denied = await directSessionReq(
      "sessions.create",
      { agentId: "main", worktree: true, worktreeName: "private-snapshot" },
      { client: identifiedClient("profile-other") },
    );

    expect(denied).toMatchObject({
      ok: false,
      error: { message: "session is draft for this connection" },
    });
    await expect(fs.access(owner.payload!.worktree.path)).rejects.toThrow();
    expect(getRegistryWorktree(process.env, owner.payload!.worktree.id)?.removedAt).toEqual(
      expect.any(Number),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});

test("sessions.files.get revalidates every shared peer after participation is revoked", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-session-worktree-sharing-files-auth-",
  });
  const workspace = await initializeRemoteBackedGitWorkspace(state.root);
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace };
  const { storePath } = await createSessionStoreDir();
  let worktreeId: string | undefined;
  try {
    const owner = await directSessionReq<{
      key: string;
      worktree: { id: string; path: string };
    }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "shared",
        worktree: true,
        worktreeName: "revoked-files",
      },
      { client: identifiedClient("profile-owner") },
    );
    expect(owner.ok, JSON.stringify(owner.error)).toBe(true);
    worktreeId = owner.payload!.worktree.id;
    const peerProfile = ensureProfileForEmail("profile-other@example.test");
    setUserProfileRole(peerProfile.id, "writer");
    const peerClient = identifiedClient(peerProfile.id);
    const peer = await directSessionReq<{ key: string }>(
      "sessions.create",
      {
        agentId: "main",
        visibility: "draft",
        worktree: true,
        worktreeName: "revoked-files",
      },
      { client: peerClient },
    );
    expect(peer.ok, JSON.stringify(peer.error)).toBe(true);
    await fs.writeFile(path.join(owner.payload!.worktree.path, "peer-secret.txt"), "private\n");
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const baseConfig = getRuntimeConfig();
    const restrictedConfig = {
      ...baseConfig,
      gateway: {
        ...baseConfig.gateway,
        roles: {
          default: "writer",
          definitions: {
            writer: {
              sessions: { others: "write" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    } as const;
    const authorizationContext = { getRuntimeConfig: () => restrictedConfig } as never;
    const requestParams = { sessionKey: peer.payload!.key, path: "peer-secret.txt" };
    const admitted = resolveSessionMutationAuthorization({
      client: peerClient,
      method: "sessions.files.get",
      requestParams,
      context: authorizationContext,
    });
    expect(admitted.error).toBeNull();
    expect(
      await directSessionReq("sessions.files.get", requestParams, {
        client: peerClient,
        sessionMutationAuthorization: admitted.authorization,
      }),
    ).toMatchObject({ ok: true, payload: { file: { content: "private\n" } } });

    await patchSessionEntryCore(
      { storePath, sessionKey: owner.payload!.key },
      (entry) => ({ ...entry!, visibility: "draft" }),
      { skipMaintenance: true },
    );

    expect(
      resolveSessionMutationAuthorization({
        client: peerClient,
        method: "sessions.files.get",
        requestParams,
        context: authorizationContext,
      }).error,
    ).toMatchObject({ message: "session is draft for this connection" });
  } finally {
    const record = worktreeId ? getRegistryWorktree(process.env, worktreeId) : undefined;
    if (record && record.removedAt === undefined) {
      await managedWorktrees.remove({
        id: record.id,
        reason: "test-cleanup",
        allowSnapshotLoss: true,
      });
    }
    closeOpenClawStateDatabaseForTest();
    testState.agentConfig = undefined;
    await state.cleanup();
  }
});
