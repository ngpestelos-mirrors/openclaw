import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../infra/sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import { assertClawPackageLifecycleWriteArtifact } from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import { runWithOpenClawStateLeaseWorker } from "../state/openclaw-state-lease-worker-operation.js";
import { withOpenClawStateLeaseWorkerAdmission } from "../state/openclaw-state-lease-worker-owner.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type {
  ClawProvenanceAuthority,
  ClawProvenanceMutationOperations,
} from "./provenance-write.worker-contract.js";
import type { ClawSettlementOptions } from "./update-rollback.js";

export async function claimClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions & {
    lease: OpenClawStateWorkerLeaseContext;
    deletion?: AgentDeletionWorkerAuthority;
    nowMs?: number;
    assertCurrent?: () => void;
  },
): Promise<PersistedClawPackageRef> {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  // Store admission can yield before execute captures the command.
  const capturedRef = structuredClone(ref);
  const nowMs = options.nowMs;
  assertClawPackageLifecycleWriteArtifact(options.lease, capturedRef);
  if (options.deletion) {
    return await options.deletion.runWithWorker(
      (scope, deletion, additionalLeases) => {
        const lease = additionalLeases[0];
        if (!lease) {
          throw new Error("Claw package write lost its additional lease");
        }
        return scope.execute({
          type: "clawProvenance.packageStatus",
          input: { ref: capturedRef, status, nowMs, lease, deletion },
        });
      },
      { additionalLeases: [options.lease], assertCurrent: options.assertCurrent },
    );
  }
  const assertCaller = options.assertCurrent?.bind(options);
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertCaller?.();
  };
  const result = await runWithOpenClawStateLeaseWorker(
    options.lease,
    context,
    (scope, identity) =>
      scope.execute({
        type: "clawProvenance.packageStatus",
        input: { ref: capturedRef, status, nowMs, lease: identity },
      }),
    { assertCurrent },
  );
  assertCurrent();
  return result;
}

export function reconcileClawMcpServerRefsInWorker(
  agentId: string,
  digests: Record<string, string>,
  options: OpenClawStateDatabaseOptions & { nowMs?: number; assertCurrent?: () => void },
) {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "clawProvenance.reconcileMcp",
        input: { agentId, digests, nowMs: options.nowMs },
      }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export type ClawProvenanceWriteOptions = OpenClawStateDatabaseOptions &
  ClawSettlementOptions & {
    lease?: OpenClawStateWorkerLeaseContext;
    deletion?: Pick<AgentDeletionWorkerAuthority, "runWithWorker">;
    signal?: AbortSignal;
  };

export async function executeClawProvenanceWrite<
  Key extends keyof ClawProvenanceMutationOperations,
>(
  command: { type: Key; input: ClawProvenanceMutationOperations[Key]["input"] },
  options: ClawProvenanceWriteOptions,
  onCommitted?: (facts: unknown) => void,
): Promise<ClawProvenanceMutationOperations[Key]["output"]> {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  const captured = structuredClone(command);
  const execute = (scope: DomainScope, authority: ClawProvenanceAuthority = {}) =>
    scope.execute({ ...captured, input: { ...captured.input, authority } });
  if (options.deletion) {
    return options.deletion.runWithWorker(
      (scope, deletion, leases) => execute(scope, { deletion, lease: leases[0] }),
      {
        additionalLeases: options.lease ? [options.lease] : [],
        assertCurrent: options.assertCurrent,
        onCommitted,
      },
    );
  }
  const context = captureOpenClawStateWorkerContext({
    path: options.database?.path ?? options.path,
    env: options.env,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
  };
  if (options.lease) {
    return withOpenClawStateLeaseWorkerAdmission(
      options.lease,
      context.admission.databasePath,
      (admission) =>
        runOpenClawStateWorkerOperation(
          context,
          (scope) => execute(scope, { lease: admission.identity }),
          {
            assertCurrent: admission.assertCurrent,
            signal: options.signal,
            createAdmission: (operation) => {
              const retained = admission.createAdmission(operation);
              if (onCommitted) {
                observeSqliteWorkerCommittedFacts(retained.admission, ({ facts }) =>
                  onCommitted(facts),
                );
              }
              return retained;
            },
          },
        ),
      { assertCurrent, signal: options.signal },
    );
  }
  return runOpenClawStateWorkerOperation(context, (scope) => execute(scope), {
    assertCurrent,
    signal: options.signal,
    createAdmission: () => {
      const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
        assertCurrent();
        grant();
      });
      if (onCommitted) {
        observeSqliteWorkerCommittedFacts(admission, ({ facts }) => onCommitted(facts));
      }
      return { admission, nativeLocations: [context.admission.databasePath] };
    },
  });
}
