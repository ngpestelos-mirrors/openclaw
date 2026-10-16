import { expectDefined } from "@openclaw/normalization-core";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ToolsCatalogResult } from "../../api/types.ts";
import { configMocks } from "../../e2e/plugins-settings-admin.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
} from "../../lib/plugins/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid as waitFor } from "../../test-helpers/solid-settle.ts";
import {
  createScriptedClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

const SETTINGS_URL = "/settings/plugins/workboard?view=settings";
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const configuredState = <T, S>(configForm: T, configSchema: S) => ({
  connected: true,
  configFormDirty: false,
  lastError: null,
  configUiHints: {},
  configForm,
  configSchema,
});

function discoveryDetail(plugin: PluginCatalogItem): PluginDiscoveryDetailResult {
  const result = createDiscoveryDetail(plugin);
  result.plugin.id = expectDefined(plugin.catalogId, "catalog fixture ID");
  result.plugin.catalog = { name: plugin.name, official: true, categories: ["productivity"] };
  result.plugin.local.pluginId = plugin.id;
  delete result.plugin.local.install;
  result.detail.packageName = plugin.id;
  return result;
}

function browseResult(params: unknown, details: PluginDiscoveryDetailResult[]) {
  return {
    items: asNullableRecord(params)?.intent === "all" ? details.map(({ plugin }) => plugin) : [],
    categories: [
      {
        slug: "productivity",
        label: "Productivity",
        description: "Work tools",
        icon: "checkSquare",
        order: 1,
      },
    ],
  };
}

function pageGateway(...args: Parameters<typeof createScriptedClient>) {
  const client = createScriptedClient(...args);
  return { ...client, harness: createGateway(client.client) };
}

async function mountRoute(
  harness: ReturnType<typeof createGateway>,
  result: PluginListResult | null,
  url: string,
  runtimeConfig?: ReturnType<typeof createRuntimeConfigHarness>,
) {
  const context = createContext(harness.gateway, undefined, undefined, runtimeConfig);
  const routeData = createPluginsRouteData(harness.gateway, result, url);
  return { context, routeData, ...(await mountPage(context, routeData)) };
}

async function settlePage(page: { updateComplete: Promise<boolean> }) {
  await settlePlugins();
  await page.updateComplete;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  resetPluginsPageTestState();
  for (const capability of capabilities) {
    capability.dispose();
  }
  capabilities.clear();
});

it("a chat install link opens uninstalled plugin details without installing", async () => {
  const detail = discoveryDetail(
    createPlugin({
      id: "@openclaw/whatsapp",
      name: "WhatsApp",
      installed: false,
      state: "not-installed",

      catalogId: "ch_d2hhdHNhcHA",
    }),
  );
  detail.plugin.catalog.categories = [];
  delete detail.plugin.local.pluginId;
  const inventory = createResult(
    createPlugin({
      id: "whatsapp",
      catalogId: detail.plugin.id,
      installed: false,
      state: "not-installed",
    }),
  );
  const { request, harness } = pageGateway({ "plugins.catalog.get": () => detail });
  const { ui, find, context } = await mountRoute(
    harness,
    inventory,
    "/plugins/ch_d2hhdHNhcHA?action=install",
  );
  await waitFor(() =>
    expect(context.replace).toHaveBeenCalledWith("plugins", {
      pathname: "/plugins/ch_d2hhdHNhcHA",
      search: "",
    }),
  );
  await waitFor(() => ui.node("h1").not.toBeNull());
  expect(find<HTMLButtonElement>(".plugin-catalog-detail__install")?.disabled).toBe(false);
  ui.text.not.toContain("Accounts");
  ui.text.not.toContain("Credentials");
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
  ui.node("openclaw-modal-dialog").toBeNull();
  expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
});

