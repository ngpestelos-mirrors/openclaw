import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureSidebarUiProof } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar subagent navigation" });

suite.define(() => {
  it.each(
    (["chip", "roster"] as const).flatMap((mode) => [false, true].map((home) => ({ mode, home }))),
  )(
    "opens a nested subagent transcript and returns to its parent ($mode, Home=$home)",
    async ({ mode, home }) => {
      const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 800 },
        ...(capture
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 800 } } }
          : {}),
      });
      const page = await context.newPage();
      const video = page.video();
      const parentKey = home ? "agent:main:main" : "agent:main:dashboard:sidebar-repair";
      const childKey = "agent:main:subagent:sidebar-review";
      const swarmKey = "agent:main:subagent:parallel-check";
      const baseTime = Date.parse("2026-10-03T12:00:00Z");
      await page.clock.setFixedTime(baseTime + 120_000);
      const parent = sessionRow(parentKey, "Improve sidebar navigation", baseTime, {
        childSessions: [childKey, swarmKey],
        isMain: home,
        swarm: {
          groups: [
            {
              groupId: "parallel-checks",
              createdAt: baseTime,
              queued: 0,
              running: 1,
              done: 0,
              failed: 0,
              children: [{ sessionKey: swarmKey, status: "running" }],
            },
          ],
          otherActiveGroups: 0,
        },
      });
      const swarm = sessionRow(swarmKey, "Check parallel task", baseTime + 2, {
        parentSessionKey: parentKey,
        spawnedBy: parentKey,
        swarmGroupId: "parallel-checks",
        status: "running",
        hasActiveRun: true,
      });
      const child = sessionRow(childKey, "Review navigation changes", baseTime + 1, {
        parentSessionKey: parentKey,
        spawnedBy: parentKey,
        status: "running",
        hasActiveRun: true,
        startedAt: baseTime,
        runtimeMs: 120_000,
      });
      await page.addInitScript(
        ({ settingsKey, mode: sidebarMode }) => {
          localStorage.setItem(
            settingsKey,
            JSON.stringify({ sidebarAgentsMode: sidebarMode, themeMode: "dark" }),
          );
          localStorage.setItem(
            "openclaw:control-ui:community-invite:v2",
            JSON.stringify({ dismissedAtMs: Date.now() }),
          );
        },
        { settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode },
      );
      const gateway = await installMockGateway(page, {
        sessions: [parent, child, swarm],
        sessionKey: parentKey,
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Reviewing the navigation changes." }],
          },
        ],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
        await waitForControlUiRoute(page, { routeId: "chat" });
        const sidebar = page.locator("openclaw-app-sidebar");
        const parentRow =
          home && mode === "chip"
            ? sidebar.locator(".nav-item--home").locator("..")
            : sidebar.locator(
                home
                  ? '[data-agent-group="main"] .sidebar-agent-roster__header'
                  : `[data-session-key="${parentKey}"]`,
              );
        await parentRow.waitFor();
        const capturePrefix = `${mode}-${home ? "home" : "conversation"}`;
        await captureSidebarUiProof(suite, page, `${capturePrefix}-initial.png`);
        const toggle = parentRow.locator(
          home && mode === "roster" ? "[data-agent-collapse]" : "[data-child-session-toggle]",
        );
        await expect.poll(() => toggle.count()).toBe(1);
        await parentRow.hover();
        if (home && mode === "chip") {
          const pagesEditor = sidebar.locator(".sidebar-nav__head-action");
          await pagesEditor.click({ trial: true });
          const editorBounds = await pagesEditor.boundingBox();
          const toggleBounds = await toggle.boundingBox();
          expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(toggleBounds!.x);
        }
        if ((await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        const childRow = sidebar.locator(`[data-session-key="${childKey}"]`);
        await childRow.waitFor();
        expect(await sidebar.locator(`[data-session-key="${swarmKey}"]`).count()).toBe(0);
        await page.locator('[data-swarm-group="parallel-checks"]').waitFor();
        expect(await childRow.locator('[aria-label="View-only subagent"]').count()).toBe(1);
        expect(await childRow.locator(".session-glyph__ring").count()).toBe(1);
        if (mode === "chip") {
          const leading = await parentRow.locator(".session-glyph").first().boundingBox();
          const disclosure = await toggle.boundingBox();
          expect(disclosure!.x).toBeGreaterThan(leading!.x + leading!.width);
          const state = await childRow.locator(".sidebar-session-indicator").boundingBox();
          const type = await childRow.locator(".sidebar-session-subagent-indicator").boundingBox();
          expect(type!.x).toBeGreaterThan(state!.x);
        }
        await captureSidebarUiProof(suite, page, `${capturePrefix}-expanded.png`);
        await childRow.locator("a.sidebar-recent-session__link").click();
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await activePane.getByText("View-only subagent", { exact: true }).waitFor();
        expect(await activePane.locator(".agent-chat__composer-combobox textarea").count()).toBe(0);
        expect(await sidebar.locator(`[data-session-key="${childKey}"]`).count()).toBe(1);
        await captureSidebarUiProof(suite, page, `${capturePrefix}-selected.png`);
        await activePane.getByRole("button", { name: "Open parent session", exact: true }).click();
        await activePane.locator(".agent-chat__composer-combobox textarea").waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await parentRow.hover();
        await toggle.click();
        await expect.poll(() => childRow.count()).toBe(0);
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        await captureSidebarUiProof(suite, page, `${capturePrefix}-collapsed.png`);
      } finally {
        await suite.closeBrowserContext(context);
        if (capture && video) {
          await video.saveAs(
            path.join(
              suite.artifactDir,
              `${mode}-${home ? "home" : "conversation"}-navigation.webm`,
            ),
          );
        }
      }
    },
  );
});
