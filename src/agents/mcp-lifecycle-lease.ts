import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type {
  OpenClawStateAsyncLeaseContext,
  OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease-context.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";

const MCP_LIFECYCLE_LEASE_OPTIONS = {
  scope: "core:claw-mcp-lifecycle",
  leaseMs: 5 * 60_000,
  waitMs: 10 * 60_000,
  leaseLabel: "Claw MCP lifecycle lease",
  operationLabel: "claws.mcp.lifecycle.lease",
};

type McpLifecycleLeaseOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path" | "database"> & {
  signal?: AbortSignal;
};

/** Serialize ownership decisions and global config mutations for one MCP server. */
export async function withMcpLifecycleLease<T>(
  name: string,
  options: McpLifecycleLeaseOptions,
  run: (assertOwned: () => void, lease: OpenClawStateLeaseContext) => Promise<T>,
): Promise<T> {
  return await withOpenClawStateLease(
    {
      ...MCP_LIFECYCLE_LEASE_OPTIONS,
      key: name.trim(),
      database: {
        scope: "shared",
        options: {
          ...(options.env ? { env: options.env } : {}),
          ...(options.path ? { path: options.path } : {}),
          ...(options.database ? { database: options.database } : {}),
        },
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
    async (lease) => {
      lease.assertOwned();
      const result = await run(() => lease.assertOwned(), lease);
      lease.assertOwned();
      return result;
    },
  );
}

export const withClawMcpLifecycleLease = withMcpLifecycleLease;

export function withClawMcpDeletionLease<T>(
  name: string,
  deletion: AgentDeletionWorkerAuthority,
  operation: (
    lease: OpenClawStateAsyncLeaseContext,
    assertCurrentHost: () => void,
    assertCurrentFinal: () => void,
  ) => Promise<T>,
): Promise<T> {
  return deletion.withStateLease({ ...MCP_LIFECYCLE_LEASE_OPTIONS, key: name.trim() }, operation);
}
