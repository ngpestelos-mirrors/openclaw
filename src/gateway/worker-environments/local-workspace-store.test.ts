import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  WORKTREE_CREATE_LEASE_SCOPE,
  WORKTREE_MUTATION_LEASE_SCOPE,
} from "../../agents/worktrees/capacity-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "../../state/openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { readLocalWorkspaceProjection, withLocalWorkspaceStore } from "./local-workspace-store.js";
import { localWorkspaceProjectionFixture } from "./local-workspace-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  root = dirs.make("openclaw-local-workspace-worker-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
});
afterEach(() => vi.restoreAllMocks());

it("preserves the acknowledged row when a stale revision conflicts", async () => {
  const worktreeId = randomUUID();
  let committed: Awaited<ReturnType<typeof readLocalWorkspaceProjection>>;
  await expect(
    withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
      const initial = await store.create(localWorkspaceProjectionFixture(worktreeId, root));
      committed = await store.update(initial, {
        baseline_ref: "sha256:accepted",
        baseline_json: "{}",
      });
      expect(store.get()).toEqual(committed);
      await store.update(initial, { baseline_ref: "sha256:stale", baseline_json: "{}" });
    }),
  ).rejects.toThrow("Local workspace binding changed");
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(committed);
  expect(committed).toMatchObject({ revision: 1, baseline_ref: "sha256:accepted" });
});

it.each([
  { scope: WORKTREE_CREATE_LEASE_SCOPE, fault: "expired" },
  { scope: WORKTREE_CREATE_LEASE_SCOPE, fault: "replaced" },
  { scope: WORKTREE_MUTATION_LEASE_SCOPE, fault: "expired" },
  { scope: WORKTREE_MUTATION_LEASE_SCOPE, fault: "replaced" },
])("refuses projection writes under a $fault $scope lease", async ({ scope, fault }) => {
  const worktreeId = randomUUID();
  const database = openOpenClawStateDatabase({ env });
  const context = captureOpenClawStateWorkerContext({ env });
  const run = stateWorker.runOpenClawStateWorkerOperation;
  let revoked = false;
  let aboutToUpdate = false;
  let retainedIdentity: OpenClawStateLeaseIdentity | undefined;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (source, operation, options) =>
      run(
        source,
        (worker) =>
          operation({
            execute: async (command, executeOptions) => {
              if (command.type === "localWorkspace.mutate" && aboutToUpdate) {
                aboutToUpdate = false;
                assert(retainedIdentity);
                const changed = database.db
                  .prepare(
                    fault === "expired"
                      ? "UPDATE state_leases SET expires_at = 0 WHERE scope = ? AND lease_key = ? AND owner = ?"
                      : "UPDATE state_leases SET owner = 'synthetic-successor' WHERE scope = ? AND lease_key = ? AND owner = ?",
                  )
                  .run(retainedIdentity.scope, retainedIdentity.key, retainedIdentity.owner);
                expect(changed.changes).toBe(1);
                revoked = true;
              }
              return worker.execute(command, executeOptions);
            },
          }),
        options,
      ),
  );
  try {
    await expect(
      withOpenClawStateLeaseAsync(
        { scope, key: worktreeId, leaseMs: 60_000, waitMs: 0 },
        context,
        (lease) =>
          withOpenClawStateLeasesWorkerAdmission([lease], context, async (authority) => {
            retainedIdentity = authority.identities[0];
            assert(retainedIdentity);
            return withLocalWorkspaceStore(
              { worktreeId, env, workerAuthority: { leaseSet: { context, leases: [lease] } } },
              async (store) => {
                const initial = await store.create(
                  localWorkspaceProjectionFixture(worktreeId, root),
                );
                aboutToUpdate = true;
                await store.update(initial, { pending_ref: "refs/openclaw/results/refused" });
              },
            );
          }),
      ),
    ).rejects.toThrow(/lease/iu);
    expect(revoked).toBe(true);
    expect(await readLocalWorkspaceProjection(worktreeId, env)).toMatchObject({
      revision: 0,
      pending_ref: null,
    });
  } finally {
    database.db
      .prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
      .run(scope, worktreeId);
  }
});

it("adopts native committed facts after reply loss without replaying the mutation", async () => {
  const worktreeId = randomUUID();
  await withLocalWorkspaceStore({ worktreeId, env }, (store) =>
    store.create(localWorkspaceProjectionFixture(worktreeId, root)),
  );
  const run = stateWorker.runOpenClawStateWorkerOperation;
  let writes = 0;
  const lostReply = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      run(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "localWorkspace.mutate") {
                writes += 1;
                throw new Error("Synthetic local workspace reply lost after native commit");
              }
              return result;
            },
          }),
        options,
      ),
    );
  const pendingRef = "refs/openclaw/results/accepted";
  const acknowledged = await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    const row = await store.update(store.get()!, { pending_ref: pendingRef });
    expect(store.get()).toEqual(row);
    return row;
  });
  lostReply.mockRestore();
  expect(writes).toBe(1);
  expect(acknowledged).toMatchObject({ revision: 1, pending_ref: pendingRef });
  await withLocalWorkspaceStore({ worktreeId, env }, async (store) => {
    expect(store.get()).toEqual(acknowledged);
    await expect(store.delete(store.get()!)).rejects.toThrow("unsettled edits");
  });
  expect(await readLocalWorkspaceProjection(worktreeId, env)).toEqual(acknowledged);
});
