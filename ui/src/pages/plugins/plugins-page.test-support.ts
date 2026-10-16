import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createSignal, flush } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { ControlUiPluginRuntime } from "../../plugins/control-ui-runtime.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginsPage } from "./plugins-page.tsx";
import type { PluginsRouteData } from "./route-data.ts";

type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
type RuntimeConfig = ApplicationContext["runtimeConfig"];

const PLUGINS_GATEWAY_HELLO = gatewayHelloForMethods([
  "config.set",
  "plugins.inspect",
  "plugins.install",
  "plugins.list",
  "plugins.reload",
  "plugins.setEnabled",
  "plugins.uninstall",
]);

type TestPluginsPage = HTMLElement & {
  surface: "discovery" | "settings";
  routeData?: PluginsRouteData;
  readonly updateComplete: Promise<boolean>;
};

export type RuntimeConfigTestState = {
  connected?: boolean;
  configFormDirty: boolean;
  lastError: string | null;
  configSnapshot?: { sourceConfig: Record<string, unknown>; hash: string } | null;
};

export function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: t("subtitles.workboard"),
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    ...overrides,
  };
}

export function createResult(
  pluginOrPlugins: PluginCatalogItem | PluginCatalogItem[] = createPlugin(),
): PluginListResult {
  return {
    plugins: Array.isArray(pluginOrPlugins) ? pluginOrPlugins : [pluginOrPlugins],
    diagnostics: [],
    mutationAllowed: true,
  };
}

export function createDiscoveryDetail(plugin = createPlugin()): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: `catalog:${plugin.id}`,
      catalog: {
        name: plugin.name,
        family: "code-plugin",
        official: plugin.origin === "official",
        categories: [],
      },
      local: {
        pluginId: plugin.installed ? plugin.id : undefined,
        present: plugin.installed,
        installed: plugin.installed,
        enabled: plugin.enabled,
        state: plugin.state,
        action: plugin.installed ? "manage" : "install",
        install: plugin.install,
      },
    },
    detail: {
      origin: "clawhub",
      packageName: plugin.packageName ?? plugin.id,
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
  };
}

