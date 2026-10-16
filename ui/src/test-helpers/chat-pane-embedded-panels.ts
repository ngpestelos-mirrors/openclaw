import { onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult, SessionWorkspaceListResult } from "../api/types.ts";
import { sidebarPanelDefinitions } from "../pages/chat/chat-pane-embedded-panels.ts";
import { createChatPaneRails } from "../pages/chat/chat-pane-rails.ts";
import { renderSidebarRegion } from "../pages/chat/chat-pane-sidebar-layout.ts";
import { SidebarRegionView } from "../pages/chat/chat-pane-sidebar-view.tsx";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionCapabilityFixture,
} from "../pages/chat/chat-pane.test-support.ts";
import { createPageState } from "../pages/chat/chat-state-page.ts";
import type { ChatProps } from "../pages/chat/chat-view.tsx";
import "../pages/chat/components/chat-detail-panel.tsx";
import { createSessionWorkspaceProps } from "../pages/chat/components/chat-session-workspace.ts";
import "../pages/chat/components/chat-sidebar-region.runtime.tsx";
import { threadProps } from "../pages/chat/components/chat-transcript.test-support.ts";
import type { SidebarLayout, SidebarSlotId } from "../pages/chat/sidebar-layout.ts";
import { mountSolid } from "./solid-render.tsx";

const panelViews = new WeakMap<
  HTMLElement,
  {
    primary: HTMLElement;
    update: (props: ReturnType<typeof renderSidebarRegion>) => void;
  }
>();

function ChatPanelPrimary() {
  const primary = document.createElement("main");
  primary.textContent = "Chat";
  return primary;
}

export async function renderPanelFixture(
  mount: HTMLElement,
  layout: SidebarLayout,
  definitions: ReturnType<typeof sidebarPanelDefinitions>,
  closePanelSlot: (slot: SidebarSlotId) => void = vi.fn(),
) {
  const existing = panelViews.get(mount);
  const primary = existing?.primary ?? ChatPanelPrimary();
  const props = renderSidebarRegion({
    presentationId: "sidebar-layout-fixture",
    availableWidth: 1400,
    callbacks: {
      activatePanel: vi.fn(),
      togglePanelExpanded: vi.fn(),
      closeSlot: closePanelSlot,
      openSlot: vi.fn(),
      reorderPanel: vi.fn(),
      resizePanel: vi.fn(),
      setOpen: vi.fn(),
    },
    layout,
    narrow: false,
    panelDefinitions: definitions,
    primary,
    requestUpdate: vi.fn(),
  });
  if (existing) {
    existing.update(props);
  } else {
    const view = mountSolid(SidebarRegionView, props, mount);
    panelViews.set(mount, { primary, update: (next) => view.update(next) });
    onTestFinished(() => panelViews.delete(mount));
  }
  await mount.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
  await mount.querySelector("openclaw-chat-files-panel")?.updateComplete;
  await Promise.all(
    [...mount.querySelectorAll("openclaw-chat-detail-panel")].map((panel) => panel.updateComplete),
  );
  await mount.querySelector("openclaw-panel-loading-skeleton")?.updateComplete;
}

export function createReviewFixture() {
  const file = createDeferred<SessionWorkspaceGetResult | null>();
  const list = createDeferred<SessionWorkspaceListResult | null>();
  const sessions = createSessionCapabilityFixture({
    getFile: vi.fn(() => file.promise),
    listFiles: vi.fn(() => list.promise),
  });
  const mount = document.body.appendChild(document.createElement("div"));
  const context = { ...createInitializationContext(), sessions };
  const state = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    mount,
  );
  state.client = createGatewayBrowserClientFixture();
  state.connected = true;
  state.connectionEpoch = 1;
  state.sessionKey = "agent:main:review-intent";
  state.sidebarLayout = { columns: [] };
  const preview = {
    sessionKey: state.sessionKey,
    root: "/synthetic/workspace",
    file: {
      kind: "read",
      path: "images/preview.png",
      name: "preview.png",
      missing: false,
      previewKind: "image",
      contentEncoding: "base64",
      mimeType: "image/png",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV9kAAAAASUVORK5CYII=",
    },
  } satisfies SessionWorkspaceGetResult;
  const rails = () =>
    createChatPaneRails({
      state,
      sidebarLayout: state.sidebarLayout,
      presentationId: "review-intent",
      presented: true,
      gatewaySnapshot: { ...context.gateway.snapshot, phase: "connected" },
      setObserverVisibility: vi.fn(),
      updateSidebarLayout: state.updateSidebarLayout,
    });
  onTestFinished(async () => {
    file.resolve(null);
    list.resolve(null);
    await Promise.allSettled([file.promise, list.promise]);
  });
  const renderPanels = async () => {
    const { closePanelSlot } = rails();
    const definitions = sidebarPanelDefinitions({
      state,
      detail: {
        chat: threadProps("review-intent", state.sessionKey) as ChatProps,
        host: state,
        requestUpdate: vi.fn(),
      },
      workspace: createSessionWorkspaceProps(state),
    } as Parameters<typeof sidebarPanelDefinitions>[0]);
    await renderPanelFixture(mount, state.sidebarLayout, definitions, closePanelSlot);
  };
  return { context, file, list, mount, preview, rails, renderPanels, sessions, state };
}
