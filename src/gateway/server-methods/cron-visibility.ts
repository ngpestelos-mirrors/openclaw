import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronSessionTargetSessionKey } from "../../cron/session-target.js";
import type { CronJob } from "../../cron/types.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import type { GatewayClient } from "./types.js";

type CronSessionVisibility = (sessionKey: string, agentId?: string) => boolean;

export function resolveCronSessionVisibility(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): CronSessionVisibility | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (identity && getCronManagementAuthority(identity)) {
    return undefined;
  }
  if (operatorSessionCap(client, cfg) !== "none") {
    return undefined;
  }
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (!entryFilter) {
    return undefined;
  }
  return (sessionKey, agentId) => {
    const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
    return loaded.entry !== undefined && entryFilter(loaded.canonicalKey, loaded.entry);
  };
}

export function cronJobIsVisible(
  job: CronJob,
  visibility: CronSessionVisibility | undefined,
  defaultAgentId: string | undefined,
): boolean {
  if (!visibility) {
    return true;
  }
  const sessionKey =
    job.owner?.sessionKey ??
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    job.sessionKey;
  return Boolean(
    sessionKey && visibility(sessionKey, job.owner?.agentId ?? job.agentId ?? defaultAgentId),
  );
}