it.each([true, false])("retries failed configuration recovery (write=%s)", async (write) => {
  const result = createResult();
  const { client, harness } = pageGateway(
    { "plugins.inspect": () => createInspectResult() },
    () => result,
  );
  const refresh = vi.fn(async () => undefined);
  const configState = {
    configFormDirty: write,
    lastError: write ? "Save failed" : "Configuration load failed",
    configForm: write
      ? { plugins: { entries: { workboard: { config: { token: "pending" } } } } }
      : null,
    configUiHints: {},
    configSchema: write
      ? objectSchema({
          plugins: objectSchema({
            entries: {
              type: "object",
              additionalProperties: objectSchema({ config: { type: "object" } }),
            },
          }),
        })
      : null,
  };
  const runtimeConfig = createRuntimeConfigHarness(refresh, configState, () => client);
  const { page, ui } = await mountRoute(harness, result, SETTINGS_URL, runtimeConfig);
  await waitFor(() => ui.node(".plugin-editor .callout button").not.toBeNull());
  const retry = [...page.querySelectorAll<HTMLElement>(".plugin-editor .callout")]
    .find((element) => element.textContent?.includes(configState.lastError))
    ?.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry?.click();
  expect(runtimeConfig.runtimeConfig.retry).toHaveBeenCalledTimes(write ? 1 : 0);
  expect(runtimeConfig.runtimeConfig.refreshSchema).toHaveBeenCalledTimes(write ? 0 : 1);
  expect(refresh).toHaveBeenCalledTimes(write ? 0 : 1);
});

it("closes setting menus before Escape dismisses settings and commits a focused field", async () => {
  const result = createResult();
  const { harness } = pageGateway({
    "plugins.inspect": () => createInspectResult(),
    "plugins.list": () => result,
  });
  const state = {
    ...configuredState(
      structuredClone(configMocks["config.get"].config),
      configMocks["config.schema"].schema,
    ),
    configUiHints: configMocks["config.schema"].uiHints,
  };
  const runtimeConfig = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    state,
  );
  const { page, ui, find, context } = await mountRoute(
    harness,
    result,
    SETTINGS_URL,
    runtimeConfig,
  );
  const selector = 'input[aria-label="Refresh interval (minutes)"]';
  await waitFor(() => ui.node(selector).not.toBeNull());
  const input = find<HTMLInputElement>(selector)!;
  const row = input.closest(".plugin-editor__row")!;
  const trigger = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
  const menuItem = row.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')!;
  // JSDOM omits layout scrolling; the real menu still owns focus and Escape.
  for (const item of row.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    item.scrollIntoView = vi.fn();
  }
  vi.mocked(context.replace).mockClear();
  for (const focus of [menuItem, trigger]) {
    trigger.click();
    await settlePlugins();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(menuItem);
    focus.focus();
    focus.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await settlePlugins();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    ui.node(".plugin-editor").not.toBeNull();
    expect(context.replace).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  }
  input.focus();
  input.value = "30";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await page.updateComplete;
  ui.node(".plugin-editor").toBeNull();
  expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledExactlyOnceWith(
    ["plugins", "entries", "workboard", "config", "refreshMinutes"],
    30,
  );
  expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
  expect(context.replace).toHaveBeenCalledWith("plugin-settings", {
    pathname: "/settings/plugins",
  });
});

it("keeps the autosaved inspection when an older optional catalog completes", async () => {
  const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk", version: "1.2.3" };
  const result = createResult(plugin);
  const catalog = deferred<PluginDiscoveryDetailResult>();
  let inspections = 0;
  let catalogs = 0;
  const { client, request, harness } = pageGateway({
    "plugins.inspect": () => {
      const inspection = createInspectResult();
      inspection.components.skills = [++inspections === 1 ? "Original skill" : "Current skill"];
      return inspection;
    },
    "plugins.catalog.get": () => {
      if (++catalogs === 1) {
        return catalog.promise;
      }
      throw new Error("Optional catalog unavailable");
    },
    "plugins.list": () => result,
  });
  const state = {
    configAutoSaveStatus: "idle",
    ...configuredState(
      { plugins: { entries: { workboard: { config: { greeting: "Before" } } } } },
      objectSchema({
        plugins: objectSchema({
          entries: objectSchema({
            workboard: objectSchema({
              config: objectSchema({ greeting: { type: "string", title: "Greeting" } }),
            }),
          }),
        }),
      }),
    ),
  };
  const runtimeConfig = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    state,
    () => client,
  );
  const { page, ui, find } = await mountRoute(
    harness,
    result,
    "/settings/plugins/workboard#configuration",
    runtimeConfig,
  );
  await waitFor(() => expect(catalogs).toBe(1));
  await waitFor(() => ui.node('.plugin-editor input[aria-label="Greeting"]').not.toBeNull());
  const input = find<HTMLInputElement>('.plugin-editor input[aria-label="Greeting"]')!;
  input.focus();
  input.value = "After";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(runtimeConfig.runtimeConfig.patchForm).not.toHaveBeenCalled();
  input.blur();
  expect(runtimeConfig.runtimeConfig.flushFormChanges).toHaveBeenCalledOnce();
  expect(runtimeConfig.runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["plugins", "entries", "workboard", "config", "greeting"],
    "After",
  );
  state.configForm.plugins.entries.workboard.config.greeting = "After";
  state.configAutoSaveStatus = "saving";
  runtimeConfig.notify();
  state.configAutoSaveStatus = "saved";
  runtimeConfig.notify();
  await waitFor(() => expect(catalogs).toBe(2));
  page.routeData = createPluginsRouteData(harness.gateway, result, "/settings/plugins/workboard");
  await page.updateComplete;
  const rows = () =>
    [...page.querySelectorAll(".plugin-capability__copy strong")].map((row) => row.textContent);
  expect(rows()).toEqual(["Current skill"]);

  catalog.resolve(discoveryDetail(plugin));
  await catalog.promise;
  await settlePage(page);

  expect(rows()).toEqual(["Current skill"]);
  expect(request.mock.calls.filter(([method]) => method === "plugins.inspect")).toHaveLength(2);
});

