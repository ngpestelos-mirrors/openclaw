import type { Page } from "playwright";
import { APP_ROUTE_IDS, pathForRoute, type RouteId } from "../../ui/src/app-route-paths.ts";
import { CONFIG_PAGE_IDS } from "../../ui/src/pages/config/config-sections.ts";
import {
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";

export const fixedTime = Date.parse("2026-09-01T12:00:00Z");
export const sessionKey = "agent:main:parity";
const session = createControlUiSessionRow(sessionKey, "Visual parity", fixedTime - 60_000, {
  sharingRole: "owner",
  visibility: "draft",
  icon: "🦞",
  color: "blue",
});
const config = {
  browser: { enabled: true, mode: "local" },
  agents: { defaults: { model: "openai/gpt-5.5" } },
};
export const baseScenario: ControlUiMockGatewayScenario = {
  sessionKey,
  sessions: [session],
  allowedSessionVisibilities: ["shared", "read-only", "suggest", "draft"],
  operatorScopes: ["operator.admin", "operator.read", "operator.write"],
  featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
  historyMessages: [
    {
      role: "user",
      content: [{ type: "text", text: "Review the release checklist." }],
      timestamp: fixedTime - 60_000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "## Release checklist\n\n- Build verified\n- Mobile review pending\n\n| Check | Result |\n| --- | --- |\n| Unit | Passed |\n| Browser | Passed |\n\n```ts\nconst ready = true;\n```",
        },
      ],
      timestamp: fixedTime - 30_000,
    },
  ],
  methodResponses: {
    "config.get": {
      config,
      raw: JSON.stringify(config),
      hash: "parity-config",
      valid: true,
      issues: [],
    },
    "config.schema": {
      generatedAt: "2026-09-01T12:00:00Z",
      version: "parity",
      uiHints: {},
      schema: {
        type: "object",
        properties: {
          browser: {
            type: "object",
            title: "Browser",
            properties: {
              enabled: { type: "boolean", title: "Browser Enabled" },
              mode: { type: "string", title: "Mode", enum: ["local", "remote", "disabled"] },
            },
          },
        },
      },
    },
    "session.members.listEvidence": {
      sessionKey,
      owner: { type: "human", id: "owner", label: "Owner" },
      members: [],
      role: "owner",
      allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
      identities: Array.from({ length: 30 }, (_, i) => ({
        type: "human",
        id: `person-${i}`,
        label: `Person ${String(i).padStart(2, "0")} with a long display name`,
      })),
    },
    "cron.list": { jobs: [], total: 0, hasMore: false },
    "cron.status": { enabled: true, jobs: 0, storePath: "/mock/cron", nextWakeAtMs: null },
    "logs.tail": {
      file: "/mock/gateway.log",
      cursor: 0,
      size: 0,
      lines: [],
      truncated: false,
      reset: false,
    },
    "worktrees.list": { worktrees: [] },
    "worktrees.branches": { branches: [] },
    "node.list": { nodes: [] },
    "device.pair.list": { pending: [], paired: [] },
    "system-presence": [],
    "channels.status": {
      ts: fixedTime,
      channelOrder: [],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
    },
  },
};

