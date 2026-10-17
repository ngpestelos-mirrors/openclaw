import { afterEach, describe, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { LinkReaderHovercardProvider } from "../components/link-reader-hovercard.ts";
import "../components/link-reader-hovercard-registration.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  type BrowserPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import "../components/modal-dialog.ts";
import { TEST_LINK_READER, testLinkPreview } from "../test-helpers/link-reader.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { postNativeUpdate, startNativeLinkRouting } from "./native-link-routing.ts";
import { client, flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { updateRunHarness } from "./update-run.test-support.ts";

const NATIVE_UPDATE_DECLINED_EVENT = "openclaw:native-update-declined";
const githubUrl = "https://github.com/openclaw/openclaw/issues/102691";
const reportUrl = "https://example.com/report";
const previewTitle = "Open links in a sidebar browser";
const panelRequest = (url: string) => ({ open: true, url, native: true });
const externalRequest = (url: string) => ({ type: "open-link", url, target: "external" });

type NativeLinkRouting = ReturnType<typeof startNativeLinkRouting>;

type NativeMessage = { type: string; url: string; target: string };

let routing: NativeLinkRouting | undefined;
let stopBrowserListener: (() => void) | undefined;

afterEach(() => {
  routing?.dispose();
  routing = undefined;
  stopBrowserListener?.();
  stopBrowserListener = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function installBridge(options: Parameters<typeof startNativeLinkRouting>[0] = {}) {
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn((message: NativeMessage) => messages.push(message));
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawLink: { postMessage }, openclawBrowser: { postMessage: vi.fn() } },
  });
  const browserRequests: BrowserPanelToggleDetail[] = [];
  const listener = (event: Event) =>
    browserRequests.push((event as CustomEvent<BrowserPanelToggleDetail>).detail);
  window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  stopBrowserListener = () => window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, listener);
  routing = startNativeLinkRouting(options);
  return { messages, postMessage, browserRequests };
}

function appendLink(href: string, attributes: Record<string, string> = {}, parent = document.body) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  parent.append(anchor);
  return anchor;
}

function mouse(anchor: HTMLAnchorElement, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  anchor.dispatchEvent(event);
  return event;
}
const click = (anchor: HTMLAnchorElement, init: MouseEventInit = {}) =>
  mouse(anchor, "click", { button: 0, ...init });
const contextMenu = (anchor: HTMLAnchorElement) =>
  mouse(anchor, "contextmenu", { button: 2, clientX: 120, clientY: 140 });

function clickWithoutNavigation(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  let defaultPrevented: boolean | undefined;
  const preventNavigation = (event: MouseEvent) => {
    defaultPrevented = event.defaultPrevented;
    event.preventDefault();
  };
  // Observe after the native router, then suppress jsdom's default navigation.
  window.addEventListener("click", preventNavigation, { once: true });
  try {
    click(anchor, init);
    return defaultPrevented;
  } finally {
    window.removeEventListener("click", preventNavigation);
  }
}

