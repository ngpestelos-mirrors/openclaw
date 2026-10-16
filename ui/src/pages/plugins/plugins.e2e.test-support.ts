import path from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Locator,
} from "playwright";
import { describe, onTestFinished } from "vitest";
import type { PluginsSearchResult } from "../../../../packages/gateway-protocol/src/schema/plugins.ts";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginListResult,
  PluginMutationResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type ControlUiMockGatewayScenario,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
  finalDiscoveryPageItems,
  localOnlyDiscoveryPlugin,
  matrixDiscoveryPlugin,
  secondDiscoveryPageItems,
} from "../../test-helpers/plugins-e2e-fixtures.test-support.ts";
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
export const describeControlUiE2e =
  chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifacts = new WeakMap<Page, string>();
export const mobileViewport = { height: 852, width: 393 };
const desktopViewport = { height: 1000, width: 1440 };
export const pluginMethods = [
  "plugins.reload",
  "plugins.uiDescriptors",
  "plugins.controlUi.list",
  "plugins.controlUi.report",
  "plugins.list",
  "plugins.inspect",
  "plugins.search",
  "plugins.catalog.browse",
  "plugins.catalog.categories",
  "plugins.catalog.get",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.uninstall",
];
function catalogItem<T extends Omit<PluginCatalogItem, "installed" | "enabled">>(item: T) {
  return { ...item, installed: item.state !== "not-installed", enabled: item.state === "enabled" };
}

export const workboardDisabled = catalogItem({
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  version: "2026.7.9",
  kind: ["productivity"],
  origin: "bundled",
  state: "disabled",
  featured: true,
  order: 10,
  category: "tool",
  removable: false,
});

export const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const lobsterPlugin = catalogItem({
  id: "lobster",
  name: "Lobster",
  description: "Run typed workflows with resumable approvals.",
  kind: ["plugin"],
  origin: "official",
  state: "not-installed",
  featured: true,
  order: 50,
  install: { source: "clawhub", packageName: "@openclaw/lobster" },
});

export const remoteIconPlugin = {
  ...lobsterPlugin,
  id: "remote-icon",
  name: "FireCrawl",
  description: "Web extraction and crawling.",
  order: 60,
  hasIcon: true,
  install: { source: "clawhub", packageName: "@openclaw/firecrawl" },
} satisfies PluginCatalogItem;

export const calendarPlugin = catalogItem({
  id: "calendar-plus",
  name: "Calendar Plus",
  packageName: "calendar-plus",
  description: "Plan and coordinate work from a shared calendar.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  state: "enabled",
  category: "tool",
  removable: true,
});

const telegramPlugin = catalogItem({
  id: "telegram",
  name: "Telegram",
  packageName: "@openclaw/telegram",
  description: "Chat with your agent from Telegram groups and direct messages.",
  version: "1.4.0",
  kind: ["channel"],
  origin: "bundled",
  state: "disabled",
  category: "channel",
  removable: false,
});

export const initialInventory = inventory([
  workboardDisabled,
  telegramPlugin,
  lobsterPlugin,
  remoteIconPlugin,
]);
const calendarSearchResponse = {
  results: [
    {
      score: 0.98,
      package: {
        name: "calendar-plus",
        displayName: "Calendar Plus",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        summary: "Plan and coordinate work from a shared calendar.",
        latestVersion: "1.2.3",
        downloads: 1420,
        verificationTier: "source-linked",
      },
    },
  ],
} satisfies PluginsSearchResult;

const uninstallResult = {
  ok: true,
  pluginId: "calendar-plus",
  restartRequired: false,
  removed: ["config entry", "install record", "directory"],
};

const installResult = {
  ok: true,
  plugin: calendarPlugin,
  restartRequired: false,
} satisfies PluginMutationResult;

export const installPolicyWarning = {
  installPolicyCode: "install_policy_warning_acknowledgement_required",
  targetName: "@openclaw/lobster",
  targetType: "plugin",
  requestMode: "install",
  reason: "ClawScan found issues to review.",
  findings: [
    {
      ruleId: "semgrep-finding",
      severity: "warn",
      message: "Semgrep found a risky command.",
      file: "index.ts",
      line: 12,
    },
  ],
};