it("reports when a listed install becomes unavailable", async () => {
  const offered = discoveryDetail(
    createPlugin({
      id: "calendar",
      name: "Calendar",
      installed: false,
      state: "not-installed",
      catalogId: "ch_Y2FsZW5kYXI",
    }),
  );
  const current = structuredClone(offered);
  current.plugin.local.action = "unavailable";
  const { request, harness } = pageGateway({
    "plugins.catalog.browse": (params) => browseResult(params, [offered]),
    "plugins.catalog.categories": () => ({ categories: [] }),
    "plugins.catalog.get": () => current,
  });
  const { ui, find } = await mountRoute(harness, createResult(), "/plugins");
  await waitFor(() => ui.node('[aria-label="Install Calendar"]').not.toBeNull());
  find<HTMLButtonElement>('[aria-label="Install Calendar"]')!.click();
  await waitFor(() => ui.text.toContain("Plugin availability changed"));
  expect(request.mock.calls.some(([method]) => method === "plugins.install")).toBe(false);
  expect(find<HTMLButtonElement>('[aria-label="Install Calendar"]')?.disabled).toBe(false);
});

it("keeps the latest Install request while an older catalog detail is pending", async () => {
  const details = ["Alpha", "Beta"].map((name) =>
    discoveryDetail({
      ...createPlugin({
        id: name.toLowerCase(),
        name,
        installed: false,
        state: "not-installed",
      }),
      catalogId: name === "Alpha" ? "ch_YWxwaGE" : "ch_YmV0YQ",
    }),
  );
  const [alpha, beta] = details;
  const alphaRead = deferred<PluginDiscoveryDetailResult>();
  const betaRead = deferred<PluginDiscoveryDetailResult>();
  const installation = deferred<unknown>();
  const { request, harness } = pageGateway({
    "plugins.catalog.browse": (params) => browseResult(params, details),
    "plugins.catalog.categories": () => ({ categories: [] }),
    "plugins.catalog.get": (params) =>
      asNullableRecord(params)?.id === alpha!.plugin.id ? alphaRead.promise : betaRead.promise,
    "plugins.install": () => installation.promise,
    "plugins.list": () => createResult(),
  });
  const { page } = await mountRoute(harness, createResult(), "/plugins");
  try {
    await waitForSolid(() =>
      expect(page.querySelectorAll(".plugin-catalog-card__install")).toHaveLength(2),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Install Alpha"]')!.click();
    page.querySelector<HTMLButtonElement>('[aria-label="Install Beta"]')!.click();
    await waitForSolid(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "plugins.catalog.get"),
      ).toHaveLength(2),
    );
    betaRead.resolve(beta!);
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith(
        "plugins.install",
        {
          source: "clawhub",
          packageName: "beta",
        },
        expect.objectContaining({ onSent: expect.any(Function) }),
      ),
    );
    alphaRead.resolve(alpha!);
    await alphaRead.promise;
    await settlePage(page);

    expect(request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
  } finally {
    alphaRead.resolve(alpha!);
    betaRead.resolve(beta!);
    installation.resolve({
      ok: true,
      plugin: createPlugin({ id: "beta", name: "Beta", enabled: true, state: "enabled" }),
      restartRequired: false,
    });
    await settlePage(page);
  }
});

