import { isIncognitoSessionKey } from "../routing/session-key.js";
import { prepareOperatorModelPresentation } from "./operator-model-presentation.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  projectSessionParticipant,
  projectSessionProfileInvolvement,
} from "./session-identity-projection.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import type * as records from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  authorizeIncognitoSessionTarget,
  resolveSessionVisibility,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { prepareProjectedSessionSharing } from "./session-sharing.js";
import { projectGatewaySessionActiveRun } from "./session-utils-display.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

type PresentationOptions = Omit<records.SnapshotOptions, "now" | "active" | "subagentRuns"> & {
  includeActivitySummary?: boolean;
};

/** One synchronous publication owns these immutable views; caller authority is never cached. */
export function createSessionRowPresentationCache() {
  const rows = new WeakSet<object>();
  const viewsByRecord = new WeakMap<
    records.MaterializedRow,
    {
      context: SessionRowReadView["state"]["rowContext"];
      materialized: records.MaterializedRow["materialized"];
      views: Map<string, { row: GatewaySessionRow; models: Map<string, GatewaySessionRow> }>;
    }
  >();
  let revision: SessionRowProjection["presentationRevision"] | undefined;
  let read: SessionRowReadView | undefined;
  const descriptions = new Map<string, records.MaterializedRow | undefined>();
  const children = new Map<string, records.EntryRow[]>();
  return {
    rows,
    read(projection: SessionRowProjection): SessionRowReadView {
      if (!read || revision !== projection.presentationRevision) {
        const state = projection.state;
        descriptions.clear();
        children.clear();
        read = {
          state,
          readSource: projection.readSource.bind(projection),
          readMembership: projection.readMembership.bind(projection),
          present: projection.present,
          describe(query, captured) {
            const key = JSON.stringify([query.agentId, query.storePath, query.key]);
            if (!descriptions.has(key)) {
              descriptions.set(key, projection.describe(query));
            }
            const row = descriptions.get(key);
            return captured && !projection.isCurrent(captured) ? undefined : row;
          },
          selectEntries(query) {
            let selected = children.get(query.key);
            if (!selected) {
              selected = projection.selectEntries(query);
              children.set(query.key, selected);
            }
            return selected;
          },
        };
        revision = projection.presentationRevision;
      }
      return read;
    },
    present(
      record: records.MaterializedRow,
      context: SessionRowReadView["state"]["rowContext"],
      signature: string,
      render: () => GatewaySessionRow,
      models: ReturnType<typeof prepareOperatorModelPresentation>,
    ) {
      let cached = viewsByRecord.get(record);
      if (cached?.context !== context || cached.materialized !== record.materialized) {
        cached = { context, materialized: record.materialized, views: new Map() };
        viewsByRecord.set(record, cached);
      }
      let view = cached.views.get(signature);
      if (!view) {
        view = { row: render(), models: new Map() };
        cached.views.set(signature, view);
      }
      const projected = models?.session(view.row) ?? view.row;
      // Model presentation only removes disallowed fields; their surviving keys identify the view.
      const key = projected === view.row ? "" : JSON.stringify(Object.keys(projected));
      const previous = view.models.get(key);
      if (previous) {
        return previous;
      }
      view.models.set(key, projected);
      rows.add(projected);
      return projected;
    },
  };
}

function toProjectedSessionSharingTarget(record: records.MaterializedRow): SessionSharingTarget {
  return {
    agentId: record.agentId,
    canonicalKey: record.key,
    entry: record.entry,
    storeKey: record.key,
    storeKeys: [record.key],
    storePath: record.storeTarget.storePath,
  };
}

