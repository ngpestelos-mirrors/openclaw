import { createComponent } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiNavigationItem } from "../../../../src/plugin-sdk/control-ui.js";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Icon } from "../../components/solid/icon.tsx";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { selectSidebarView } from "../app-sidebar-setup.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { createDataTransferStub } from "../drag-data.ts";
import { mountSolid } from "../mount-solid.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.tsx";
import "../../plugins/control-ui-view.solid.tsx";
import "../../plugins/control-ui-contributions.solid.tsx";

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

function zoneEntry(sidebar: SidebarLifecycleState, entry: string): HTMLElement {
  return required(sidebar.querySelector<HTMLElement>(`[data-sidebar-entry="${entry}"]`));
}

function required<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("Expected fixture value");
  }
  return value;
}

function pluginEntry(sidebar: SidebarLifecycleState, id: string, area = "pages") {
  return sidebar.querySelector<HTMLElement>(`.sidebar-${area} [data-sidebar-entry="plugin:${id}"]`);
}

function entryOrder(sidebar: Element, selector: string) {
  return [...sidebar.querySelectorAll<HTMLElement>(selector)].map(
    (row) => row.dataset.sidebarEntry,
  );
}

function pinAlpha(sessions: ReturnType<typeof createSessionsHarness>) {
  const result = required(sessions.sessions.state.result);
  sessions.publish({
    result: {
      ...result,
      sessions: result.sessions.map((row) =>
        row.key === "agent:main:alpha" ? Object.assign({}, row, { pinned: true }) : row,
      ),
    },
  });
}

function drag(source: Element, target: Element) {
  const transfer = createDataTransferStub();
  dispatchDragEvent(source, "dragstart", transfer);
  dispatchDragEvent(target, "dragover", transfer);
  dispatchDragEvent(target, "drop", transfer);
}

async function mountZone() {
  const gateway = createGateway({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:alpha",
    "agent:main:beta",
  ]);
  const { sidebar, context } = await mountSidebar(gateway, sessions.sessions);
  sidebar.connected = true;
  return { sidebar, sessions, context };
}

function pluginNavigation(
  context: import("../../app/context.ts").ApplicationContext,
  sidebar: SidebarLifecycleState,
  ids: string[],
  defaultVisible = false,
  presentation: (id: string) => Pick<ControlUiNavigationItem, "parent" | "icon"> = () => ({}),
) {
  const openPage = vi.fn();
  const signal = new AbortController().signal;
  const entries = ids.map((id) => ({
    key: `example/${id}`,
    pluginId: "example",
    signal,
    value: { id, label: id, defaultVisible, page: { id }, ...presentation(id) },
    host: { navigation: { pageHref: () => `/plugin?plugin=example&id=${id}`, openPage } },
  }));
  Object.assign(context, {
    plugins: {
      registrations: (kind: string) => (kind === "navigation" ? entries : []),
      selectedReplacement: () => undefined,
      subscribe: () => () => {},
    },
  });
  sidebar.invalidate();
  return openPage;
}