export const changedInstallPolicyWarning = {
  ...installPolicyWarning,
  reason: "ClawScan returned a changed warning after the fresh check.",
  findings: [
    {
      ruleId: "dependency-finding",
      severity: "critical",
      message: "The freshly checked warning changed and requires review.",
      file: "package-lock.json",
      line: 24,
    },
  ],
};

const enableWorkboardResult = {
  ok: true,
  plugin: workboardEnabled,
  restartRequired: false,
} satisfies PluginMutationResult;

const workboardInspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboardDisabled.id,
    name: workboardDisabled.name,
    origin: workboardDisabled.origin,
    installed: true,
    enabled: false,
  },
  source: { kind: "npm", packageName: workboardDisabled.packageName },
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
      allowConversationAccess: { effective: true },
    },
  },
} satisfies PluginsInspectResult;

const lobsterInspection = {
  ...workboardInspection,
  reviewToken: "b".repeat(64),
  plugin: {
    id: lobsterPlugin.id,
    name: lobsterPlugin.name,
    origin: lobsterPlugin.origin,
    installed: false,
    enabled: false,
  },
  source: { kind: "npm", packageName: "@openclaw/lobster" },
} satisfies PluginsInspectResult;

export const calendarInspection = {
  ...workboardInspection,
  reviewToken: "c".repeat(64),
  plugin: { ...calendarPlugin, installed: false, enabled: false },
  source: { kind: "clawhub", packageName: "calendar-plus" },
  declared: { ...workboardInspection.declared, tools: ["calendar_create"] },
} satisfies PluginsInspectResult;

const matrixDetail = {
  plugin: {
    ...matrixDiscoveryPlugin,
    catalog: { ...matrixDiscoveryPlugin.catalog, latestVersion: "2.1.0" },
  },
  detail: {
    origin: "clawhub",
    packageName: "matrix",
    author: { handle: "openclaw", displayName: "OpenClaw" },
    topics: ["Matrix", "Messaging"],
    createdAt: 1_760_000_000_000,
    updatedAt: 1_780_000_000_000,
    readme: "# Matrix\n\nConnect OpenClaw to Matrix rooms and direct messages.",
    compatibility: {
      minGatewayVersion: ">=2026.5.1",
      pluginApiRange: ">=2026.5.1",
    },
    configuration: [
      {
        name: "homeserver",
        description: "Matrix homeserver URL",
        required: true,
        sensitive: false,
      },
      {
        name: "accessToken",
        description: "Matrix access token",
        required: true,
        sensitive: true,
      },
    ],
    mcpServers: [],
    skills: [{ name: "Matrix messaging", description: "Send and receive Matrix messages." }],
    versions: [
      {
        version: "2.1.0",
        createdAt: 1_780_000_000_000,
        changelog: "Current release",
        tags: ["latest"],
      },
      { version: "2.0.0", createdAt: 1_770_000_000_000, changelog: "Previous release", tags: [] },
    ],
    verification: {
      tier: "source-linked",
      summary: "Validated package structure and linked release source.",
      sourceRepo: "openclaw/openclaw",
      sourceCommit: "abc123",
      sourcePath: "extensions/matrix",
      scanStatus: "clean",
    },
    security: {
      status: "clean",
      verdict: "benign",
      auditUrl: "https://clawhub.ai/openclaw/plugins/matrix/security-audit",
      summary: "Capabilities match the stated purpose.",
      guidance: "Review the access token before enabling.",
      checkedAt: 1_780_000_000_000,
    },
  },
} satisfies PluginDiscoveryDetailResult;

export const calendarDiscoveryPlugin = {
  ...matrixDiscoveryPlugin,
  id: "ch_Y2FsZW5kYXItcGx1cw",
  catalog: {
    ...matrixDiscoveryPlugin.catalog,
    name: calendarPlugin.name,
    summary: calendarPlugin.description,
    official: false,
    author: "calendar-author",
  },
};