/** Recreate after yields: the caller identity and clock belong to one synchronous presentation. */
export function prepareProjectedSessionPresentation(
  projection: SessionRowReadView,
  client?: GatewayClient | null,
  now = Date.now(),
  projectRun?: ReturnType<typeof createVisibleActiveSessionRunProjector>,
  cache?: ReturnType<typeof createSessionRowPresentationCache>,
) {
  const { cfg, policyConfig, rowContext } = projection.state;
  const models =
    client === undefined
      ? undefined
      : prepareOperatorModelPresentation({ cfg, policyConfig, client });
  const subagentRuns = rowContext.subagentRuns.atTime(now);
  const active = (key: string, entry: records.MaterializedRow["entry"], agentId: string) =>
    projectRun?.({
      requestedKey: key,
      canonicalKey: key,
      sessionId: entry.sessionId,
      agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, key),
    });
  const target = (query: records.Lookup) => {
    const record = projection.describe(query);
    return record ? toProjectedSessionSharingTarget(record) : null;
  };
  const sharing = prepareProjectedSessionSharing({
    cfg: policyConfig,
    client: client ?? null,
    isMember: (value, identityId) =>
      projection
        .readMembership({
          agentId: value.agentId,
          key: value.storeKey,
          storePath: value.storePath,
        })
        ?.has(identityId) ?? false,
  });
  const profile = gatewayClientSessionCreator(client ?? null);
  const profiles = rowContext.userProfileIdentityById;
  const profileId = profile
    ? projectSessionParticipant({ type: "profile", id: profile.id }, profiles).identity.id
    : undefined;
  const viewer = (value: SessionSharingTarget) => ({
    visibility: resolveSessionVisibility(value.entry),
    ...(profileId && !value.entry.incognito && !isIncognitoSessionKey(value.canonicalKey)
      ? {
          hiddenFromInvolvingMe:
            projectSessionProfileInvolvement(value.entry, profileId, profiles)?.hidden ?? false,
        }
      : {}),
    sharingRole: sharing.roleForTarget(value),
  });
  const present = (
    captured: records.MaterializedRow,
    options: PresentationOptions = {},
  ): GatewaySessionRow | null => {
    const record = projection.describe(
      { agentId: captured.agentId, key: captured.key, storePath: captured.storeTarget.storePath },
      captured,
    );
    if (!record) {
      return null;
    }
    const run = active(record.key, record.entry, record.agentId);
    const excludedChildKeys =
      options.excludedChildKeys ??
      new Set(
        record.materialized.source.childLinks?.flatMap(({ key, entry }) =>
          client !== undefined && sharing.entryFilter?.(key, entry) === false ? [key] : [],
        ),
      );
    const excludedSwarmKeys = new Set(
      record.materialized.row.swarm?.groups.flatMap((group) =>
        (group.children ?? []).flatMap(({ sessionKey }) =>
          excludedChildKeys.has(sessionKey) ||
          (client !== undefined &&
            projection
              .selectEntries({ key: sessionKey })
              .some((child) => sharing.entryFilter?.(child.key, child.entry) === false))
            ? [sessionKey]
            : [],
        ),
      ),
    );
    const value = toProjectedSessionSharingTarget(record);
    const viewerFields = client === undefined ? undefined : viewer(value);
    const canEnsure =
      client !== undefined &&
      !authorizeIncognitoSessionTarget({
        client: client ?? null,
        sessionKey: value.canonicalKey,
        target: value,
      }) &&
      !sharing.authorizeTarget(value);
    const render = () => {
      const row = projection.present(record, {
        ...options,
        now,
        subagentRuns,
        active: run?.active,
        excludedChildKeys,
      });
      if (row.swarm) {
        row.swarm = {
          ...row.swarm,
          groups: row.swarm.groups.map((group) => ({
            ...group,
            children: group.children?.filter(
              ({ sessionKey }) => !excludedSwarmKeys.has(sessionKey),
            ),
          })),
        };
      }
      if (run) {
        Object.assign(
          row,
          projectGatewaySessionActiveRun(run, row.status),
          run.runIds === undefined ? {} : { activeRunIds: run.runIds },
        );
      }
      if (options.includeActivitySummary === false) {
        row.activitySummary = undefined;
      }
      if (viewerFields) {
        Object.assign(row, viewerFields);
        if (row.activitySummary) {
          row.activitySummary = { ...row.activitySummary, canEnsure };
        }
      }
      return row;
    };
    if (!cache) {
      const row = render();
      return models?.session(row) ?? row;
    }
    return cache.present(
      record,
      rowContext,
      JSON.stringify([
        now,
        options.includeDerivedTitles,
        options.includeLastMessage,
        options.includeActivitySummary,
        [...excludedChildKeys],
        [...excludedSwarmKeys],
        viewerFields,
        canEnsure,
        run,
        record.facts?.present(),
        record.lastMessagePreview,
        record.fallbackModel,
        record.profileRevision,
        record.subagentRevision,
      ]),
      render,
      models,
    );
  };
  return {
    rowContext: { ...rowContext, subagentRuns },
    active,
    sharing,
    target,
    present,
    snapshot(query: records.Lookup, options: PresentationOptions = {}) {
      const record = projection.describe(query);
      return record
        ? { row: present(record, options), lifecycleRunId: record.entry.lifecycleRunId }
        : { row: null };
    },
    authorizeDescription(query: records.Lookup) {
      return authorizeIncognitoSessionTarget({
        client: client ?? null,
        sessionKey: query.key,
        target: isIncognitoSessionKey(query.key) ? null : target(query),
      });
    },
  };
}
