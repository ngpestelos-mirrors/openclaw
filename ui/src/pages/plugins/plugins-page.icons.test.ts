/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import { waitForSolid as waitFor } from "../../test-helpers/solid-settle.ts";
import { createModelSetupIconLoader as createIconLoader } from "../model-setup/model-setup-icon-loader.tsx";
import type { ModelSetupPageState } from "../model-setup/state.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createInspectResult,
  createGateway,
  createPlugin,
  createPluginsRouteData,
  createResult,
  createScriptedClient,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

function stubIcons(
  implementation: typeof fetch = async () => iconResponse(),
  value: string | (() => string) = "blob:icon",
) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  const create = vi.fn(typeof value === "string" ? () => value : value);
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  return { create, revoke, fetchMock };
}

function iconResponse(body: BodyInit = "image", type = "image/png") {
  return new Response(body, { headers: { "content-type": type } });
}

async function requestResult(method: string) {
  return method === "plugins.catalog.categories"
    ? { categories: [] }
    : method === "plugins.catalog.browse"
      ? { items: [] }
      : createResult();
}

type IconHandler = Parameters<typeof createClient>[0] | Record<string, () => unknown>;
function iconGateway(handler: IconHandler = requestResult) {
  const { client, request } =
    typeof handler === "function" ? createClient(handler) : createScriptedClient(handler);
  const { gateway } = createGateway(client);
  gateway.connection.gatewayUrl = window.location.origin.replace(/^http/u, "ws");
  return { gateway, request };
}

function mountIcons(
  gateway: ReturnType<typeof iconGateway>["gateway"],
  result = createResult(),
  path = "/settings/plugins",
) {
  return mountPage(createContext(gateway), createPluginsRouteData(gateway, result, path));
}

const hero = ".plugin-catalog-detail__hero";
const imageSource = (page: HTMLElement, selector = `${hero} img`) =>
  page.querySelector(selector)?.getAttribute("src");
const inspectGateway = (result: ReturnType<typeof createResult>) =>
  iconGateway(async (method) => (method === "plugins.inspect" ? createInspectResult() : result));

const iconUrl = "https://cdn.example.com/lifecycle.png";
let activeLoader: ReturnType<typeof createIconLoader> | undefined;
afterEach(() => {
  activeLoader?.reset();
  activeLoader = undefined;
  resetPluginsPageTestState();
});

beforeEach(() => i18n.setLocale("en"));

it("loads artwork for rendered category cards and expands without per-card metadata reads", async () => {
  const { fetchMock } = stubIcons();
  const items = Array.from({ length: 12 }, (_, index) => {
    const { plugin } = createDiscoveryDetail(
      createPlugin({
        id: `catalog-${index}`,
        name: `Plugin ${index}`,
        installed: false,
        state: "not-installed",
      }),
    );
    plugin.catalog.categories = ["web"];
    plugin.catalog.imageUrl = `https://cdn.example.com/publisher-${index}.png`;
    return plugin;
  });
  const { gateway, request } = iconGateway(async (method) =>
    method === "plugins.catalog.browse"
      ? { items, categories: [{ slug: "web", label: "Web", icon: "globe", order: 1 }] }
      : requestResult(method),
  );
  const { page } = await mountIcons(gateway, createResult(), "/plugins");
  const cards = () => page.querySelectorAll(".plugin-catalog-card");
  const images = () => page.querySelectorAll(".plugin-catalog-card img");
  await waitFor(() => expect(cards().length).toBeGreaterThan(0));
  const visible = cards().length;
  expect(visible).toBeLessThan(items.length);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(visible));
  await waitFor(() => expect(images()).toHaveLength(visible));
  const expand = '[data-catalog-section="web"] .plugin-catalog-section__view-all';
  page.querySelector<HTMLButtonElement>(expand)!.click();
  await waitFor(() => expect(cards()).toHaveLength(items.length));
  await waitFor(() => expect(images()).toHaveLength(items.length));
  expect(request.mock.calls.map(([method]) => method)).not.toContain("plugins.catalog.get");
});

it("uses late publisher enrichment after package 404 without retrying the package", async () => {
  const authorUrl = "https://cdn.example.com/publisher.png";
  const { fetchMock } = stubIcons(
    async (url) =>
      String(url).includes("/plugin-icon/")
        ? new Response(null, { status: 404, headers: { "content-type": "image/png" } })
        : iconResponse("author"),
    "blob:author",
  );
  const plugin = createPlugin({ hasIcon: true, catalogId: "catalog:workboard" });
  const detail = createDiscoveryDetail(plugin);
  detail.detail.author = { handle: "publisher", imageUrl: authorUrl };
  const catalog = deferred<typeof detail>();
  const result = createResult(plugin);
  const { gateway } = iconGateway({
    "plugins.inspect": () => createInspectResult(),
    "plugins.catalog.get": () => catalog.promise,
    "plugins.list": () => result,
  });
  const { page } = await mountIcons(gateway, result, "/settings/plugins/workboard");
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  await waitFor(() => expect(page.querySelector(`${hero} .plugins-tile.skeleton`)).not.toBeNull());
  catalog.resolve(detail);
  await waitFor(() =>
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/__openclaw__/plugin-icon/workboard",
      `/__openclaw__/catalog-icon/${encodeURIComponent(authorUrl)}`,
    ]),
  );
  await waitFor(() => expect(imageSource(page)).toBe("blob:author"));
});

