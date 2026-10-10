import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { AgentDeletionOperation } from "../agents/agent-lifecycle-registry.js";
import { unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpDeletionLease } from "../agents/mcp-lifecycle-lease.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { ClawRemoveError } from "./lifecycle-delete-support.js";
import type { RemovedMcpServer } from "./lifecycle-remove-contract.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import {
  deleteClawMcpServerRef,
  digestClawMcpServer,
  planClawMcpServerRemovalAsync,
  readClawMcpServerRefsByNameAsync,
} from "./mcp.js";
import type { ClawReferencedCleanup } from "./package-remove.js";

type RemoveMcpServerOptions = OpenClawStateDatabaseOptions & {
  config?: OpenClawConfig;
  sourceMcpServers?: Record<string, Record<string, unknown>>;
  listMcpServers?: typeof listConfiguredMcpServers;
  referencedCleanup?: ClawReferencedCleanup;
  unsetMcpServer?: typeof unsetConfiguredMcpServer;
};

export async function removeClawMcpServers(params: {
  agentId: string;
  servers: ClawStatusRecord["mcpServers"];
  options: RemoveMcpServerOptions;
  deletion: AgentDeletionOperation;
}): Promise<{ mcpServers: RemovedMcpServer[]; error?: string }> {
  const listed = params.options.sourceMcpServers
    ? undefined
    : params.options.listMcpServers
      ? await params.options.listMcpServers()
      : params.options.config
        ? undefined
        : await listConfiguredMcpServers();
  await params.deletion.assertCurrentAsync();
  if (listed && !listed.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listed.error);
  }
  const configured = listed?.ok
    ? listed.mcpServers
    : normalizeConfiguredMcpServers(
        params.options.sourceMcpServers ?? params.options.config?.mcp?.servers,
      );
  const unsetMcpServer = params.options.unsetMcpServer ?? unsetConfiguredMcpServer;
  const mcpServers: RemovedMcpServer[] = [];
  for (const server of params.servers) {
    let removalError: string | undefined;
    await params.deletion.assertCurrentAsync();
    await withClawMcpDeletionLease(
      server.name,
      params.deletion,
      async (lease, assertMcpCurrentHost, assertMcpCurrentFinal) => {
        const assertCurrent = () => {
          params.deletion.assertCurrentFinal();
          assertMcpCurrentFinal();
        };
        const assertCurrentAsync = async () => {
          await params.deletion.assertCurrentAsync();
          assertMcpCurrentHost();
        };
        await assertCurrentAsync();
        assertCurrent();
        const currentRef = (
          await readClawMcpServerRefsByNameAsync(server.name, params.options)
        ).find((candidate) => candidate.agentId === params.agentId);
        if (!currentRef) {
          throw new ClawRemoveError(
            "mcp_cleanup_changed",
            `MCP ownership for ${JSON.stringify(server.name)} changed during removal.`,
          );
        }
        const ownerAction = (await planClawMcpServerRemovalAsync(currentRef, params.options))
          .action;
        if (ownerAction === "release") {
          assertCurrent();
          await deleteClawMcpServerRef(params.agentId, server.name, {
            ...params.options,
            lease,
            deletion: params.deletion,
          });
          mcpServers.push({
            name: server.name,
            action: server.state === "missing" ? "missing" : "released",
          });
          return;
        }
        const expectedServer = configured[server.name];
        if (!expectedServer) {
          if (server.state === "present") {
            throw new ClawRemoveError(
              "mcp_cleanup_changed",
              `MCP server ${JSON.stringify(server.name)} disappeared during removal.`,
            );
          }
          assertCurrent();
          await deleteClawMcpServerRef(params.agentId, server.name, {
            ...params.options,
            lease,
            deletion: params.deletion,
          });
          mcpServers.push({ name: server.name, action: "missing" });
          return;
        }
        if (digestClawMcpServer(expectedServer) !== currentRef.configDigest) {
          throw new ClawRemoveError(
            "mcp_cleanup_changed",
            `MCP server ${JSON.stringify(server.name)} changed during removal.`,
          );
        }
        try {
          const result = await unsetMcpServer({
            name: server.name,
            expectedServer,
            recordIndependentOwner: false,
            assertCurrent,
            assertCurrentAsync,
          });
          if (!result.ok) {
            throw new Error(result.error);
          }
          assertCurrent();
          await deleteClawMcpServerRef(params.agentId, server.name, {
            ...params.options,
            lease,
            deletion: params.deletion,
          });
          mcpServers.push({ name: server.name, action: result.removed ? "removed" : "missing" });
        } catch (cause) {
          const message = coerceErrorMessage(cause);
          mcpServers.push({ name: server.name, action: "error", message });
          removalError = message;
        }
      },
    );
    await params.deletion.assertCurrentAsync();
    if (removalError) {
      return { mcpServers, error: removalError };
    }
  }
  return { mcpServers };
}
