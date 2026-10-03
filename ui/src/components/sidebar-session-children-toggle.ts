import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { isSubagentSessionKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";

export interface SessionChildrenHost {
  readonly sidebarAgentsMode?: "chip" | "roster";
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  toggleSessionChildren(session: SidebarRecentSession): void;
}

export function resolvedChildSessionCount(session: SidebarRecentSession): number {
  const loadedKeys = new Set(session.children.map((child) => child.key));
  const pendingSubagentDetails = session.childSessionKeys.some(
    (key) => isSubagentSessionKey(key) && !loadedKeys.has(key),
  );
  return pendingSubagentDetails ? 0 : session.childSessionKeys.length;
}

export function renderSessionChildrenToggle(
  host: SessionChildrenHost,
  session: SidebarRecentSession,
) {
  const team = host.sidebarAgentsMode === "roster";
  const childrenExpanded = host.isSessionChildrenExpanded(session);
  const label = session.label;
  const count = resolvedChildSessionCount(session);
  return session.childSessionKeys.length > 0
    ? html`<button
        class="sidebar-child-session-toggle ${
          !team && session.runningChildCount > 0
            ? "sidebar-child-session-toggle--running"
            : !team && session.failedChildCount > 0
              ? "sidebar-child-session-toggle--failed"
              : ""
        }"
        type="button"
        data-child-session-toggle=${session.key}
        aria-expanded=${String(childrenExpanded)}
        aria-label=${
          count === 0
            ? t("sessionsView.childSessions")
            : t(
                childrenExpanded
                  ? "sessionsView.hideChildSessions"
                  : "sessionsView.showChildSessions",
                { count: String(session.childSessionKeys.length), session: label },
              )
        }
        aria-description=${
          !team && !childrenExpanded && session.runningChildCount > 0
            ? t("sessionsView.activeRun")
            : nothing
        }
        @click=${() => host.toggleSessionChildren(session)}
      >
        <span class="sidebar-child-session-toggle__icon" aria-hidden="true"
          >${childrenExpanded ? icons.chevronDown : icons.chevronRight}</span
        >
        ${
          childrenExpanded || team || count === 0
            ? nothing
            : html`<span class="sidebar-child-session-toggle__count"
                >${session.childSessionKeys.length}</span
              >`
        }
      </button>`
    : nothing;
}
