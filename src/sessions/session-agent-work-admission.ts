import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDeletionJournalStatusInWorker } from "../state/agent-deletion-journal.read.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { collectSessionIdentityTargets } from "./session-lifecycle-identity.js";
import type { HandoffSessionWorkAdmission } from "./session-work-admission-handoff.js";

export type AgentWorkAdmissionTarget = {
  agentId: string;
  statePath?: string;
  env?: NodeJS.ProcessEnv;
};
export type AgentWorkAdmissionIdentity = { agentId: string; statePath: string };
export type SessionWorkAdmissionClosure = {
  identities: readonly string[];
  agent?: AgentWorkAdmissionIdentity;
  reason: Error;
};

export function agentWorkAdmissionIdentity(
  target: AgentWorkAdmissionTarget,
): AgentWorkAdmissionIdentity {
  return {
    agentId: normalizeAgentId(target.agentId),
    statePath: readDatabasePathIdentitySync(
      target.statePath ?? resolveOpenClawStateSqlitePath(target.env ?? process.env),
    ).canonicalPath,
  };
}

export async function assertAgentWorkAdmissionAvailable(
  target: AgentWorkAdmissionTarget,
  signal: AbortSignal,
): Promise<void> {
  const journal = await readAgentDeletionJournalStatusInWorker(
    target.agentId,
    { path: target.statePath, env: target.env },
    signal,
  );
  if (journal !== "absent") {
    throw new Error(`Agent ${target.agentId} deletion is in progress; new work is unavailable.`);
  }
}

function matchesAgentWorkAdmission(
  left: AgentWorkAdmissionIdentity | undefined,
  right: AgentWorkAdmissionIdentity | undefined,
): boolean {
  return Boolean(
    left && right && left.agentId === right.agentId && left.statePath === right.statePath,
  );
}

type AgentSessionWorkAdmission = HandoffSessionWorkAdmission & {
  agent?: AgentWorkAdmissionIdentity;
  phase: "pending" | "acquired";
  released: Promise<void>;
};

/** Agent drains use the lifecycle owner's existing admission index and closures. */
export function createAgentWorkAdmissionQueries<T extends AgentSessionWorkAdmission>(
  admissions: ReadonlyMap<string, ReadonlySet<T>>,
  closures: Set<SessionWorkAdmissionClosure>,
  currentAdmissions: () => ReadonlySet<T> | undefined,
) {
  /** The deletion owner reserves this fence before publishing its durable journal. */
  function closeAgentWorkAdmissions(
    params: AgentWorkAdmissionTarget & { reason: Error },
  ): () => void {
    const agent = agentWorkAdmissionIdentity(params);
    if (
      [...(currentAdmissions() ?? [])].some((admission) =>
        matchesAgentWorkAdmission(admission.agent, agent),
      )
    ) {
      throw new Error("Cannot delete an agent from its own active turn.");
    }
    const owner = {
      agent,
      identities: [],
      reason: params.reason,
    };
    closures.add(owner);
    try {
      interruptSessionWorkAdmissionOwners(collectAgentWorkAdmissions(params, true), params.reason);
    } catch (error) {
      closures.delete(owner);
      throw error;
    }
    return () => {
      closures.delete(owner);
    };
  }

  function assertSessionWorkAdmissionOpen(admission: T): void {
    const closed = [...closures].find(
      (owner) =>
        matchesAgentWorkAdmission(owner.agent, admission.agent) ||
        owner.identities.some((identity) => admission.identities.has(identity)),
    );
    if (closed) {
      if (!admission.interrupted) {
        admission.interrupt?.(closed.reason);
      }
      throw closed.reason;
    }
  }

  function collectAgentWorkAdmissions(target: AgentWorkAdmissionTarget, pendingOnly = false) {
    const agent = agentWorkAdmissionIdentity(target);
    const matching = new Set<T>();
    for (const owners of admissions.values()) {
      for (const admission of owners) {
        if (
          matchesAgentWorkAdmission(admission.agent, agent) &&
          (!pendingOnly || admission.phase === "pending")
        ) {
          matching.add(admission);
        }
      }
    }
    return matching;
  }

  function collectActiveAgentSessionWorkAdmissions(
    target: AgentWorkAdmissionTarget,
  ): Map<string, Set<string>> {
    const identities: string[] = [];
    for (const admission of collectAgentWorkAdmissions(target)) {
      identities.push(...admission.identities);
    }
    return collectSessionIdentityTargets(identities);
  }

  function startAgentWorkAdmissionInterruption(
    params: AgentWorkAdmissionTarget & { reason?: Error },
  ): {
    released: Promise<void>;
    interruptedRunIds: ReadonlySet<string>;
  } {
    return interruptSessionWorkAdmissionOwners(collectAgentWorkAdmissions(params), params.reason);
  }

  return {
    closeAgentWorkAdmissions,
    collectActiveAgentSessionWorkAdmissions,
    startAgentWorkAdmissionInterruption,
    assertSessionWorkAdmissionOpen,
  };
}

export function interruptSessionWorkAdmissionOwners(
  admissions: ReadonlySet<AgentSessionWorkAdmission>,
  reason?: Error,
) {
  const interruptedRunIds = new Set<string>();
  for (const admission of admissions) {
    admission.interrupted ??= reason ?? new Error("Session work admission interrupted");
    const receipt = admission.interrupt?.(admission.interrupted);
    if (receipt) {
      interruptedRunIds.add(receipt.runId);
    }
  }
  return {
    interruptedRunIds,
    released: Promise.all(Array.from(admissions, (admission) => admission.released)).then(
      () => undefined,
    ),
  };
}