export type Profile = {
  id: string;
  width: number;
  height: number;
  theme: "light" | "dark";
  rtl?: boolean;
  scale?: number;
  forced?: boolean;
  reduced?: boolean;
};
export const profiles: Profile[] = [
  { id: "desktop-light", width: 1440, height: 960, theme: "light" },
  { id: "desktop-dark", width: 1440, height: 960, theme: "dark" },
  { id: "mobile-light", width: 390, height: 844, theme: "light" },
  { id: "mobile-dark", width: 390, height: 844, theme: "dark" },
  { id: "desktop-rtl", width: 1440, height: 960, theme: "light", rtl: true },
  { id: "mobile-rtl", width: 390, height: 844, theme: "dark", rtl: true },
  { id: "desktop-large-text", width: 1440, height: 960, theme: "dark", scale: 1.5 },
  { id: "mobile-large-text", width: 390, height: 844, theme: "light", scale: 1.5 },
  { id: "desktop-forced-colors", width: 1440, height: 960, theme: "light", forced: true },
  { id: "mobile-forced-colors", width: 390, height: 844, theme: "dark", forced: true },
  { id: "desktop-reduced-motion", width: 1440, height: 960, theme: "dark", reduced: true },
  { id: "mobile-reduced-motion", width: 390, height: 844, theme: "light", reduced: true },
];
export type Scene = {
  id: string;
  label: string;
  route: RouteId;
  path: string;
  ready: string;
  scenario?: ControlUiMockGatewayScenario;
  prepare?: (page: Page) => Promise<void>;
};
const configPages = new Set<string>(CONFIG_PAGE_IDS);
function routeScene(route: RouteId): Scene {
  // These catalog entries intentionally redirect; record both the requested and final route.
  const destination =
    route === "settings"
      ? "chat"
      : route === "config"
        ? "appearance"
        : route === "model-setup"
          ? "model-providers"
          : route;
  const host = configPages.has(destination)
    ? "config"
    : destination === "dashboard"
      ? "chat"
      : destination === "workboard"
        ? "plugin"
        : destination === "skill-settings"
          ? "skills"
          : destination === "plugin-settings"
            ? "plugins"
            : destination;
  return {
    id: `route-${route}`,
    label: `${route}: main state${destination !== route ? ` (redirect to ${destination})` : ""}`,
    route: destination,
    path:
      route === "chat" || route === "dashboard"
        ? `${pathForRoute(route)}?session=${sessionKey}`
        : pathForRoute(route),
    ready: `openclaw-${host}-page`,
  };
}
const chat = routeScene("chat");
export const scenes: Scene[] = [
  ...APP_ROUTE_IDS.map(routeScene),
  {
    ...chat,
    id: "chat-empty",
    label: "Chat: empty transcript",
    ready: ".agent-chat__welcome",
    scenario: { historyMessages: [] },
  },
  {
    ...chat,
    id: "chat-error",
    label: "Chat: history unavailable",
    ready: ".chat-history-error",
    prepare: async (page) => {
      await page
        .getByText("Synthetic history unavailable. Retry the request.", { exact: true })
        .waitFor();
    },
    scenario: {
      methodResponses: {
        "chat.startup": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Synthetic history unavailable. Retry the request.",
          },
        },
        "chat.history": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Synthetic history unavailable. Retry the request.",
          },
        },
      },
      awaitInitialRoster: false,
    },
  },
  {
    ...chat,
    id: "chat-long-content",
    label: "Chat: long transcript, wrapping, table and code",
    prepare: async (page) => {
      await page.getByText(/Message 39: A deliberately long sentence/u).waitFor();
    },
    scenario: {
      historyMessages: Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        timestamp: fixedTime - (40 - i) * 1000,
        content: [
          {
            type: "text",
            text: `Message ${i}: A deliberately long sentence exercises wrapping and spacing across narrow and enlarged layouts.\n\n${i % 2 ? "```ts\nconst deterministic = true;\n```" : "- First point\n- Second point"}`,
          },
        ],
      })),
    },
  },
  {
    ...chat,
    id: "session-menu",
    label: "Session menu: icons, selected and disabled actions",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menu", { name: "Actions for Visual parity" }).waitFor();
    },
  },
  {
    ...chat,
    id: "session-submenu",
    label: "Session menu: appearance submenu and selected color",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Icon & color", exact: true }).click();
      await page.locator(".session-menu__appearance:visible").waitFor();
    },
  },
  {
    ...chat,
    id: "session-modal",
    label: "Session rename modal form",
    prepare: async (page) => {
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await page.getByRole("dialog").waitFor();
    },
  },
  {
    ...routeScene("infrastructure"),
    id: "settings-controls",
    path: "/settings/infrastructure?section=browser&advanced=1#config-section-browser",
    label: "Settings: switch and radio controls",
    ready: "#config-section-browser .settings-row",
  },
];
