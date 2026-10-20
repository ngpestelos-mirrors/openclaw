/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./link-reader-panel.tsx";

const tag = "test-reader-metadata-" + crypto.randomUUID();
customElements.define(tag, class extends LinkReaderHovercardProvider {});
const url = "https://github.com/openclaw/openclaw/pull/99816";
const reader = {
  pluginId: "github",
  id: "items",
  label: "GitHub",
  linkReader: {
    hosts: ["github.com"],
    pathPattern: "^/[^/]+/[^/]+/pull/[0-9]+$",
    previewMethod: "github.preview",
    detailMethod: "github.detail",
  },
};
const open: ControlUiLinkReaderDocument = {
  url,
  title: "Keep PR status current",
  body: "Description",
  badge: { label: "Open", tone: "positive" },
  metadata: [{ label: "", value: "+42" }],
  coAuthors: [{ name: "reviewer" }],
  coAuthorCount: 1,
};
const merged: ControlUiLinkReaderDocument = {
  ...open,
  badge: { label: "Merged", tone: "accent" },
  metadata: [{ label: "Additions", value: "42" }],
};
function makeProvider(request: Parameters<typeof createTestGatewayClient>[0]) {
  const client = createTestGatewayClient(request);
  const host = document.createElement(tag);
  if (!(host instanceof LinkReaderHovercardProvider)) {
    throw new Error("Missing reader bridge");
  }
  host.readers = [reader];
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.className = "markdown-github-item";
  anchor.textContent = "PR #99816";
  host.append(anchor);
  document.body.append(host);
  host.client = client;
  return { host, anchor, client };
}
async function hover(anchor: HTMLAnchorElement) {
  await Promise.resolve();
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
}
async function leave(anchor: HTMLAnchorElement, delay = 120) {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(delay);
}
async function openPanel(
  client: GatewayBrowserClient,
  scope: { agentId?: string; sessionKey?: string } = {},
) {
  const panel = document.createElement("openclaw-link-reader-panel");
  Object.assign(panel, { client, available: true, readers: [reader], ...scope });
  mountSolid(() => panel);
  await panel.updateComplete;
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true },
      cancelable: true,
    }),
  );
  return panel;
}
const card = () => document.querySelector<HTMLElement>(".link-reader-hovercard");
const badge = () => card()?.querySelector(".link-reader-hovercard__state")?.textContent?.trim();
const metadata = () => card()?.querySelector(".link-reader-hovercard__metadata")?.textContent;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.spyOn(GatewayBrowserClient.prototype, "connected", "get").mockReturnValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["same", "other-client", "other-agent", "other-session"])(
  "reconciles details only in matching %s scope",
  async (scope) => {
    const request = vi.fn((method: string) =>
      Promise.resolve(method === "github.detail" ? merged : open),
    );
    const { host, anchor, client } = makeProvider(request);
    host.agentId = "main";
    host.sessionKey = "agent:main:pane-one";
    await hover(anchor);
    expect(badge()).toBe("Open");
    const panel = await openPanel(
      scope === "other-client" ? createTestGatewayClient(request) : client,
      {
        agentId: scope === "other-agent" ? "other" : "main",
        sessionKey: scope === "other-session" ? "agent:main:pane-two" : "agent:main:pane-one",
      },
    );
    await waitForSolid(() =>
      expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"),
    );
    expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    await leave(anchor);
    await hover(anchor);
    expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    expect(metadata()).toBe("+42");
    expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(1);
  },
);

it.each([false, true])(
  "refreshes an explicitly stale response once (session scoped: %s)",
  async (sessionScoped) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...open, stale: true })
      .mockResolvedValue(merged);
    const { host, anchor } = makeProvider(request);
    host.sessionKey = "agent:main:pane-one";
    host.readers = [{ ...reader, linkReader: { ...reader.linkReader, sessionScoped } }];
    await hover(anchor);
    expect(badge()).toBe("Merged");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({
      url,
      refresh: true,
      ...(sessionScoped ? { sessionKey: "agent:main:pane-one" } : {}),
    });
  },
);

it("labels still-stale metadata and retries only after short backoff", async () => {
  const request = vi.fn().mockResolvedValue({ ...open, stale: true });
  const { anchor } = makeProvider(request);
  await hover(anchor);
  expect(badge()).toBe("Open");
  expect(card()?.dataset.cached).toBe("true");
  expect(request).toHaveBeenCalledTimes(2);
  await leave(anchor);
  await hover(anchor);
  expect(request).toHaveBeenCalledTimes(2);
  await leave(anchor, 30_000);
  await hover(anchor);
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([false, true])(
  "keeps fresh details over compact previews (pending: %s)",
  async (pendingPreview) => {
    const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
    let previewReads = 0;
    const request = vi.fn((method: string) => {
      if (method === "github.detail") {
        return Promise.resolve(merged);
      }
      previewReads += 1;
      return pendingPreview && previewReads === 1 ? pending.promise : Promise.resolve(open);
    });
    const { anchor, client } = makeProvider(request);
    if (pendingPreview) {
      await hover(anchor);
    }
    const panel = await openPanel(client);
    await waitForSolid(() =>
      expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"),
    );
    await waitForSolid(() => expect(badge()).toBe("Merged"));
    pending.resolve(open);
    await vi.advanceTimersByTimeAsync(0);
    expect(badge()).toBe("Merged");
    expect(anchor.getAttribute("aria-description")).toBe("Merged");
    await leave(anchor);
    await hover(anchor);
    expect(badge()).toBe("Merged");
    expect(metadata()).toBe("+42");
    expect(previewReads).toBe(pendingPreview ? 2 : 1);
  },
);

it("keeps reader facts through enrichment failure and recovery", async () => {
  const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
  let previewResponse = pending.promise;
  const request = vi.fn((method: string) =>
    method === "github.detail" ? Promise.resolve(merged) : previewResponse,
  );
  const { anchor, client } = makeProvider(request);
  await openPanel(client);
  await waitForSolid(() => expect(anchor.getAttribute("aria-description")).toBe("Merged"));
  await hover(anchor);
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  pending.reject(new Error("Preview rate limited"));
  await vi.advanceTimersByTimeAsync(0);
  expect(badge()).toBe("Merged");
  expect(card()?.dataset.cached).toBe("true");
  await leave(anchor);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(1);
  await leave(anchor, 30_000);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(2);
  previewResponse = Promise.resolve(open);
  await leave(anchor, 30_000);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(metadata()).toBe("+42");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(3);
});