export const calendarDetail = {
  plugin: calendarDiscoveryPlugin,
  detail: {
    origin: "clawhub",
    packageName: "calendar-plus",
    topics: [],
    configuration: [],
    mcpServers: [],
    skills: [],
    versions: [],
  },
} satisfies PluginDiscoveryDetailResult;

export const matrixNeedsSetup = catalogItem({
  id: "matrix",
  name: "Matrix",
  packageName: "matrix",
  description: "Connect OpenClaw to Matrix rooms and direct messages.",
  version: "2.1.0",
  kind: ["channel"],
  origin: "global",
  state: "needs-setup",
  category: "channel",
  removable: true,
});

export const matrixEnabled = {
  ...matrixNeedsSetup,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

function objectSchema<T>(properties: T) {
  return { type: "object", properties };
}

export const matrixConfigSchema = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  schema: objectSchema({
    plugins: objectSchema({
      entries: objectSchema({
        matrix: objectSchema({
          enabled: { type: "boolean", title: "Enabled" },
          config: {
            ...objectSchema({
              homeserver: { type: "string", title: "Homeserver" },
              accessToken: { type: "string", title: "Access token" },
              mode: { type: ["string", "null"], enum: ["auto", null], title: "Mode" },
            }),
            required: ["homeserver", "accessToken"],
          },
        }),
      }),
    }),
  }),
  uiHints: {
    "plugins.entries.matrix.config.homeserver": { advanced: false },
    "plugins.entries.matrix.config.accessToken": { advanced: false, sensitive: true },
  },
  version: "e2e",
};

const localOnlyDetail = {
  plugin: localOnlyDiscoveryPlugin,
  detail: {
    origin: "local",
    packageName: "@openclaw/local-calendar",
    topics: [],
    configuration: [],
    mcpServers: [],
    skills: [{ name: "Calendar planning" }],
    versions: [],
  },
} satisfies PluginDiscoveryDetailResult;

export const localCalendarDisabled = catalogItem({
  id: "local-calendar",
  name: "Local Calendar",
  packageName: "@openclaw/local-calendar",
  description: "Coordinate work using the included calendar plugin.",
  version: "1.0.0",
  kind: ["productivity"],
  origin: "official",
  state: "disabled",
  category: "tool",
  removable: false,
});

let browser: Browser;
export let server: ControlUiE2eServer;

export function inventory(plugins: PluginCatalogItem[], generation = 0): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true, generation };
}

export function configSnapshot(isWorkboardEnabled: boolean) {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: isWorkboardEnabled },
      },
    },
  };
  return {
    config,
    hash: isWorkboardEnabled ? "plugins-config-enabled" : "plugins-config-disabled",
    issues: [],
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
    valid: true,
  };
}

export function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "plugins-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: pluginMethods },
    controlUiTabs: [],
    protocol: PROTOCOL_VERSION,
    server: { connId: "plugins-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

export function enabledWorkboardCapabilities() {
  return {
    ok: true,
    generation: 1,
    descriptors: [],
    methods: pluginMethods,
    controlUiWidgetKinds: [],
    pluginSurfaceUrls: {},
    controlUiTabs: [
      {
        group: "control",
        icon: "kanban",
        id: "workboard",
        label: workboardEnabled.name,
        placement: "route:workboard",
        pluginId: "workboard",
      },
    ],
  };
}

export async function captureScreenshot(
  page: Page,
  name: string,
  target: "content" | "viewport" = "content",
): Promise<void> {
  if (!updateScreenshots) {
    return;
  }
  let artifactDir = artifacts.get(page);
  if (!artifactDir) {
    artifactDir = createControlUiE2eArtifactDir("plugins");
    artifacts.set(page, artifactDir);
  }
  await (target === "viewport" ? page : page.locator(".content")).screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(artifactDir, name),
  });
}

export async function newContext(
  viewport = desktopViewport,
  options: Pick<BrowserContextOptions, "hasTouch" | "recordVideo"> = {},
): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...options,
  });
}

export function button(scope: Page | Locator, name: string) {
  return scope.getByRole("button", { name, exact: true });
}