async function openMenu(anchor: HTMLAnchorElement) {
  expect(contextMenu(anchor).defaultPrevented).toBe(true);
  await waitForSolid(() =>
    expect(
      document
        .querySelector('openclaw-native-link-menu [aria-haspopup="menu"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true"),
  );
  const menu = document.querySelector("openclaw-native-link-menu")!;
  await menu.updateComplete;
  return menu;
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.querySelector(".session-menu__text")?.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

async function selectMenuItem(label: string) {
  menuItem(label).click();
  await waitForSolid(() => expect(document.querySelector("openclaw-native-link-menu")).toBeNull());
}

async function focusGitHubLink() {
  const provider = document.createElement(
    "openclaw-link-reader-hovercard-provider",
  ) as LinkReaderHovercardProvider;
  provider.readers = [TEST_LINK_READER];
  provider.client = {
    request: vi.fn().mockResolvedValue(testLinkPreview({ url: githubUrl, title: previewTitle })),
  } as unknown as GatewayBrowserClient;
  const anchor = appendLink(githubUrl, {}, provider);
  document.body.append(provider);
  anchor.focus();
  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(document.querySelector(".link-reader-hovercard")).not.toBeNull());
  return anchor;
}

describe("native link routing", () => {
  it("cancels a pending context menu on abort and removes link handlers", async () => {
    const abort = new AbortController();
    const bridge = installBridge({ signal: abort.signal });
    const anchor = appendLink(reportUrl);
    expect(contextMenu(anchor).defaultPrevented).toBe(true);
    abort.abort();
    await vi.dynamicImportSettled();

    expect(clickWithoutNavigation(anchor)).toBe(false);
    expect(contextMenu(anchor).defaultPrevented).toBe(false);
    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
    expect(bridge.messages).toEqual([]);
    expect(bridge.browserRequests).toEqual([]);
  });

  it("keeps native decline fallback on its posted Gateway and consumes it once", async () => {
    const requestA = vi.fn<RequestFn>(async () => ({}));
    const requestB = vi.fn<RequestFn>(async () => ({}));
    const harness = updateRunHarness(requestA);
    const overlays = createApplicationOverlays(harness.gateway);
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawUpdate: { postMessage } } });
    routing = startNativeLinkRouting({
      prepareNativeUpdateFallback: () => ({
        isCurrent: overlays.captureUpdateTarget(),
        run: () => void overlays.runUpdate(),
      }),
    });
    const updateCalls = (request: typeof requestA) =>
      request.mock.calls.filter(([method]) => method === "update.run");
    try {
      await flushMicrotasks();
      expect(postNativeUpdate()).toBe(true);
      harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
      harness.update({ client: client(requestB) });
      window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
      await flushMicrotasks();
      expect(updateCalls(requestA)).toEqual([]);
      expect(updateCalls(requestB)).toEqual([]);

      expect(postNativeUpdate()).toBe(true);
      window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
      await flushMicrotasks();
      window.dispatchEvent(new CustomEvent(NATIVE_UPDATE_DECLINED_EVENT));
      await flushMicrotasks();
      expect(updateCalls(requestA)).toEqual([]);
      expect(updateCalls(requestB)).toHaveLength(1);
      expect(postMessage).toHaveBeenCalledTimes(2);
    } finally {
      overlays.dispose();
    }
  });

  it("does not install native behavior without the WebKit bridge", async () => {
    routing = startNativeLinkRouting();
    const anchor = appendLink(reportUrl);

    expect(contextMenu(anchor).defaultPrevented).toBe(false);
    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
  });

  it.each([false, true])(
    "routes an active hovercard after duplicate bootstrap: %s",
    async (duplicate) => {
      // Reevaluate only bootstrap; the scheduler and custom-element registry remain shared.
      if (duplicate) {
        const module = "../components/link-reader-hovercard-registration.ts?duplicate-bootstrap";
        await import(module);
      }
      const bridge = installBridge();
      const anchor = await focusGitHubLink();
      if (duplicate) {
        const registered = customElements.get("openclaw-link-reader-hovercard-provider");
        expect(registered).toBeDefined();
        expect(anchor.parentElement?.constructor).toBe(registered);
        expect(document.querySelectorAll(".link-reader-hovercard")).toHaveLength(1);
        expect(document.querySelector(".link-reader-hovercard")?.textContent).toContain(
          previewTitle,
        );
      }
      click(anchor);
      expect(document.querySelector(".link-reader-hovercard")).toBeNull();
      expect(anchor.hasAttribute("aria-describedby")).toBe(false);
      expect(bridge.messages).toEqual([]);
      expect(bridge.browserRequests).toEqual([panelRequest(githubUrl)]);
    },
  );

  it("preserves modified, local, file, download, and untrusted app-link clicks", async () => {
    const bridge = installBridge();
    const links = [
      appendLink(`${location.origin}/usage`),
      appendLink("https://example.com/file", { "data-file-path": "README.md" }),
      appendLink("https://example.com/archive.zip", { download: "archive.zip" }),
      appendLink("mailto:hello@example.com"),
      appendLink("openclaw://dashboard"),
    ];
    for (const anchor of links) {
      expect(clickWithoutNavigation(anchor)).toBe(false);
    }
    const modified = appendLink("https://example.com/modified");
    expect(clickWithoutNavigation(modified, { metaKey: true })).toBe(false);

    expect(bridge.messages).toEqual([]);
  });

  it("offers inline, external, and copy actions for an external link", async () => {
    const bridge = installBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const anchor = appendLink("https://example.com/report?q=1");

    const firstMenu = await openMenu(anchor);
    expect(
      [...firstMenu!.querySelectorAll('[role="menuitem"]')].map((item) =>
        item.querySelector(".session-menu__text")?.textContent?.trim(),
      ),
    ).toEqual(["Open in Browser Panel", "Open in Default Browser", "Copy Link"]);
    await selectMenuItem("Open in Default Browser");
    expect(bridge.messages.at(-1)).toEqual(externalRequest("https://example.com/report?q=1"));

    await openMenu(anchor);
    await selectMenuItem("Open in Browser Panel");
    expect(bridge.browserRequests).toEqual([panelRequest("https://example.com/report?q=1")]);
    expect(bridge.messages).toHaveLength(1);

    await openMenu(anchor);
    await selectMenuItem("Copy Link");
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.com/report?q=1"),
    );
  });

  it("opens the panel menu action externally during Settings takeover and restores it afterward", async () => {
    let canPresentBrowserPanel = false;
    const bridge = installBridge({
      canPresentBrowserPanel: () => canPresentBrowserPanel,
    });
    const anchor = appendLink(reportUrl);

    for (const available of [false, true]) {
      canPresentBrowserPanel = available;
      await openMenu(anchor);
      await selectMenuItem("Open in Browser Panel");
      expect(bridge.messages).toEqual([externalRequest(reportUrl)]);
      expect(bridge.browserRequests).toEqual(available ? [panelRequest(reportUrl)] : []);
    }
  });

  it("ignores a stale close callback after replacing the context menu", async () => {
    installBridge();
    const firstAnchor = appendLink("https://example.com/first");
    const secondAnchor = appendLink("https://example.com/second");

    const firstMenu = await openMenu(firstAnchor);
    const closeFirst = firstMenu!.onClose;

    const secondMenu = await openMenu(secondAnchor);
    expect(secondMenu).not.toBe(firstMenu);

    closeFirst();

    expect(document.querySelector("openclaw-native-link-menu")).toBe(secondMenu);
  });

  it.each(["dialog", "modal"] as const)(
    "mounts the menu in the active %s overlay",
    async (kind) => {
      installBridge();
      const modal = kind === "modal" ? document.createElement("openclaw-modal-dialog") : null;
      const dialog = modal ? null : document.createElement("dialog");
      const host = modal ?? dialog!;
      dialog?.setAttribute("open", "");
      const anchor = appendLink(`https://example.com/${kind}-link`, {}, host);
      document.body.append(host);
      await modal?.updateComplete;
      const menu = await openMenu(anchor);
      const container = modal ? modal.getOverlayContainer() : dialog;
      expect(container?.querySelector("openclaw-native-link-menu")).toBe(menu);
      if (modal) {
        expect(container?.closest("dialog")?.open).toBe(true);
        expect(menu.getRootNode()).toBe(document);
      }
      expect(menuItem("Open in Browser Panel")).not.toBeNull();
    },
  );
});