it("keeps the monogram fallback when a proxied SVG exceeds the safe icon subset", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="work"><feTurbulence /></filter><path filter="url(#work)" d="M0 0h24v24H0z"/></svg>';
  const { create, fetchMock } = stubIcons(async () => iconResponse(svg, "image/svg+xml"));
  const { gateway } = iconGateway();
  const { page } = await mountIcons(
    gateway,
    createResult(createPlugin({ id: "unsafe-icon", name: "Unsafe Icon", hasIcon: true })),
  );
  await waitFor(() =>
    expect(
      page.querySelector('[data-plugin-id="unsafe-icon"] .plugins-tile--fallback')?.textContent,
    ).toContain("UI"),
  );
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
});
function setupIcons() {
  const context = createContext(iconGateway(async () => createResult()).gateway);
  const ready: Extract<ModelSetupPageState, { phase: "ready" }> = {
    phase: "ready",
    result: {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/icon-fixture",
      setupComplete: false,
      recommendedInstalls: [{ id: "x", label: "X", hint: "", website: "", icon: iconUrl }],
    },
  };
  let pageState: ModelSetupPageState = ready;
  const published = vi.fn<(urls: Record<string, string>) => void>();
  let sequence = 0;
  const { revoke, fetchMock } = stubIcons(vi.fn<typeof fetch>(), () => `blob:icon-${++sequence}`);
  const loader = createIconLoader(
    () => context,
    () => pageState,
    published,
  );
  activeLoader = loader;
  return {
    loader,
    fetchMock,
    published,
    revoke,
    eligible: (present: boolean) => {
      pageState = present
        ? ready
        : { phase: "ready", result: { ...ready.result, recommendedInstalls: [] } };
    },
  };
}

it("times out and retries a missed icon only after removal and re-add", async () => {
  vi.useFakeTimers();
  const { loader, fetchMock, published, eligible } = setupIcons();
  const response = deferred<Response>();
  fetchMock
    .mockImplementationOnce((_input, init) => {
      const signal = expectDefined(init?.signal, "icon request abort signal");
      signal.addEventListener(
        "abort",
        () => response.reject(new Error("fixture fetch aborted", { cause: signal.reason })),
        { once: true },
      );
      return response.promise;
    })
    .mockResolvedValueOnce(iconResponse());
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  const signal = fetchMock.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal).toMatchObject({
    aborted: true,
    reason: { name: "TimeoutError", message: "catalog icon fetch timed out" },
  });
  expect(signal?.reason).toBeInstanceOf(DOMException);
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  eligible(false);
  loader.reconcile();
  eligible(true);
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(published).toHaveBeenLastCalledWith({ [iconUrl]: "blob:icon-1" }));
});

it("revokes before invalidation publication and publishes both empty resets", async () => {
  const { loader, fetchMock, published, revoke } = setupIcons();
  fetchMock.mockResolvedValueOnce(iconResponse());
  loader.reconcile();
  await waitFor(() => expect(published).toHaveBeenCalledOnce());
  loader.invalidate(iconUrl);
  expect(revoke).toHaveBeenCalledWith("blob:icon-1");
  expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(
    expectDefined(published.mock.invocationCallOrder[1], "invalidation publication order"),
  );
  loader.reconcile();
  expect(fetchMock).toHaveBeenCalledOnce();
  loader.reset();
  loader.reset();
  expect(published.mock.calls).toEqual([[{ [iconUrl]: "blob:icon-1" }], [{}], [{}], [{}]]);
});

it("keeps a pending detail icon on its skeleton until the image loads", async () => {
  vi.useFakeTimers();
  const response = deferred<Response>();
  const { fetchMock } = stubIcons(() => response.promise, "blob:loaded-icon");
  const result = createResult(createPlugin({ hasIcon: true }));
  const { gateway } = inspectGateway(result);
  const { page } = await mountIcons(gateway, result, "/settings/plugins/workboard");
  await vi.advanceTimersByTimeAsync(0);
  const icon = () => page.querySelector(`${hero} .plugins-tile`);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(icon()?.classList.contains("skeleton")).toBe(true);
  expect(icon()?.classList.contains("plugins-tile--fallback")).toBe(false);
  response.resolve(iconResponse());
  await vi.advanceTimersByTimeAsync(0);
  const image = icon()?.querySelector("img");
  expect(image?.getAttribute("src")).toBe("blob:loaded-icon");
  expect(icon()?.classList.contains("skeleton")).toBe(true);
  image?.dispatchEvent(new Event("load"));
  await settlePlugins();
  expect(icon()?.classList.contains("skeleton")).toBe(false);
});

it("reuses installed artwork across navigation and retires it on a new plugin generation", async () => {
  vi.useFakeTimers();
  let sequence = 0;
  const { revoke: revokeObjectURL, fetchMock } = stubIcons(
    undefined,
    () => `blob:icon-${++sequence}`,
  );
  const result = { ...createResult(createPlugin({ hasIcon: true })), generation: 1 };
  const { gateway } = inspectGateway(result);
  const { page } = await mountIcons(gateway, result);
  await vi.advanceTimersByTimeAsync(0);
  expect(imageSource(page, "img.plugins-icon")).toBe("blob:icon-1");
  const detailRoute = "/settings/plugins/workboard";
  page.routeData = createPluginsRouteData(gateway, result, detailRoute);
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(imageSource(page)).toBe("blob:icon-1");
  page.routeData = createPluginsRouteData(gateway, { ...result, generation: 2 }, detailRoute);
  await vi.advanceTimersByTimeAsync(0);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-1");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(imageSource(page)).toBe("blob:icon-2");
  page.remove();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon-2");
});
