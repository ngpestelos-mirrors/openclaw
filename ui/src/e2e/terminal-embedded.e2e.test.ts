import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { nativeAuth, terminalSession } from "./workspace-terminal.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "embedded terminal document",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it.each(["chat", "focus/terminal"])("routes focused terminal keys in %s", async (route) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        terminalEnabled: true,
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        methodResponses: {
          "terminal.list": {
            sessions: [
              { ...terminalSession("keyboard-terminal", { shell: "/bin/sh" }), attached: true },
            ],
          },
          "terminal.open": terminalSession("keyboard-terminal", { shell: "/bin/sh" }),
          "terminal.attach": {
            cases: [
              {
                match: { sessionId: "keyboard-terminal" },
                response: {
                  ...terminalSession("keyboard-terminal", { shell: "/bin/sh" }),
                  buffer: "",
                  seq: 0,
                },
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      await waitForControlUiGatewayReady(page);
      if (route === "chat") {
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        await page.keyboard.press("Control+Backquote");
      }
      const panel = page
        .locator("openclaw-terminal-panel")
        .filter({ has: page.locator(".tp-host") });
      const terminal = panel.locator(".tp-host");
      if (route === "chat") {
        await panel.locator(".tp-session.is-current").click();
      }
      await terminal.locator("canvas").waitFor();
      await terminal.click();
      await page.keyboard.type("x");
      await gateway.waitForRequest("terminal.input");
      const before = await gateway.getRequests("terminal.input");
      await page.keyboard.press("Control+Backquote");
      if (route === "chat") {
        const tabLabel = page
          .locator('[data-region-header="side"] .tabstrip-tab__label')
          .filter({ hasText: "sh" });
        await tabLabel.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("terminal.input")).toEqual(before);
        await page.keyboard.press("Control+Backquote");
        await panel.locator(".tp-session.is-current").click();
        await tabLabel.waitFor();
      } else {
        await expect
          .poll(async () => (await gateway.getRequests("terminal.input")).length)
          .toBe(before.length + 1);
        expect(await panel.locator(".tp-header").isVisible()).toBe(true);
        expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      }
    });
  });

  it("returns from an unavailable focused terminal", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator("openclaw-app-shell").waitFor();
      await page.goto(`${suite.server.baseUrl}?view=terminal`);

      await page.waitForURL(`${suite.server.baseUrl}focus/terminal`);
      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

      await page
        .getByText("The terminal is not available on this gateway.", { exact: true })
        .waitFor();
      const back = page.getByRole("button", { name: "Back", exact: true });
      await back.waitFor();
      await back.click();
      await page.waitForURL(`${suite.server.baseUrl}dashboards`);
    });
  });

  it("fences an SW-less stale build before it can restore an ownerless terminal", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws");
      await nativeAuth(page, "native-build-identity-token", gatewayUrl);
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        serverBuildId: "replacement-build",
        // This build-admission fence intentionally prevents initial roster hydration.
        awaitInitialRoster: false,
        terminalEnabled: true,
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      const firstConnect = await gateway.waitForRequest("connect");
      expect(firstConnect.params).toMatchObject({ client: { buildId: "e2e" } });
      await page.waitForFunction(
        () =>
          JSON.parse(sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId") ?? "null")
            ?.buildId === "replacement-build",
      );
      await page.getByText("Server updated", { exact: true }).waitFor();

      expect(await gateway.getRequests("terminal.open")).toHaveLength(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(0);
    });
  });

  it("keeps an independently built same-origin Control UI connected", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gatewayUrl = suite.server.baseUrl.replace(/^http/u, "ws");
      await nativeAuth(page, "native-configured-ui-token", gatewayUrl);
      const gateway = await installMockGateway(page, {
        assistantAgentId: "main",
        controlUiBuildSource: "configured",
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        methodResponses: {
          "terminal.open": terminalSession("configured-ui-terminal"),
        },
        serverBuildId: "independent-build",
        serverVersion: "2026.7.20",
        terminalEnabled: true,
      });

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      await gateway.waitForRequest("connect");
      await waitForControlUiTerminalReady(page);
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: { agentId: "main", open: true },
          }),
        );
      });

      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({ agentId: "main" });
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId"),
        ),
      ).toBeNull();
    });
  });

  it("renders only the terminal with a tab-attached close control while native auth connects", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await nativeAuth(page, "native-terminal-token");
      const gateway = await installMockGateway(page, {
        deferredMethods: ["connect"],
        featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
        methodResponses: {
          "terminal.list": { sessions: [] },
          "terminal.open": terminalSession("terminal-e2e"),
        },
        terminalEnabled: true,
      });

      const response = await page.goto(`${suite.server.baseUrl}focus/terminal`);
      expect(response?.status()).toBe(200);
      const connect = await gateway.waitForRequest("connect");

      expect(connect.params).toMatchObject({ auth: { token: "native-terminal-token" } });
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      expect(await page.locator("openclaw-terminal-panel").count()).toBe(1);

      await gateway.resolveDeferred("connect");
      const terminalOpen = await gateway.waitForRequest("terminal.open");
      expect(terminalOpen.params).toMatchObject({
        cols: expect.any(Number),
        rows: expect.any(Number),
      });
      const closeControlMetrics = await page
        .locator("openclaw-terminal-panel")
        .locator(".tabstrip-tab__close")
        .evaluate((close) => {
          const header = close.closest<HTMLElement>(".tp-header");
          const tab = close.previousElementSibling;
          if (!header) {
            throw new Error("Terminal close control must stay inside the tab header");
          }
          if (!(tab instanceof HTMLElement) || !tab.matches('[role="tab"]')) {
            throw new Error("Terminal close control must follow a rendered tab surface");
          }
          const headerBounds = header.getBoundingClientRect();
          const closeBounds = close.getBoundingClientRect();
          const tabBounds = tab.getBoundingClientRect();
          const closeStyle = getComputedStyle(close);
          const tabStyle = getComputedStyle(tab);
          return {
            backgroundColor: tabStyle.backgroundColor,
            borderBottomWidth: tabStyle.borderBottomWidth,
            borderRadius: tabStyle.borderRadius,
            closeBorderBottomWidth: closeStyle.borderBottomWidth,
            centerOffset: Math.abs(
              closeBounds.top +
                closeBounds.height / 2 -
                (headerBounds.top + headerBounds.height / 2),
            ),
            closeInset: tabBounds.right - closeBounds.right,
            height: closeBounds.height,
            tabHeight: tabBounds.height,
            width: closeBounds.width,
          };
        });
      expect(closeControlMetrics.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(closeControlMetrics.borderBottomWidth).toBe("0px");
      expect(closeControlMetrics.borderRadius).not.toBe("0px");
      expect(closeControlMetrics.closeBorderBottomWidth).toBe("0px");
      expect(closeControlMetrics.closeInset).toBeGreaterThanOrEqual(-0.5);
      expect(closeControlMetrics.tabHeight).toBe(28);
      expect(closeControlMetrics.width).toBe(28);
      expect(closeControlMetrics.height).toBe(28);
      expect(closeControlMetrics.centerOffset).toBeLessThanOrEqual(0.5);
      const closeControl = page.locator("openclaw-terminal-panel").locator(".tabstrip-tab__close");
      expect(await closeControl.getAttribute("aria-label")).toBe("Close terminal session: bash");
      await closeControl.click();
      const terminalClose = await gateway.waitForRequest("terminal.close");
      expect(terminalClose.params).toEqual({ sessionId: "terminal-e2e" });
    });
  });
});
