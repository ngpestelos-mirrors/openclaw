import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { SessionListSnapshot } from "../lib/sessions/session-capability.ts";
import {
  loadStoredSidebarSessionOwnerFilter,
  storeSidebarSessionOwnerFilter,
  type SidebarSessionOwnerFilter,
} from "./app-sidebar-session-types.ts";

type SessionOwnerFilterContext = {
  gateway: {
    connection: { gatewayUrl: string };
    snapshot: { selfUser?: { id: string } | null };
  };
};

/** Owns saved All filters and invalidates only changes to the effective list query. */
export class SessionOwnerFilterController implements ReactiveController {
  ownerId: string | null = null;
  involvingMe = false;
  private scope: string | null = null;
  private previous?: SidebarSessionOwnerFilter & { scope: string | null };
  private pendingFacetRefresh: Promise<void> | null = null;

  constructor(
    private readonly host: ReactiveControllerHost & {
      isConnected: boolean;
      sidebarSessionOwnerFilter(): SidebarSessionOwnerFilter;
      sessionData: {
        resetSessionList(): void;
        refreshSidebarSessions(): Promise<void>;
      };
    },
    private readonly getContext: () => SessionOwnerFilterContext | undefined,
    // Only the current All query may validate the saved filter. Mine and the
    // navigation-count summary are not evidence that an All owner disappeared.
    private readonly getAllFacet: () => SessionListSnapshot | undefined,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    // Restore before SessionDataController subscribes its initial list. Startup
    // scheduling stays with that owner rather than issuing a second refresh.
    this.restore();
  }

  hostUpdate(): void {
    this.restore();
  }

  hostUpdated(): void {
    if (!this.host.isConnected) {
      return;
    }
    const previous = this.previous;
    const current = { ...this.host.sidebarSessionOwnerFilter(), scope: this.scope };
    this.previous = current;
    if (
      previous &&
      (previous.ownerId !== current.ownerId ||
        previous.involvingMe !== current.involvingMe ||
        previous.scope !== current.scope)
    ) {
      this.host.sessionData.resetSessionList();
      const pending = this.host.sessionData.refreshSidebarSessions();
      this.pendingFacetRefresh = pending;
      void pending.finally(() => {
        if (this.pendingFacetRefresh === pending) {
          this.pendingFacetRefresh = null;
          this.host.requestUpdate();
        }
      });
      return;
    }
    const facet = this.getAllFacet();
    if (
      !this.pendingFacetRefresh &&
      facet &&
      !facet.loading &&
      !facet.startupPending &&
      !facet.error &&
      facet.readSucceeded !== false &&
      facet.result?.owners &&
      this.ownerId &&
      !facet.result.owners.some((owner) => owner.id === this.ownerId)
    ) {
      this.set(null);
    }
  }

  hostDisconnected(): void {
    this.previous = undefined;
    this.pendingFacetRefresh = null;
  }

  set(ownerId: string | null, involvingMe = false): void {
    this.restore();
    this.ownerId = involvingMe ? null : ownerId?.trim() || null;
    this.involvingMe = involvingMe;
    const context = this.getContext();
    const selfUserId = context?.gateway.snapshot.selfUser?.id.trim();
    if (context && selfUserId) {
      storeSidebarSessionOwnerFilter(context.gateway.connection.gatewayUrl, selfUserId, {
        ownerId: this.ownerId,
        involvingMe: this.involvingMe,
      });
    }
    this.host.requestUpdate();
  }

  private restore(): void {
    const context = this.getContext();
    const selfUserId = context?.gateway.snapshot.selfUser?.id.trim();
    const nextScope =
      context && selfUserId
        ? JSON.stringify([context.gateway.connection.gatewayUrl, selfUserId])
        : null;
    if (nextScope === this.scope) {
      return;
    }
    this.scope = nextScope;
    const stored =
      context && selfUserId
        ? loadStoredSidebarSessionOwnerFilter(context.gateway.connection.gatewayUrl, selfUserId)
        : { ownerId: null, involvingMe: false };
    this.ownerId = stored.ownerId;
    this.involvingMe = stored.involvingMe;
    this.host.requestUpdate();
  }
}
