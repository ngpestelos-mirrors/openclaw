import { createHash } from "node:crypto";

/**
 * One fixed lease per sandbox scope. The ID is derived from the scope key so
 * every process that serves the scope replays the same Crabbox operation.
 */
export function crabboxSandboxLeaseId(scopeKey: string): string {
  const digest = createHash("sha256").update(`openclaw-sandbox:${scopeKey}`).digest("hex");
  return `cbx_${digest.slice(0, 12)}`;
}