it.each(["disabled", "needs-setup"] as const)(
  "renders %s local settings controls while optional metadata settles",
  async (state) => {
    const plugin = createPlugin({
      clawhubPackage: "@openclaw/workboard",
      version: "1.2.3",
      state,
      catalogId: "ch_QG9wZW5jbGF3L3dvcmtib2FyZA",
    });
    const result = createResult(plugin);
    const catalog = discoveryDetail(plugin);
    catalog.plugin.catalog.packageName = catalog.detail.packageName = "@openclaw/workboard";
    catalog.plugin.catalog.categories = ["tools"];
    const tools = deferred<ToolsCatalogResult>();
    const catalogPending = deferred<PluginDiscoveryDetailResult>();
    const { client, request, harness } = pageGateway(
      {
        "plugins.inspect": () => {
          const inspection = createInspectResult();
          inspection.declared.tools = ["board_create"];
          if (state === "disabled") {
            inspection.mcpAuth = [{ serverName: "account", state: "unauthenticated" }];
            inspection.credentials = [
              {
                path: ["plugins", "entries", "workboard", "config", "apiKey"],
                label: "API key",
                envVars: ["SERVICE_KEY"],
                status: "missing",
              },
            ];
          }
          return inspection;
        },
        "tools.catalog": () => tools.promise,
        "plugins.catalog.get": () => catalogPending.promise,
      },
      () => result,
    );
    harness.emit(client, true, {
      hello: gatewayHelloForMethods(["plugins.inspect", "plugins.setEnabled", "tools.catalog"]),
    });
    const { page, ui, find, context } = await mountRoute(
      harness,
      result,
      "/settings/plugins/workboard?from=plugins",
    );

    await waitFor(() =>
      expect(
        [...page.querySelectorAll(".plugin-capability__static strong")].map((row) =>
          row.textContent?.trim(),
        ),
      ).toContain("board_create"),
    );
    ui.content("h1").toContain("Workboard");
    const enable = find('[aria-label="Enable Workboard"]');
    expect(enable).not.toBeNull();
    expect(enable?.getAttribute("aria-disabled")).toBe(state === "needs-setup" ? "true" : null);
    if (state === "needs-setup") {
      ui.node(".plugins-settings-detail-setup").toBeNull();
      ui.node('[role="tablist"]').toBeNull();
      ui.node(".plugin-catalog-detail__panel .oc-banner-warning").toBeNull();
      expect(
        find<HTMLAnchorElement>('.plugin-catalog-detail__actions a[aria-label="Settings"]')?.href,
      ).toContain("view=settings");
    } else {
      ui.node('[aria-label="Connect account"]').not.toBeNull();
      ui.text.toContain("Credentials");
    }
    ui.content(".plugin-catalog-detail__sidebar").toContain("1.2.3");
    ui.node(".plugin-metadata__loading[role=status]").not.toBeNull();
    expect(request).toHaveBeenCalledWith(
      "plugins.catalog.get",
      {
        id: plugin.catalogId,
        version: "1.2.3",
      },
      undefined,
    );

    catalogPending.resolve(catalog);
    await waitFor(() => ui.node(".plugin-metadata__loading").toBeNull());
    ui.content(".plugin-metadata__categories .chip").toBe("tools");
    ui.content(".plugin-catalog-detail__sidebar").toContain("1.2.3");
    tools.resolve({
      agentId: "main",
      profiles: [],
      groups: [
        {
          id: "plugin:workboard",
          label: "Workboard",
          source: "plugin",
          pluginId: plugin.id,
          tools: [
            {
              id: "board_search",
              label: "Search board",
              description: "Summary",
              fullDescription: "Full board search description",
              source: "plugin",
              pluginId: plugin.id,
              defaultProfiles: [],
            },
          ],
        },
      ],
    });
    await waitFor(() => ui.text.toContain("Full board search description"));
    ui.text.toContain("board_create");
    if (state === "disabled") {
      const breadcrumb = find<HTMLAnchorElement>(".plugins-settings-breadcrumb__parent");
      expect(breadcrumb?.textContent).toBe("Plugins");
      expect(breadcrumb?.getAttribute("href")).toBe("/plugins");
      breadcrumb?.click();
      expect(context.navigate).toHaveBeenCalledWith("plugins", { pathname: "/plugins" });
    }
  },
);

