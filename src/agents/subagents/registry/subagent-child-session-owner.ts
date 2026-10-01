import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentIdStrict } from "../../../routing/session-key.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function matchesSubagentChildSessionOwner(
  entry: { childSessionKey?: string; childAgentId?: string },
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  if (entry.childSessionKey !== childSessionKey) {
    return false;
  }
  // Unbound legacy rows and callers without an owner retain raw-key matching.
  if (!entry.childAgentId || childAgentId === undefined) {
    return true;
  }
  const owner = normalizeAgentIdStrict(childAgentId);
  return owner.ok && entry.childAgentId === owner.value;
}

/** Raw child keys need the agent captured when their run was registered. */
export function resolveSubagentChildSessionOwner(
  entry: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId">,
  cfg: OpenClawConfig,
): { agentId: string; storePath: string } {
  const agentId =
    entry.childAgentId ?? resolveSessionAgentId({ config: cfg, sessionKey: entry.childSessionKey });
  return { agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) };
}
