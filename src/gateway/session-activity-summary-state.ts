import type { SessionActivitySummary } from "../../packages/gateway-protocol/src/schema/sessions-activity-summary.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import {
  ACTIVITY_SUMMARY_FORMAT_REVISION,
  readSessionActivitySummary,
} from "../config/sessions/activity-summary.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  readSessionTranscriptWatermark,
  type SessionTranscriptWatermark,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

export type ActivitySummaryTarget = { key: string; agentId: string };
export function activitySummaryTarget(
  cfg: OpenClawConfig,
  key?: string,
  agentId?: string,
): ActivitySummaryTarget | undefined {
  const agentOwner = agentId ?? (key ? parseAgentSessionKey(key)?.agentId : undefined);
  return key && agentOwner
    ? {
        key: resolveSessionStoreKey({ cfg, sessionKey: key, storeAgentId: agentOwner }),
        agentId: agentOwner,
      }
    : undefined;
}

type SessionActivitySummaryIdentity = ActivitySummaryTarget & {
  sessionId: string;
  lifecycleRevision?: string;
  storePath: string;
  sourceStorePath: string;
  storeAgentId: string;
  rowGeneration: string | symbol;
};

export type SessionActivitySummaryWork = SessionActivitySummaryIdentity & {
  readyAt: number;
  retryPending: boolean;
  failures: number;
  controller?: AbortController;
  inFlight: boolean;
  queued: boolean;
  dirty: boolean;
  immediate: boolean;
  lastStartedAt: number;
  retryAt: number;
  windowStart: number;
  calls: number;
};

export class ActivitySummaryCancelledError extends Error {
  constructor() {
    super("Activity recap lifecycle or utility model changed");
  }
}

export function assertSessionActivitySummaryEntry(
  state: Pick<SessionActivitySummaryWork, "sessionId" | "lifecycleRevision">,
  entry: SessionEntry | undefined,
) {
  if (
    !entry ||
    entry.initializationPending ||
    entry.sessionId !== state.sessionId ||
    entry.lifecycleRevision !== state.lifecycleRevision
  ) {
    throw new ActivitySummaryCancelledError();
  }
  return entry;
}

export function createSessionActivitySummaryWork(
  identity: SessionActivitySummaryIdentity,
  now: number,
): SessionActivitySummaryWork {
  return {
    ...identity,
    readyAt: 0,
    retryPending: false,
    failures: 0,
    inFlight: false,
    queued: false,
    dirty: false,
    immediate: false,
    lastStartedAt: 0,
    retryAt: 0,
    windowStart: now,
    calls: 0,
  };
}

export function refreshSessionActivitySummaryWindow(
  state: Pick<SessionActivitySummaryWork, "windowStart" | "calls">,
  now: number,
  windowMs: number,
): void {
  if (now - state.windowStart >= windowMs) {
    state.windowStart = now;
    state.calls = 0;
  }
}

type PendingState = {
  sessionId: string;
  storePath: string;
  lifecycleRevision?: string;
  state: SessionActivitySummary["state"];
};
const pending = new Map<string, PendingState & { owner: symbol }>();
export const activitySummaryScope = (target: ActivitySummaryTarget) =>
  `${target.agentId}\0${target.key}`;
export const sessionActivitySummaryOwnerIsCurrent = (
  target: ActivitySummaryTarget,
  owner: symbol,
) => pending.get(activitySummaryScope(target))?.owner === owner;
export function setSessionActivitySummaryState(
  target: ActivitySummaryTarget,
  owner: symbol,
  value?: PendingState,
  force = false,
): boolean {
  const key = activitySummaryScope(target);
  const existing = pending.get(key);
  if (value) {
    if (
      !force &&
      existing?.owner === owner &&
      existing.sessionId === value.sessionId &&
      existing.storePath === value.storePath &&
      existing.lifecycleRevision === value.lifecycleRevision &&
      existing.state === value.state
    ) {
      return false;
    }
    pending.set(key, { ...value, owner });
  } else if (existing?.owner === owner) {
    pending.delete(key);
  } else {
    return false;
  }
  sessionChanges.emit({ sessionKey: target.key, agentId: target.agentId });
  return true;
}

/** Activity lists supply batched watermarks; explicit ensure reads one exact target. */
export function projectSessionActivitySummary(
  params: ActivitySummaryTarget & {
    cfg: OpenClawConfig;
    entry: SessionEntry | undefined;
    enabled?: boolean;
    watermark?: SessionTranscriptWatermark;
    /** Physical target for cold reads; pending work retains its configured-path identity. */
    storeTarget?: { agentId: string; storePath: string };
  },
): SessionActivitySummary | undefined {
  const { entry } = params;
  if (!entry) {
    return undefined;
  }
  if (!entry.sessionId || entry.initializationPending) {
    return { state: "unavailable" };
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const summary = readSessionActivitySummary(entry);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.key,
    storeAgentId: params.agentId,
  });
  const runtime = pending.get(activitySummaryScope({ key: canonicalKey, agentId: params.agentId }));
  const validRuntime =
    runtime &&
    runtime.storePath === storePath &&
    runtime.sessionId === entry.sessionId &&
    runtime.lifecycleRevision === entry.lifecycleRevision
      ? runtime
      : undefined;
  const enabled =
    params.enabled ??
    Boolean(resolveUtilityModelRefForAgent({ cfg: params.cfg, agentId: params.agentId }));
  const watermark = summary
    ? (params.watermark ??
      readSessionTranscriptWatermark({
        agentId: params.storeTarget?.agentId ?? params.agentId,
        sessionId: entry.sessionId,
        sessionKey: params.key,
        storePath: params.storeTarget?.storePath ?? storePath,
      }))
    : undefined;
  const fresh =
    summary &&
    summary.formatRevision === ACTIVITY_SUMMARY_FORMAT_REVISION &&
    summary.coveredMessages === summary.totalMessages &&
    watermark?.generation === summary.generation &&
    watermark.maxSeq === summary.maxSeq;
  return {
    ...(summary?.text ? { text: summary.text, updatedAt: summary.updatedAt } : {}),
    state: !enabled
      ? "unavailable"
      : validRuntime?.state === "updating" || validRuntime?.state === "unavailable"
        ? validRuntime.state
        : fresh
          ? "current"
          : "stale",
  };
}