describe("AppSidebar interleaved zone", () => {
  it("badges pinned attention just like ordinary rows", async () => {
    const keys = ["agent:main:main", "agent:main:page", "agent:main:plain"];
    const sessions = createSessionsHarness("main", keys);
    const result = required(sessions.sessions.state.result);
    for (const row of result.sessions) {
      if (row.key !== "agent:main:main") {
        Object.assign(row, {
          pinned: row.key === "agent:main:page",
          unread: true,
          status: "failed",
          lastRunError: "boom",
          updatedAt: 10,
        });
      }
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    for (const key of ["agent:main:page", "agent:main:plain"]) {
      const row = sidebar.querySelector(`[data-session-key="${key}"]`);
      const glyph = row?.querySelector(".sidebar-session-indicator .session-glyph");
      expect(glyph?.querySelector(".sidebar-session-attention__icon")).not.toBeNull();
      expect(
        glyph?.querySelectorAll('.session-glyph__badge--unread[role="img"][aria-label="Unread"]'),
      ).toHaveLength(1);
      expect(row?.querySelector(".session-row-state")).toBeNull();
      expect(row?.querySelector(".nav-item__state")).toBeNull();
    }
  });

  it.each([
    { slug: undefined, href: "/plugin?plugin=logbook&id=logbook" },
    { slug: "reports", href: "/reports" },
  ])("renders plugin tabs as sidebar entries at $href", async ({ slug, href }) => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;

    const hello = {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read"] },
      controlUiTabs: [
        { group: "control" as const, id: "logbook", label: "Logbook", pluginId: "logbook", slug },
      ],
    };
    gateway.publish({ hello });
    sidebar.sidebarEntries = ["route:cron"];
    await selectSidebarView(sidebar, "pages");

    const plugin = () => pluginEntry(sidebar, "logbook/logbook");
    const entry = plugin()?.querySelector<HTMLAnchorElement>(":scope > .nav-item");
    expect(entry?.textContent).toContain("Logbook");
    expect(entry?.getAttribute("href")).toBe(href);
    const source = required(plugin());
    expect(source.draggable).toBe(true);
    const onUpdate = vi.fn((entries: string[]) => {
      sidebar.sidebarEntries = entries;
    });
    sidebar.onUpdateSidebarEntries = onUpdate;
    const target = zoneEntry(sidebar, "route:cron");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 10, 200, 30));
    drag(source, target);
    await sidebar.updateComplete;
    expect(onUpdate).toHaveBeenCalled();
    const ordered = entryOrder(sidebar, ".sidebar-rail [data-sidebar-entry]");
    expect(ordered.indexOf("plugin:logbook/logbook")).toBeLessThan(ordered.indexOf("route:cron"));
    zoneEntry(sidebar, "plugin:logbook/logbook").querySelector<HTMLAnchorElement>("a")?.click();
    const location = new URL(href, window.location.origin);
    expect(navigate).toHaveBeenCalledWith("plugin", {
      pathname: location.pathname,
      search: location.search,
      hash: "",
    });

    gateway.publish({ hello: { ...hello, controlUiTabs: [] } });
    await sidebar.updateComplete;
    expect(plugin()).toBeNull();
    expect(pluginEntry(sidebar, "logbook/logbook", "rail")?.querySelector("a") ?? null).toBeNull();
  });

  it("keeps plugin destinations flat in Pages and separate from ordered rail pins", async () => {
    const stylesheet = document.createElement("style");
    stylesheet.textContent = [
      readStyleSheet("ui/src/styles/sidebar-reorder.css"),
      readStyleSheet("ui/src/styles/sidebar-rail.css"),
    ].join("\n");
    document.head.append(stylesheet);
    const originalLocation = window.location.href;
    onTestFinished(() => {
      stylesheet.remove();
      window.history.replaceState(null, "", originalLocation);
    });
    window.history.replaceState(null, "", "/plugin?plugin=example&id=notes");
    const { sidebar, context } = await mountZone();
    const ids = ["boards", "review", "notes"];
    const openPage = pluginNavigation(context, sidebar, ids, false, (id) =>
      id === "boards" ? {} : { parent: "boards" },
    );
    sidebar.sidebarEntries = ["plugin:example/boards", "plugin:example/notes", "route:usage"];
    await selectSidebarView(sidebar, "pages");
    const pages = sidebar.querySelector<HTMLElement>(".sidebar-pages")!;
    const entries = [
      ...pages.querySelectorAll<HTMLElement>('[data-sidebar-entry^="plugin:example/"]'),
    ];
    await Promise.all(
      entries.map(
        (entry) =>
          entry.querySelector<SolidBridgeElement<object>>("openclaw-plugin-contributions")!
            .updateComplete,
      ),
    );
    expect(entries.map((entry) => entry.dataset.sidebarEntry)).toEqual(
      ids.map((id) => `plugin:example/${id}`),
    );
    expect(
      entries.flatMap((entry) =>
        [...entry.querySelectorAll("a")].map((link) => link.getAttribute("href")),
      ),
    ).toEqual(ids.map((id) => `/plugin?plugin=example&id=${id}`));
    expect(
      pages.querySelectorAll(".nav-item-group, .nav-item__children, .nav-item--child"),
    ).toHaveLength(0);
    expect(pages.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const selected = entries[2]!.querySelector<HTMLAnchorElement>('a[aria-current="page"]')!;
    expect(selected.getAttribute("aria-label")).toBe("notes");
    expect(selected.classList.contains("nav-item--active")).toBe(true);
    selected.click();
    expect(openPage).toHaveBeenCalledExactlyOnceWith({ id: "notes" });
    // JSDOM owns structure and CSS contracts; real browser siblings own pixel geometry.
    for (const entry of entries) {
      const row = entry.closest<HTMLElement>(".sidebar-pages__entry")!;
      const pin = row.querySelector<HTMLButtonElement>(".sidebar-pages__pin")!;
      expect(row.firstElementChild).toBe(entry);
      expect(entry.nextElementSibling).toBe(pin);
      expect(getComputedStyle(row)).toMatchObject({ display: "flex", alignItems: "center" });
      expect(getComputedStyle(entry)).toMatchObject({ display: "flex", flexGrow: "1" });
      expect(getComputedStyle(pin)).toMatchObject({ flexShrink: "0", flexBasis: "28px" });
      expect(entry.querySelector(".sidebar-reorder-menu")).toBeNull();
    }
    // Pinned references remain separate icon controls.
    for (const id of ["boards", "notes"]) {
      const railEntry = required(pluginEntry(sidebar, `example/${id}`, "rail"));
      await railEntry.querySelector<SolidBridgeElement<object>>("openclaw-plugin-contributions")!
        .updateComplete;
      expect(railEntry.querySelectorAll("a")).toHaveLength(1);
      expect(railEntry.querySelector(".nav-item__children")).toBeNull();
      expect(railEntry.querySelector("a")?.getAttribute("aria-label")).toBe(id);
      expect(railEntry.querySelector(".sidebar-reorder-trigger")).toBeNull();
    }
    expect(entryOrder(sidebar, ".sidebar-rail__pin")).toEqual(sidebar.sidebarEntries);
    expect(sidebar.sidebarEntries).toEqual([
      "plugin:example/boards",
      "plugin:example/notes",
      "route:usage",
    ]);
  });

  it("offers child destinations with their icons and preserves an explicit removal", async () => {
    const { sidebar, context } = await mountZone();
    const register = () =>
      pluginNavigation(context, sidebar, ["review", "notes"], false, (id) => ({
        parent: "boards",
        icon: id === "review" ? "activity" : "toString",
      }));
    register();
    sidebar.sidebarEntries = ["route:usage", "plugin:example/review"];
    sidebar.onUpdateSidebarEntries = (entries) => {
      sidebar.sidebarEntries = entries;
    };
    await selectSidebarView(sidebar, "pages");
    for (const [id, expectedIcon] of [
      ["review", "activity"],
      ["notes", "plug"],
    ] as const) {
      const icon = mountSolid(() => createComponent(Icon, { name: expectedIcon }), {
        container: document.createElement("div"),
      }).container;
      const paths = sidebar.querySelectorAll(
        `.sidebar-pages [data-sidebar-entry="plugin:example/${id}"] .nav-item__icon svg path`,
      );
      expect([...paths].map((path) => path.getAttribute("d"))).toEqual(
        [...icon.querySelectorAll("svg path")].map((path) => path.getAttribute("d")),
      );
    }
    const review = required(pluginEntry(sidebar, "example/review"));
    const unpin = review
      .closest(".sidebar-pages__entry")!
      .querySelector<HTMLButtonElement>('[aria-label="Unpin"]')!;
    expect(unpin).not.toBeNull();
    unpin.click();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    register();
    await sidebar.updateComplete;
    expect(sidebar.sidebarEntries).toEqual(["route:usage"]);
    expect(pluginEntry(sidebar, "example/review", "rail")).toBeNull();
    expect(pluginEntry(sidebar, "example/review")).not.toBeNull();
  });

  it("does not pin or insert a promoted child dropped from Threads", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = required(await sessions.list());
    const alpha = required(result.sessions.find((row) => row.key === "agent:main:alpha"));
    const promoted = { ...alpha, spawnedBy: "agent:main:main" };
    sessions.publishList({
      result: {
        ...result,
        sessions: result.sessions.map((row) => (row === alpha ? promoted : row)),
      },
    });
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = required(sidebar.querySelector('[data-session-key="agent:main:alpha"]'));
    const target = zoneEntry(sidebar, "route:plugins");
    const dataTransfer = createDataTransferStub();
    dispatchDragEvent(source, "dragstart", dataTransfer);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-rail__pins--drag-active")).toBeNull();
    dispatchDragEvent(target, "dragover", dataTransfer);
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-rail__pins--drag-active")).toBeNull();
    dispatchDragEvent(target, "drop", dataTransfer);
    await sidebar.updateComplete;
    await vi.dynamicImportSettled();
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(sidebar.sessionOrganizer.draggingSessionKey).toBeNull();
  });

  it("unpins personal plugin shortcuts even when defaultVisible is true", async () => {
    const { sidebar, context } = await mountZone();
    pluginNavigation(context, sidebar, ["review"], true);
    sidebar.sidebarEntries = ["plugin:example/review", "route:usage"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "plugin:example/review");
    const target = required(sidebar.querySelector('[data-session-section="ungrouped"]'));
    drag(source, target);

    expect(onUpdate).toHaveBeenCalledWith(["route:usage"]);
  });

  it("prunes only the unpinned session's entry and preserves unknown-agent slots", async () => {
    const { sidebar, sessions } = await mountZone();
    pinAlpha(sessions);
    sidebar.sidebarEntries = ["session:agent:b:remote", "session:agent:main:alpha", "route:usage"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;

    const unresolved = sidebar.querySelector('[data-sidebar-entry="session:agent:b:remote"]');
    expect(unresolved).toBeNull();

    sidebar
      .querySelector<HTMLButtonElement>(
        '[data-session-key="agent:main:alpha"] [data-sidebar-session-pin="true"]',
      )
      ?.click();
    await waitForFast(() =>
      expect(onUpdate).toHaveBeenCalledWith(["session:agent:b:remote", "route:usage"]),
    );
    expect(sessions.patch).not.toHaveBeenCalled();
  });

  it("keeps pinned rows first in shift-range selection order", async () => {
    const { sidebar, sessions } = await mountZone();
    pinAlpha(sessions);
    sidebar.sidebarEntries = ["session:agent:main:alpha", "route:usage"];
    await sidebar.updateComplete;
    const link = (id: string) =>
      required(
        sidebar.querySelector(
          `[data-session-key="agent:main:${id}"] .sidebar-recent-session__link`,
        ),
      );

    link("alpha").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }),
    );
    link("beta").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    await sidebar.updateComplete;

    expect(
      [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--selected")].map(
        (row) => row.dataset.sessionKey,
      ),
    ).toEqual(["agent:main:alpha", "agent:main:beta"]);
  });
});