export async function openPluginTest(
  responses: ControlUiMockGatewayScenario["methodResponses"] = {},
  {
    viewport = desktopViewport,
    nativeAuth = false,
    heldMethods = [],
  }: {
    viewport?: { width: number; height: number };
    nativeAuth?: boolean;
    heldMethods?: string[];
  } = {},
) {
  const context = await newContext(viewport);
  onTestFinished(() => context.close());
  const page = await context.newPage();
  if (nativeAuth) {
    await page.addInitScript(
      (gatewayUrl) => {
        window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
      },
      server.baseUrl.replace(/^http/u, "ws"),
    );
  }
  const gateway = await installMockGateway(page, {
    featureMethods: pluginMethods,
    methodResponses: { ...pluginMethodResponses(), ...responses },
    heldMethods,
  });
  return { page, gateway };
}

export async function completeInstall(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  plugin: PluginCatalogItem,
) {
  await gateway.setMethodResponse("plugins.list", inventory([...initialInventory.plugins, plugin]));
  await gateway.resolveDeferred("plugins.install", { ok: true, plugin, restartRequired: false });
}

function responseCases(entries: Array<[Record<string, unknown>, unknown]>) {
  return { cases: entries.map(([match, response]) => ({ match, response })) };
}

export function pluginMethodResponses() {
  return {
    "plugins.controlUi.list": { revision: "empty", plugins: [], diagnostics: [] },
    "config.get": configSnapshot(false),
    "plugins.list": initialInventory,
    "plugins.inspect": responseCases([
      [{ pluginId: "workboard" }, workboardInspection],
      [{ pluginId: "lobster" }, lobsterInspection],
      [{ pluginId: "calendar-plus" }, calendarInspection],
      ...[localCalendarDisabled, matrixEnabled].map(
        (plugin): [Record<string, unknown>, PluginsInspectResult] => [
          { pluginId: plugin.id },
          {
            ...workboardInspection,
            plugin,
            source: { kind: "npm", packageName: plugin.packageName },
          },
        ],
      ),
    ]),
    "plugins.search": responseCases([[{ query: "calendar", limit: 20 }, calendarSearchResponse]]),
    "plugins.catalog.browse": responseCases([
      [
        { intent: "all", cursor: "catalog-page-2", pageSize: 100 },
        { items: secondDiscoveryPageItems, nextCursor: "catalog-page-3" },
      ],
      [
        { intent: "all", cursor: "catalog-page-3", pageSize: 100 },
        { items: finalDiscoveryPageItems },
      ],
      [{ intent: "official", pageSize: 100 }, { items: [matrixDiscoveryPlugin] }],
      [{ intent: "all", category: "channels", pageSize: 100 }, { items: [matrixDiscoveryPlugin] }],
      [{ intent: "all", query: "matrix", pageSize: 100 }, { items: [matrixDiscoveryPlugin] }],
      [{ intent: "all", pageSize: 100 }, discoveryResult],
    ]),
    "plugins.catalog.categories": discoveryCategories,
    "plugins.catalog.get": responseCases([
      [{ id: matrixDiscoveryPlugin.id }, matrixDetail],
      [{ id: calendarDiscoveryPlugin.id }, calendarDetail],
      [{ id: localOnlyDiscoveryPlugin.id }, localOnlyDetail],
    ]),
    "plugins.install": responseCases([
      [
        {
          source: "clawhub",
          packageName: "calendar-plus",
          acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
        },
        installResult,
      ],
    ]),
    "plugins.setEnabled": responseCases([
      [{ pluginId: "workboard", enabled: true }, enableWorkboardResult],
    ]),
    "plugins.uninstall": responseCases([[{ pluginId: "calendar-plus" }, uninstallResult]]),
  };
}

export async function setupPluginsE2e(): Promise<void> {
  if (!chromiumAvailable) {
    throw new Error(
      `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
    );
  }
  server = await startControlUiE2eServer();
  browser = await chromium.launch({ executablePath: chromiumExecutablePath });
}

export async function teardownPluginsE2e(): Promise<void> {
  await browser?.close();
  await server?.close();
}

export { discoveryResult, installMockGateway, localOnlyDiscoveryPlugin, matrixDiscoveryPlugin };
