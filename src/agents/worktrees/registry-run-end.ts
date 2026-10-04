import { randomUUID } from "node:crypto";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  withOpenClawStateLeaseWorkerAdmission,
  type WorkerLeaseScope,
} from "../../state/openclaw-state-lease-worker-owner.js";
import type { WorktreeWorkerOperations } from "./dispatch.worker.js";
import type {
  WorktreeRemovalRowInput,
  WorktreeRemovalFinalization,
} from "./registry-run-end.worker.js";
import {
  captureWorktreeRunEndContext,
  retainWorktreeRunEndFailure,
  withWorktreeRunEnd,
} from "./run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "./types.js";

type RunEndCommands = Pick<
  WorktreeWorkerOperations,
  | "worktrees.clearProvisionedChunks"
  | "worktrees.insertProvisionedChunk"
  | "worktrees.claimRemoval"
  | "worktrees.finalizeRemoval"
  | "worktrees.abortRemoval"
>;

function runCommand(
  env: NodeJS.ProcessEnv,
  command: SqliteWorkerCommand<RunEndCommands>,
  authority: WorktreeWorkerAuthority = {},
): Promise<void> {
  const captured = structuredClone(command);
  const predicates = structuredClone(authority.predicates);
  const assertCurrent = authority.assertCurrent;
  const heldLease = authority.lease;
  return withWorktreeRunEnd(env, async () => {
    const context = captureWorktreeRunEndContext(env);
    const execute = async (lease?: WorkerLeaseScope) => {
      let admission: SqliteWorkerOperationAdmission | undefined;
      let settled: Promise<SqliteWorkerOperationSettlement> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        const { runOpenClawStateWorkerOperation } =
          await import("../../state/openclaw-state-worker-store.js");
        await runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            scope.execute({
              type: captured.type,
              input: { ...captured.input, predicates, lease: lease?.identity },
            }),
          {
            assertCurrent: lease?.assertCurrent ?? assertCurrent,
            createAdmission(operation) {
              settled = operation.settled;
              const result = lease
                ? lease.createAdmission(operation)
                : {
                    nativeLocations: [context.admission.databasePath],
                    admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                      context.admission.assertCurrent();
                      assertCurrent?.();
                      grant();
                    }),
                  };
              admission = result.admission;
              return result;
            },
          },
        );
      } catch (error) {
        failure = { error };
      }
      const outcome = await settled;
      if (outcome?.kind === "unknown") {
        throw Object.assign(
          new SqliteWorkerError(
            "Worktree settlement outcome is unknown; recovery custody retained",
            "outcome-unknown",
          ),
          { cause: failure?.error ?? outcome.error },
        );
      }
      // The native receipt acknowledges this exact write without replaying a lost reply.
      if (
        failure &&
        !(outcome?.kind === "completed" && admission?.committed?.facts === captured.input.receipt)
      ) {
        throw failure.error;
      }
    };
    try {
      await (heldLease
        ? withOpenClawStateLeaseWorkerAdmission(
            heldLease,
            context.admission.databasePath,
            execute,
            {
              assertCurrent: () => {
                context.admission.assertCurrent();
                assertCurrent?.();
              },
            },
          )
        : execute());
    } catch (error) {
      retainWorktreeRunEndFailure(error);
      throw error;
    }
  });
}

export function clearRegistryWorktreeProvisionedChunks(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  authority?: WorktreeWorkerAuthority,
): Promise<void> {
  return runCommand(
    env,
    {
      type: "worktrees.clearProvisionedChunks",
      input: { value: { worktreeId }, receipt: randomUUID() },
    },
    authority,
  );
}

export function insertRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  value: { worktreeId: string; path: string; chunkIndex: number; data: Uint8Array },
  authority?: WorktreeWorkerAuthority,
): Promise<void> {
  return runCommand(
    env,
    {
      type: "worktrees.insertProvisionedChunk",
      input: { value: { ...value, data: Uint8Array.from(value.data) }, receipt: randomUUID() },
    },
    authority,
  );
}

export function claimWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  params: WorktreeRemovalRowInput & {
    assertCurrent?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
  },
): Promise<void> {
  const { assertCurrent, workerAuthority, ...value } = params;
  assertCurrent?.();
  return runCommand(
    env,
    { type: "worktrees.claimRemoval", input: { value, receipt: randomUUID() } },
    workerAuthority ?? { assertCurrent },
  );
}

export function finalizeWorktreeRemovalRows(
  env: NodeJS.ProcessEnv,
  value: WorktreeRemovalFinalization,
  authority?: WorktreeWorkerAuthority,
): Promise<void> {
  return runCommand(
    env,
    { type: "worktrees.finalizeRemoval", input: { value, receipt: randomUUID() } },
    authority,
  );
}

export function abortWorktreeRemovalRow(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  token: string,
): Promise<void> {
  return runCommand(env, {
    type: "worktrees.abortRemoval",
    input: { value: { worktreeId, token }, receipt: randomUUID() },
  });
}
