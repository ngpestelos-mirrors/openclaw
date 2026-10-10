import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import type { ConfigWriteOptions } from "../config/io.types.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { digestClawMcpServer } from "./mcp-digest.js";
import { ClawMcpInstallError, type PersistedClawMcpServerRef } from "./mcp-records.js";
import { readClawMcpServerRefsByName } from "./mcp.kernel.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import {
  executeClawProvenanceWrite,
  readClawProvenance,
  reconcileClawMcpServerRefsInWorker,
  type ClawProvenanceWriteOptions,
} from "./provenance-write.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";
export {
  CLAW_MCP_REF_SCHEMA_VERSION,
  ClawMcpInstallError,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
export { readClawMcpServerRefs, readClawMcpServerRefsByName } from "./mcp.kernel.js";
export { digestClawMcpServer } from "./mcp-digest.js";
function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

export type ClawMcpConfigApplicationOptions = {
  createConfigApplication?: () => {
    writeOptions: ConfigWriteOptions;
    confirm: () => Promise<void>;
  };
};

export async function installClawMcpServers(
  plan: ClawAddPlan,
  options: ClawProvenanceWriteOptions &
    ClawMcpConfigApplicationOptions & {
      setMcpServer?: (params: {
        name: string;
        server: ClawMcpServer;
        createOnly?: boolean;
        configWriteOptions?: ConfigWriteOptions;
        onConfigCommitted?: () => Promise<void>;
      }) => ReturnType<typeof setConfiguredMcpServer>;
      listMcpServers?: typeof listConfiguredMcpServers;
      nowMs?: number;
    } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const setMcpServer = options.setMcpServer ?? setConfiguredMcpServer;
  const listMcpServers = options.listMcpServers ?? listConfiguredMcpServers;
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withClawMcpLifecycleLease(action.id, options, async (assertOwned, lease) => {
      const writeOptions = {
        ...options,
        lease,
        assertCurrent: () => {
          assertOwned();
          options.assertCurrent?.();
        },
      };
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new ClawMcpInstallError(
          "mcp_plan_invalid",
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await listMcpServers();
      if (!listed.ok) {
        throw new ClawMcpInstallError("mcp_preflight_failed", listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestClawMcpServer(server);
      if (configured && digestClawMcpServer(configured) !== configDigest) {
        throw new ClawMcpInstallError(
          "mcp_config_conflict",
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const existingRefs = await readClawMcpServerRefsByNameAsync(action.id, options);
      const inheritsClawOrigin =
        existingRefs.length > 0 &&
        existingRefs.every(
          (candidate) => candidate.origin === "claw-introduced" && !candidate.independentOwner,
        );
      const ownership = configured
        ? {
            relationship: "referenced" as const,
            origin: inheritsClawOrigin ? ("claw-introduced" as const) : ("pre-existing" as const),
            independentOwner: !inheritsClawOrigin,
          }
        : {
            relationship: "managed" as const,
            origin: "claw-introduced" as const,
            independentOwner: false,
          };
      let pending = await persistPendingRefAsync(plan, action.id, server, ownership, writeOptions);
      refs.push(pending);
      if (pending.status === "complete") {
        if (configured) {
          return;
        }
        const hasSiblingOwner = (await readClawMcpServerRefsByNameAsync(action.id, options)).some(
          (candidate) => candidate.agentId !== plan.agent.finalId,
        );
        if (
          pending.relationship !== "managed" ||
          pending.origin !== "claw-introduced" ||
          pending.independentOwner ||
          hasSiblingOwner
        ) {
          throw new ClawMcpInstallError(
            "mcp_reconcile_conflict",
            `MCP server ${JSON.stringify(action.id)} was removed while shared or independently owned and will not be recreated.`,
            refs,
          );
        }
        pending = await updateRefAsync(pending, { status: "pending" }, writeOptions);
        refs[refs.length - 1] = pending;
      }
      if (configured) {
        refs[refs.length - 1] = await updateRefAsync(pending, { status: "complete" }, writeOptions);
        return;
      }
      let result: Awaited<ReturnType<typeof setConfiguredMcpServer>>;
      try {
        writeOptions.assertCurrent();
        const application = options.createConfigApplication?.();
        result = await setMcpServer({
          ...(application
            ? {
                configWriteOptions: application.writeOptions,
                onConfigCommitted: application.confirm,
              }
            : {}),
          name: action.id,
          server,
          createOnly: true,
          recordIndependentOwner: false,
        });
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError("mcp_install_uncertain", message, refs);
      }
      if (!result.ok) {
        refs[refs.length - 1] = await updateRefAsync(
          pending,
          { status: "failed", error: result.error },
          writeOptions,
        );
        throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
      }
      try {
        refs[refs.length - 1] = await updateRefAsync(pending, { status: "complete" }, writeOptions);
      } catch (error) {
        if (hasSqliteWorkerOutcomeUnknown(error)) {
          throw error;
        }
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError(
          "mcp_provenance_failed",
          `MCP server was configured, but ownership could not be persisted: ${message}`,
          refs,
        );
      }
    });
  }
  return refs;
}

export function clawMcpRemovalSelector(ref: PersistedClawMcpServerRef): string {
  return `mcp:${ref.name}`;
}

type ClawMcpServerRemovalDecision = {
  ref: PersistedClawMcpServerRef;
  action: "remove" | "release";
  blocked: boolean;
  affectedClawAgentIds: string[];
  reason?: string;
};

function planMcpRemoval(
  ref: PersistedClawMcpServerRef,
  refs: PersistedClawMcpServerRef[],
  options: { referencedCleanup?: ClawReferencedCleanup },
): ClawMcpServerRemovalDecision {
  const otherRefs = refs.filter((candidate) => candidate.agentId !== ref.agentId);
  const affectedClawAgentIds = otherRefs.map((candidate) => candidate.agentId).toSorted();
  const cleanup = options.referencedCleanup ?? { mode: "retain" };
  const explicitlySelected =
    cleanup.mode === "remove-selected" &&
    (cleanup.selected ?? []).includes(clawMcpRemovalSelector(ref));
  const conflicts =
    affectedClawAgentIds.length > 0 || ref.independentOwner || ref.origin === "pre-existing";
  const release = (reason: string, blocked = false): ClawMcpServerRemovalDecision => ({
    ref,
    action: "release",
    blocked,
    affectedClawAgentIds,
    reason,
  });

  if (ref.relationship === "managed") {
    if (explicitlySelected) {
      return release(
        "--remove-referenced only accepts resources with a referenced relationship.",
        true,
      );
    }
    if (affectedClawAgentIds.length > 0) {
      return release("Another Claw still references this MCP server.");
    }
    if (ref.independentOwner) {
      return release("MCP server has a current non-Claw owner.");
    }
    return { ref, action: "remove", blocked: false, affectedClawAgentIds };
  }
  if (!explicitlySelected && cleanup.mode !== "remove-if-unused") {
    return release("Referenced resources are retained unless a cleanup mode selects them.");
  }
  if (!explicitlySelected && conflicts) {
    return release(
      affectedClawAgentIds.length > 0
        ? "Another Claw still references this MCP server."
        : "MCP server has a current non-Claw owner or pre-existing origin.",
    );
  }
  if (explicitlySelected && conflicts && !cleanup.allowConflicts) {
    return release(
      "Selected MCP server has other Claw dependents, a non-Claw owner, or pre-existing origin; explicit conflict override is required.",
      true,
    );
  }
  return { ref, action: "remove", blocked: false, affectedClawAgentIds };
}

export function reconcileClawMcpServerRefs(
  agentId: string,
  configuredServers: Record<string, Record<string, unknown>>,
  options: OpenClawStateDatabaseOptions & { nowMs?: number; assertCurrent?: () => void } = {},
): Promise<PersistedClawMcpServerRef[]> {
  return reconcileClawMcpServerRefsInWorker(
    agentId,
    Object.fromEntries(
      Object.entries(configuredServers).map(([name, server]) => [
        name,
        digestClawMcpServer(server),
      ]),
    ),
    options,
  );
}

export function planClawMcpServerRemoval(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions & { referencedCleanup?: ClawReferencedCleanup } = {},
) {
  return planMcpRemoval(ref, readClawMcpServerRefsByName(ref.name, options), options);
}
export async function planClawMcpServerRemovalAsync(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions & { referencedCleanup?: ClawReferencedCleanup } = {},
) {
  return planMcpRemoval(ref, await readClawMcpServerRefsByNameAsync(ref.name, options), options);
}

async function persistPendingRefAsync(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">,
  options: ClawProvenanceWriteOptions & { nowMs?: number },
) {
  try {
    return await executeClawProvenanceWrite(
      {
        type: "clawProvenance.mcpPending",
        input: { plan, name, server, ownership, nowMs: options.nowMs },
      },
      options,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "mcp_provenance_conflict") {
      throw new ClawMcpInstallError(
        error.code,
        error.message,
        await readClawMcpServerRefsAsync(plan.agent.finalId, options),
      );
    }
    throw error;
  }
}
function updateRefAsync(
  ref: PersistedClawMcpServerRef,
  update: { status: PersistedClawMcpServerRef["status"]; error?: string },
  options: ClawProvenanceWriteOptions & { nowMs?: number },
) {
  return executeClawProvenanceWrite(
    { type: "clawProvenance.mcpUpdate", input: { ref, update, nowMs: options.nowMs } },
    options,
  );
}
export async function readClawMcpServerRefsAsync(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return (
    (await readClawProvenance({ type: "clawProvenance.readMcp", input: { agentId } }, options)) ??
    []
  );
}
export async function readClawMcpServerRefsByNameAsync(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
) {
  return (
    (await readClawProvenance(
      { type: "clawProvenance.readMcpByName", input: { name } },
      options,
    )) ?? []
  );
}
export function deleteClawMcpServerRef(
  agentId: string,
  name: string,
  options: ClawProvenanceWriteOptions = {},
) {
  return executeClawProvenanceWrite(
    { type: "clawProvenance.mcpDelete", input: { agentId, name } },
    options,
  );
}
export function upsertClawMcpServerRef(
  ref: PersistedClawMcpServerRef,
  options: ClawProvenanceWriteOptions = {},
) {
  return executeClawProvenanceWrite({ type: "clawProvenance.mcpUpsert", input: { ref } }, options);
}