it("uses a late local inventory while catalog metadata is pending", async () => {
  const plugin = { ...createPlugin(), catalogId: "ch_d29ya2JvYXJk" };
  const result = createResult(plugin);
  const local = deferred<typeof result>();
  const remote = deferred<PluginDiscoveryDetailResult>();
  let catalogs = 0;
  const { request, harness } = pageGateway({
    "plugins.list": () => local.promise,
    "plugins.inspect": () => createInspectResult(),
    "plugins.catalog.get": () => {
      if (++catalogs === 1) {
        return remote.promise;
      }
      throw new Error("ClawHub unavailable");
    },
  });
  const { page, ui } = await mountRoute(harness, null, `/plugins/${plugin.catalogId}`);
  await waitFor(() => expect(catalogs).toBe(1));
  local.resolve(result);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: plugin.id }),
  );
  ui.node('[aria-label="Enable Workboard"]').not.toBeNull();
  ui.node(".plugin-catalog-detail__install").toBeNull();
  remote.resolve(discoveryDetail({ ...plugin, installed: false }));
  await remote.promise;
  await settlePage(page);
  ui.node('[aria-label="Enable Workboard"]').not.toBeNull();
  ui.node(".plugin-catalog-detail__install").toBeNull();
});

const hello = gatewayHelloForMethods(["config.get", "config.schema", "plugins.list"]);
const capabilities = new Set<ReturnType<typeof createRuntimeConfigCapability>>();

async function mountAdvanced(options: { connected: boolean; schema?: () => Promise<unknown> }) {
  const inventory = createResult();
  const { client, request } = createScriptedClient({
    "config.get": () => configMocks["config.get"],
    "config.schema": () => (options.schema ? options.schema() : configMocks["config.schema"]),
    "plugins.list": () => inventory,
  });
  const gateway = createGateway(client, options.connected);
  gateway.emit(client, options.connected, { hello });
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  capabilities.add(runtimeConfig);
  const schemaLoads = vi.spyOn(runtimeConfig, "ensureSchemaLoaded");
  const { page } = await mountPage(
    { ...createContext(gateway.gateway), runtimeConfig },
    createPluginsRouteData(
      gateway.gateway,
      options.connected ? inventory : null,
      "/settings/plugins?tab=advanced",
    ),
  );
  return {
    page,
    request,
    runtimeConfig,
    connect: () => gateway.emit(client, true, { hello }),
    async settle() {
      await runtimeConfig.ensureLoaded();
      await Promise.all(schemaLoads.mock.results.map((result) => result.value));
      await page.updateComplete;
    },
  };
}

function expectAdvancedFields(page: HTMLElement) {
  const advanced = page.querySelector("#plugin-settings-advanced");
  expect(advanced?.textContent).toContain("Plugin system enabled");
  expect(advanced?.textContent).toContain("Allowed plugin IDs");
  expect(advanced?.textContent).toContain("Blocked plugin IDs");
  expect(advanced?.textContent).not.toContain("Plugin settings schema is unavailable");
}

it("renders global plugin settings when the Gateway connects after the page mounts", async () => {
  const harness = await mountAdvanced({ connected: false });
  await harness.settle();
  expect(harness.request).not.toHaveBeenCalledWith("config.schema", {});

  harness.connect();
  await harness.settle();

  expectAdvancedFields(harness.page);
  expect(harness.request.mock.calls.filter(([method]) => method === "config.schema")).toHaveLength(
    1,
  );
});

it("reloads the missing schema after a failed schema read", async () => {
  const firstSchema = deferred<(typeof configMocks)["config.schema"]>();
  let attempts = 0;
  const harness = await mountAdvanced({
    connected: true,
    schema: () =>
      ++attempts === 1 ? firstSchema.promise : Promise.resolve(configMocks["config.schema"]),
  });
  await harness.runtimeConfig.ensureLoaded();
  firstSchema.reject(new Error("Schema temporarily unavailable"));
  await harness.settle();
  expect(harness.page.querySelector('[role="alert"]')?.textContent).toContain(
    "Schema temporarily unavailable",
  );

  const reload = harness.page.querySelector<HTMLButtonElement>('[aria-label="Reload"]');
  expect(reload).not.toBeNull();
  const reloads = vi.spyOn(harness.runtimeConfig, "discardDraft");
  reload?.click();
  await Promise.all(reloads.mock.results.map((result) => result.value));
  await harness.settle();

  expectAdvancedFields(harness.page);
  expect(attempts).toBe(2);
  expect(harness.request.mock.calls.some(([method]) => method === "config.set")).toBe(false);
});
