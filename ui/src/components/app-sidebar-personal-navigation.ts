import type { SessionsListResult } from "../api/types.ts";
import { parseSidebarEntry, serializeSidebarEntry } from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { buildReconciledSidebarZone } from "./app-sidebar-session-navigation-logic.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import { applySidebarSessionOwnerFilter } from "./app-sidebar-session-ownership.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export async function openPersonalPinnedSession(
  host: AppSidebarSessionNavigationElement,
  sessionKey: string,
): Promise<void> {
  const epoch = ++host.personalNavigationEpoch;
  const route = host.activeRouteId;
  const view = host.navigationView;
  const selected = host.getRouteSessionKey();
  const sessions = host.sessionDataContext?.sessions;
  const scope = sessions?.captureConnectionScope();
  if (!sessions || !scope) {
    return;
  }
  const isCurrent = () =>
    host.isConnected &&
    host.personalNavigationEpoch === epoch &&
    host.activeRouteId === route &&
    host.navigationView === view &&
    host.getRouteSessionKey() === selected &&
    sessions === host.sessionDataContext?.sessions &&
    sessions.isConnectionScopeCurrent(scope) &&
    host.sidebarEntries.includes(serializeSidebarEntry({ type: "session", key: sessionKey }));
  try {
    const result = await sessions.describe({ key: sessionKey });
    if (!isCurrent()) {
      return;
    }
    if (!result.session) {
      showToast({ message: t("presence.sessions.unavailable") });
      return;
    }
    host.selectSession(
      sessionKey,
      undefined,
      host.getSessionNavigationState().toSidebarSession(result.session),
    );
  } catch {
    if (isCurrent()) {
      showToast({ message: t("presence.sessions.unavailable") });
    }
  }
}

export function personalSidebarZone(
  host: AppSidebarSessionNavigationElement,
  rows: SidebarRecentSession[],
) {
  const pins = host.sidebarEntries.flatMap((value) => {
    const entry = parseSidebarEntry(value);
    const catalogRow =
      entry?.type === "session"
        ? host.navigationCatalog.dashboards?.result?.sessions.find((row) => row.key === entry.key)
        : undefined;
    const row = catalogRow
      ? host.getSessionNavigationState().toSidebarSession(catalogRow)
      : entry?.type === "session"
        ? host.findSidebarSessionByKey(entry.key)
        : undefined;
    return row ? [row] : [];
  });
  return buildReconciledSidebarZone({
    sidebarEntries: host.sidebarEntries,
    rows: [...rows, ...pins],
    pluginNavigation: host.pluginNavigation(),
    pluginTabs: host.sessionDataContext?.gateway.snapshot.hello?.controlUiTabs,
  });
}

export function projectUnpinnedSessionRows(
  rows: readonly SidebarRecentSession[],
): SidebarRecentSession[] {
  return rows.map((row) => ({
    ...row,
    pinned: false,
    children: projectUnpinnedSessionRows(row.children),
  }));
}

export function personalSidebarOwnerProjection(
  host: AppSidebarSessionNavigationElement,
  projected: SidebarRecentSession[],
  ownerFacet: SessionsListResult["owners"],
) {
  const self = host.sessionDataContext?.gateway.snapshot.selfUser;
  const result = applySidebarSessionOwnerFilter({
    projected,
    ownerFacet,
    selectedOwnerId: host.sessionOwnerFilterId,
    selectedProfileId: host.navigationScope === "mine" ? self?.id : undefined,
    self,
  });
  // Do not flash All's cached rows while the current human is still unknown.
  return host.navigationScope === "mine" && !self?.id ? { ...result, rows: [] } : result;
}
