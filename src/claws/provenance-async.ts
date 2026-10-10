import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateReadResult } from "../state/openclaw-state-read.types.js";

export async function readClawPackageOwnership(
  options: OpenClawStateDatabaseOptions & { agentId?: string; signal?: AbortSignal } = {},
  includeInstalls = false,
): Promise<Omit<Extract<OpenClawStateReadResult, { type: "claws.packageOwnership" }>, "type">> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "claws.packageOwnership", agentId: options.agentId, includeInstalls },
    {
      current: true,
      signal: options.signal,
      mapError(error, phase) {
        if (
          phase === "read" &&
          error instanceof Error &&
          /^no such (?:table|column): /u.test(error.message)
        ) {
          return new SqliteSchemaMismatchError(
            `Claw state is missing required schema (${error.message}); run openclaw doctor --fix to repair it.`,
            { cause: error },
          );
        }
        return error;
      },
    },
  );
  if (!reply) {
    return { install: undefined, installs: [], packageRefs: [], orphanWorkspace: undefined };
  }
  if (!reply.ok || reply.type !== "claws.packageOwnership") {
    throw new Error("Unexpected Claw package ownership result");
  }
  const { install, installs, packageRefs, orphanWorkspace } = reply;
  return { install, installs, packageRefs, orphanWorkspace };
}