export function createInspectResult(
  overrides: Partial<PluginsInspectResult> = {},
): PluginsInspectResult {
  return {
    ok: true,
    reviewToken: "review-token-workboard",
    plugin: {
      id: "workboard",
      name: "Workboard",
      origin: "global",
      installed: true,
      enabled: false,
    },
    source: { kind: "npm", packageName: "workboard" },
    declared: {
      channels: [],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    components: {
      mapped: [],
      skills: [],
      mcpServers: [],
      commands: [],
      hooks: [],
      lspServers: [],
      unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
    ...overrides,
  };
}

export function createPluginsRouteLocation(url = "/settings/plugins"): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

export function createPluginsRouteData(
  gateway: ApplicationGateway,
  result: PluginListResult | null = createResult(),
  location: RouteLocation | string = createPluginsRouteLocation(),
): PluginsRouteData {
  return {
    gateway,
    gatewaySnapshot: gateway.snapshot,
    result,
    error: null,
    location: typeof location === "string" ? createPluginsRouteLocation(location) : location,
  };
}

export function createScriptedClient(
  handlers: Record<string, (params: unknown) => unknown>,
  fallback?: () => unknown,
) {
  return createClient(async (method, params) => {
    const handler = handlers[method] ?? fallback;
    if (!handler) {
      throw new Error(`Unexpected method: ${method}`);
    }
    return handler(params);
  });
}

export function createClient(handler: RequestHandler) {
  const request = vi.fn(handler);
  return {
    client: { request, addEventListener: () => () => {} } as unknown as GatewayBrowserClient,
    request,
  };
}

function createSnapshot(
  client: GatewayBrowserClient | null,
  connected: boolean,
): ApplicationGatewaySnapshot {
  return {
    client,
    phase: connected ? "connected" : "reconnecting",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: PLUGINS_GATEWAY_HELLO,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
}

export function createGateway(client: GatewayBrowserClient, connected = true) {
  const { gateway, publish } = createApplicationGateway(createSnapshot(client, connected));
  Object.assign(gateway, {
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  return {
    gateway,
    publishPlugins() {
      const snapshot = gateway.snapshot;
      publish({
        ...snapshot,
        pluginCapabilities: {
          ok: true,
          generation: (snapshot.pluginCapabilities?.generation ?? 0) + 1,
          descriptors: [],
          methods: snapshot.hello?.features?.methods ?? [],
          controlUiTabs: [],
          controlUiWidgetKinds: [],
          pluginSurfaceUrls: {},
        },
      });
    },
    emit(
      nextClient: GatewayBrowserClient | null,
      nextConnected: boolean,
      overrides: Partial<ApplicationGatewaySnapshot> = {},
    ) {
      const snapshot = { ...createSnapshot(nextClient, nextConnected), ...overrides };
      publish(snapshot);
      return snapshot;
    },
  };
}

export function createRuntimeConfigHarness(
  refreshConfig: RuntimeConfig["refresh"],
  runtimeConfigState: RuntimeConfigTestState,
  getClient?: () => GatewayBrowserClient | null,
) {
  const listeners = new Set<(state: RuntimeConfigTestState) => void>();
  const patch = vi.fn<
    (options: { raw: Record<string, unknown>; note: string }) => Promise<boolean>
  >(async () => true);
  const runExternalMutation: RuntimeConfig["runExternalMutation"] = async (task) => {
    const client = getClient?.() ?? null;
    if (!client) {
      return {
        ok: false,
        reason: "unavailable",
        error: "Configuration is unavailable; reconnect and try again.",
      };
    }
    try {
      const value = await task(client);
      try {
        await refreshConfig();
        return { ok: true, value, refresh: { ok: true } };
      } catch (error) {
        return {
          ok: true,
          value,
          refresh: { ok: false, error: error instanceof Error ? error.message : String(error) },
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const runtimeConfig = {
    // Keep the fixture identity used by autosave notifications, with the owner's real defaults.
    state: Object.assign(runtimeConfigState, createInitialConfigState(), { ...runtimeConfigState }),
    canSet: true,
    refresh: refreshConfig,
    ensureLoaded: vi.fn(async () => undefined),
    ensureSchemaLoaded: vi.fn(async () => undefined),
    refreshSchema: vi.fn(async () => undefined),
    retry: vi.fn(async () => true),
    patch,
    patchForm: vi.fn<RuntimeConfig["patchForm"]>(),
    removeFormValue: vi.fn<RuntimeConfig["removeFormValue"]>(),
    save: vi.fn(async () => true),
    flushFormChanges: vi.fn(async () => true),
    patchFromSnapshot: async (build: Parameters<RuntimeConfig["patchFromSnapshot"]>[0]) => {
      const built = build(runtimeConfigState.configSnapshot?.sourceConfig ?? {});
      if ("error" in built) {
        runtimeConfigState.lastError = built.error;
        return false;
      }
      return patch(built.options);
    },
    runExternalMutation,
    subscribe(listener: (state: RuntimeConfigTestState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    runtimeConfig,
    notify: () => {
      for (const listener of listeners) {
        listener(runtimeConfigState);
      }
    },
  };
}

export function createContext(
  gateway: ApplicationGateway,
  refreshConfig: RuntimeConfig["refresh"] = vi.fn(async () => undefined),
  runtimeConfigState: RuntimeConfigTestState = {
    configFormDirty: false,
    lastError: null,
  },
  harness = createRuntimeConfigHarness(
    refreshConfig,
    runtimeConfigState,
    () => gateway.snapshot.client,
  ),
): ApplicationContext {
  const plugins = new ControlUiPluginRuntime(() => context);
  onTestFinished(() => plugins.dispose());
  const context = {
    gateway,
    plugins,
    basePath: "",
    resourceBasePath: "",
    runtimeConfig: harness.runtimeConfig,
    navigate: vi.fn(),
    replace: vi.fn(),
  } as unknown as ApplicationContext;
  return context;
}

export async function settlePlugins(): Promise<boolean> {
  flush();
  await Promise.resolve();
  flush();
  await Promise.resolve();
  flush();
  return true;
}

function createPageAssertions(page: HTMLElement) {
  return {
    get text() {
      return expect(page.textContent);
    },
    node: (selector: string) => expect(page.querySelector(selector)),
    content: (selector: string) => expect(page.querySelector(selector)?.textContent),
  };
}

export async function mountPage(
  context: ApplicationContext,
  routeData?: PluginsRouteData,
  surface: TestPluginsPage["surface"] = routeData?.location.pathname.includes("/settings/plugins")
    ? "settings"
    : "discovery",
): Promise<{
  page: TestPluginsPage;
  find: TestPluginsPage["querySelector"];
  ui: ReturnType<typeof createPageAssertions>;
}> {
  const [currentRouteData, setRouteData] = createSignal(routeData);
  const [currentSurface, setSurface] = createSignal(surface);
  const mounted = mountSolid(
    () =>
      createComponent(PluginsPage, {
        get routeData() {
          return currentRouteData();
        },
        get surface() {
          return currentSurface();
        },
      }),
    {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    },
  );
  await settlePlugins();
  const page = mounted.container.querySelector("openclaw-plugins-page") as TestPluginsPage;
  if (!page) {
    throw new Error("Plugins page did not render its host element");
  }
  Object.defineProperties(page, {
    routeData: { get: currentRouteData, set: setRouteData },
    surface: { get: currentSurface, set: setSurface },
    updateComplete: { get: settlePlugins },
  });
  page.remove = () => mounted.unmount();
  return { page, find: page.querySelector.bind(page), ui: createPageAssertions(page) };
}

export async function clickPluginAction(page: HTMLElement, label: string): Promise<void> {
  const button = await waitForSolid(() => {
    const control = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) =>
        element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
    );
    if (!control) {
      throw new Error(`No plugin action matching ${label}`);
    }
    return control;
  });
  button.click();
  await settlePlugins();
}

export function resetPluginsPageTestState(): void {
  cleanupSolid();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
