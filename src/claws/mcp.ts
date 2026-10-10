import { coerceErrorMessage } from "@openclaw/normalization-core";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { digestClawMcpServer } from "./mcp-digest.js";
import { ClawMcpInstallError, type PersistedClawMcpServerRef } from "./mcp-records.js";
import { persistPendingRef, updateRef, readClawMcpServerRefsByName } from "./mcp.kernel.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import { reconcileClawMcpServerRefsInWorker } from "./provenance-write.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export { digestClawMcpServer } from "./mcp-digest.js";
export {
  CLAW_MCP_REF_SCHEMA_VERSION,
  ClawMcpInstallError,
  type PersistedClawMcpServerRef,
} from "./mcp-records.js";
export {
  readClawMcpServerRefs,
  readClawMcpServerRefsByName,
  deleteClawMcpServerRef,
  upsertClawMcpServerRef,
} from "./mcp.kernel.js";

function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

export async function installClawMcpServers(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    setMcpServer?: (params: {
      name: string;
      server: ClawMcpServer;
      createOnly?: boolean;
    }) => ReturnType<typeof setConfiguredMcpServer>;
    listMcpServers?: typeof listConfiguredMcpServers;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const setMcpServer = options.setMcpServer ?? setConfiguredMcpServer;
  const listMcpServers = options.listMcpServers ?? listConfiguredMcpServers;
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withClawMcpLifecycleLease(action.id, options, async () => {
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
      const existingRefs = readClawMcpServerRefsByName(action.id, options);
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
      let pending = persistPendingRef(plan, action.id, server, ownership, options);
      refs.push(pending);
      if (pending.status === "complete") {
        if (configured) {
          return;
        }
        const hasSiblingOwner = readClawMcpServerRefsByName(action.id, options).some(
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
        pending = updateRef(pending, { status: "pending" }, options);
        refs[refs.length - 1] = pending;
      }
      if (configured) {
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
        return;
      }
      let result: Awaited<ReturnType<typeof setConfiguredMcpServer>>;
      try {
        result = await setMcpServer({
          name: action.id,
          server,
          createOnly: true,
          recordIndependentOwner: false,
        });
      } catch (error) {
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError("mcp_install_uncertain", message, refs);
      }
      if (!result.ok) {
        refs[refs.length - 1] = updateRef(
          pending,
          { status: "failed", error: result.error },
          options,
        );
        throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
      }
      try {
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
      } catch (error) {
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

export function planClawMcpServerRemoval(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions & { referencedCleanup?: ClawReferencedCleanup } = {},
): ClawMcpServerRemovalDecision {
  const otherRefs = readClawMcpServerRefsByName(ref.name, options).filter(
    (candidate) => candidate.agentId !== ref.agentId,
  );
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
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
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
