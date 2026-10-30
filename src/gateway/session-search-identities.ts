import pMap from "p-map";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAssistantIdentityName } from "./assistant-identity.js";
import type { prepareSessionRowSelection } from "./session-utils-list.js";

/** Acquire mutable workspace names before entering synchronous visibility and selection. */
export async function prepareSessionSearchIdentityNames(
  prepared: ReturnType<typeof prepareSessionRowSelection>,
  scopeAgentId?: string,
) {
  const agentIds = new Set(scopeAgentId ? [scopeAgentId] : listAgentIds(prepared.cfg));
  for (const [key] of prepared.entries("all")) {
    const agentId = prepared.getTarget(key)?.agentId;
    if (agentId) {
      agentIds.add(agentId);
    }
  }
  const identities = await pMap(
    [...agentIds],
    (agentId) => resolveAssistantIdentityName({ cfg: prepared.cfg, agentId }),
    { concurrency: 4 },
  );
  return {
    cfg: prepared.cfg,
    names: new Map(identities.map(({ agentId, name }) => [agentId, name])),
  };
}
