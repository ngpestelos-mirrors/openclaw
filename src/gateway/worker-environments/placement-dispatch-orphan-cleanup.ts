import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import type {
  PlacementRecoveryDeps,
  WorkerPlacementRecoveryAdmission,
} from "./placement-recovery-contract.js";
import {
  cleanupWorkerWorkspaceResultRef,
  deleteWorkerWorkspaceResultCleanupRefs,
} from "./workspace-result-staging.js";

export async function cleanupPendingWorkspaceResultOrphans(
  deps: PlacementRecoveryDeps,
  admit: WorkerPlacementRecoveryAdmission,
  completedRoots: Set<string>,
): Promise<boolean> {
  if (getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
    return false;
  }
  const { placements } = deps;
  const workspaceSessions = new Map<string, string[]>();
  for (const placement of await placements.readChangeSnapshot()) {
    try {
      const workspace = await deps.resolveWorkspace(placement);
      if (workspace.kind === "repository") {
        continue;
      }
      const root = workspace.path;
      const sessionIds = workspaceSessions.get(root) ?? [];
      sessionIds.push(placement.sessionId);
      workspaceSessions.set(root, sessionIds);
    } catch {
      // Cleanup refs are independently retryable after the next restart.
    }
  }
  let complete = true;
  // The existing minute sweep owns continuation; orphan refs carry no live authority.
  // Keep serial session admission and bound cold-start work independently of history size.
  let remaining = 8;
  for (const [root, sessionIds] of workspaceSessions) {
    if (completedRoots.has(root)) {
      continue;
    }
    if (remaining === 0 || getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
      return false;
    }
    const idleAdmission = tryBeginGatewayRootWorkAdmission("idle-task");
    if (!idleAdmission) {
      return false;
    }
    try {
      let deferred = false;
      const admitted = await idleAdmission.run(() =>
        admit(sessionIds, async () => {
          if (getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0) {
            deferred = true;
            return;
          }
          remaining -= 1;
          await withGitProcessOperation("workspace.result-cleanup", () =>
            deleteWorkerWorkspaceResultCleanupRefs({
              root,
              retainedRefs: async () => {
                const candidates = await placements.readRecoveryCandidates();
                const facts = await placements.readProjection(
                  candidates.map(({ sessionId }) => sessionId),
                  { current: true },
                );
                return new Set(
                  [...facts.pendingResults.values()].flatMap((pending) =>
                    pending.stagedResultRef
                      ? [cleanupWorkerWorkspaceResultRef(pending.stagedResultRef)]
                      : [],
                  ),
                );
              },
            }),
          );
          completedRoots.add(root);
        }),
      );
      complete = admitted && !deferred && complete;
    } catch {
      // Cleanup refs are independently retryable after the next restart.
      completedRoots.add(root);
    } finally {
      idleAdmission.release();
    }
  }
  return complete;
}
