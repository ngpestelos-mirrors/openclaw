import type { GatewaySessionRow } from "../api/types.ts";
import {
  isSubagentSessionKey,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import {
  collectSidebarSessionChildKeys,
  resolveSidebarSessionParentKey,
} from "./app-sidebar-session-parent.ts";
import {
  SIDEBAR_SESSION_NO_ATTENTION,
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "./app-sidebar-session-types.ts";

function summarizeChildren(
  children: readonly SidebarRecentSession[],
  unloadedAttention: readonly SidebarSessionAttention[],
  onlySubagents = false,
) {
  const childAttention: SidebarSessionAttention[] = [];
  let unreadChildCount = 0;
  let runningChildCount = 0;
  let failedChildCount = 0;
  let queuedChildCount = 0;
  let workspaceConflictCount = 0;
  for (const child of children) {
    if (onlySubagents && !isSubagentSessionKey(child.key)) {
      continue;
    }
    const descendants = onlySubagents ? child.subagentSummary : child;
    const attention = onlySubagents
      ? summarizeSidebarSessionAttention([
          child.ownAttention ?? child.attention,
          child.subagentSummary?.attention ?? SIDEBAR_SESSION_NO_ATTENTION,
        ])
      : child.attention;
    childAttention.push(
      attention.kind === "error" && attention.childLabel === undefined
        ? { ...attention, childLabel: child.label }
        : attention,
    );
    unreadChildCount += Number(child.unread) + (descendants?.unreadChildCount ?? 0);
    runningChildCount += (child.hasActiveRun ? 1 : 0) + (descendants?.runningChildCount ?? 0);
    failedChildCount +=
      Number(child.status === "failed" || child.status === "timeout") +
      (descendants?.failedChildCount ?? 0);
    queuedChildCount +=
      Number(child.hasActiveRun && child.status === "queued") +
      (descendants?.queuedChildCount ?? 0);
    workspaceConflictCount += onlySubagents
      ? (child.ownWorkspaceConflictCount ?? 0) + (descendants?.workspaceConflictCount ?? 0)
      : (child.workspaceConflictCount ?? 0);
  }
  return {
    attention: summarizeSidebarSessionAttention([...childAttention, ...unloadedAttention]),
    unreadChildCount,
    runningChildCount,
    failedChildCount,
    queuedChildCount,
    workspaceConflictCount,
  };
}

/**
 * Pure projection of flat session rows into the sidebar's parent/child tree.
 * Child links come from both directions (parent childSessions lists and child
 * spawnedBy/parentSessionKey backrefs); the ancestor set guards against cycles
 * in malformed link data.
 */
export function projectSessionTree(params: {
  roots: readonly GatewaySessionRow[];
  mainSessionKeys?: ReadonlySet<string>;
  rowsByKey: ReadonlyMap<string, GatewaySessionRow>;
  loadingChildKeys: ReadonlySet<string>;
  isChildSessionVisible?: (parentKey: string, childKey: string, row?: GatewaySessionRow) => boolean;
  resolveAttention: (row: Pick<GatewaySessionRow, "key" | "agentId">) => SidebarSessionAttention;
  toSidebarSession: (row: GatewaySessionRow, isChild?: boolean) => SidebarRecentSession;
}): SidebarRecentSession[] {
  const {
    roots,
    mainSessionKeys = new Set<string>(),
    rowsByKey,
    loadingChildKeys,
    resolveAttention,
    toSidebarSession,
  } = params;
  const childKeysByParent = collectSidebarSessionChildKeys(rowsByKey, mainSessionKeys);
  const hasRootCategory = (row: GatewaySessionRow | undefined) =>
    typeof row?.category === "string" &&
    row.category.trim().length > 0 &&
    !isSubagentSessionKey(row.key);

  const swarmKeys = new Set<string>();
  for (const row of rowsByKey.values()) {
    if (row.swarmGroupId?.trim()) {
      swarmKeys.add(row.key);
    }
    // Selected-parent summaries can identify a member before child details load.
    for (const group of row.swarm?.groups ?? []) {
      for (const child of group.children ?? []) {
        swarmKeys.add(child.sessionKey);
      }
    }
  }
  const build = (
    row: GatewaySessionRow,
    isChild: boolean,
    ancestors: Set<string>,
  ): SidebarRecentSession => {
    const childSessionKeys =
      row.archived === true
        ? []
        : (childKeysByParent.get(normalizeDefaultMainSessionAliasForUi(row.key)) ?? []).filter(
            (key) =>
              !hasRootCategory(rowsByKey.get(key)) &&
              (params.isChildSessionVisible?.(row.key, key, rowsByKey.get(key)) ?? true),
          );
    const ownsAncestor = !ancestors.has(row.key);
    ancestors.add(row.key);
    const children = childSessionKeys.flatMap((key) => {
      const child = rowsByKey.get(key);
      const projectedChild = child && !ancestors.has(key) ? build(child, true, ancestors) : null;
      return projectedChild ? [projectedChild] : [];
    });
    // Aliased map entries can share row.key with an ancestor; only remove our own entry.
    if (ownsAncestor) {
      ancestors.delete(row.key);
    }
    const projected = toSidebarSession(row, isChild);
    const unloadedChildKeys = childSessionKeys.filter((key) => !rowsByKey.has(key));
    // Parents expose only direct unloaded keys. Loaded descendants fold transitively;
    // terminal outcomes still require child details.
    const unloadedAttention = unloadedChildKeys.map((key) => ({
      key,
      attention: resolveAttention({
        key,
        agentId: parseAgentSessionKey(key)?.agentId ?? projected.agentId,
      }),
    }));
    const summary = summarizeChildren(
      children,
      unloadedAttention.map((entry) => entry.attention),
    );
    const subagentSummary = summarizeChildren(
      children,
      unloadedAttention
        .filter((entry) => isSubagentSessionKey(entry.key))
        .map((entry) => entry.attention),
      true,
    );
    const attention = summarizeSidebarSessionAttention([projected.attention, summary.attention]);
    // Sum descendants before adding the parent's conflicts, then clamp once.
    const workspaceConflictCount = Math.min(
      Number.MAX_SAFE_INTEGER,
      (projected.workspaceConflictCount ?? 0) + summary.workspaceConflictCount,
    );
    // The Gateway flag includes the row's own live or queued subagent run.
    // Only an idle row proves unloaded descendant work from that flag alone.
    const hasUnloadedDescendantRun =
      row.archived !== true && !projected.hasActiveRun && row.hasActiveSubagentRun;
    subagentSummary.runningChildCount = Math.max(
      subagentSummary.runningChildCount,
      hasUnloadedDescendantRun && summary.runningChildCount === 0 ? 1 : 0,
    );
    // Swarm members keep contributing activity, but their navigation lives in
    // the parent's parallel-tasks view, including after completion.
    const navigationChildren = children.flatMap((child) =>
      swarmKeys.has(child.key) ? child.children : [child],
    );
    const navigationKeys = childSessionKeys.filter((key) => !swarmKeys.has(key));
    const childLoadParentKeys = new Set(childSessionKeys.length > 0 ? [row.key] : []);
    for (const child of children) {
      if (swarmKeys.has(child.key)) {
        navigationKeys.push(...child.childSessionKeys);
        for (const key of child.childLoadParentKeys ?? []) {
          childLoadParentKeys.add(key);
        }
      }
    }
    return {
      ...projected,
      ...summary,
      ownAttention: projected.attention,
      ownWorkspaceConflictCount: projected.workspaceConflictCount,
      subagentSummary,
      attention,
      childSessionKeys: [...new Set(navigationKeys)],
      childLoadParentKeys: [...childLoadParentKeys],
      children: navigationChildren,
      loadingChildren: [...childLoadParentKeys].some((key) => loadingChildKeys.has(key)),
      containsActiveDescendant: navigationChildren.some(
        (child) => child.active || child.visuallyActive || child.containsActiveDescendant,
      ),
      workspaceConflictCount: workspaceConflictCount || undefined,
      runningChildCount: Math.max(summary.runningChildCount, hasUnloadedDescendantRun ? 1 : 0),
    };
  };

  const rootKeys = new Set(roots.map((row) => row.key));
  const reattachedRoots = new Set<string>();
  const projectedRoots = roots
    .filter((row) => {
      if (isSubagentSessionKey(row.key)) {
        return false;
      }
      if (hasRootCategory(row)) {
        return true;
      }
      const parentKey = resolveSidebarSessionParentKey(row, mainSessionKeys);
      if (parentKey && isSubagentSessionKey(parentKey)) {
        reattachedRoots.add(row.key);
        return true;
      }
      return !parentKey || !rootKeys.has(parentKey);
    })
    .map((row) => build(row, false, new Set()));
  const nestedKeys = new Set<string>();
  const collectNestedKeys = (rows: readonly SidebarRecentSession[]) => {
    for (const row of rows) {
      for (const child of row.children) {
        nestedKeys.add(child.key);
      }
      collectNestedKeys(row.children);
    }
  };
  collectNestedKeys(projectedRoots);
  // A missing or archived ancestor cannot reattach a row; keep its existing root fallback.
  return projectedRoots.filter((row) => !reattachedRoots.has(row.key) || !nestedKeys.has(row.key));
}
