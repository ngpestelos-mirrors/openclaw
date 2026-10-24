import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { SessionsUsageResult } from "../api/types.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage proxy reconnect lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

// Mirrors the module-private default usage TTL asserted by this flow.
const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

const messages = { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 };

const totals = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  totalCost: 0.01,
  inputCost: 0.008,
  outputCost: 0.002,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function sessionsUsage(
  cacheStatus?: SessionsUsageResult["cacheStatus"],
  label = "Proxy proof",
  usageTotals = totals,
) {
  const date = today();
  const day = { date, tokens: usageTotals.totalTokens, cost: usageTotals.totalCost };
  return {
    updatedAt: Date.now(),
    startDate: date,
    endDate: date,
    sessions: [
      {
        key: "agent:main:proxy-proof",
        label,
        agentId: "main",
        modelProvider: "openai",
        model: "gpt-5.5",
        updatedAt: Date.now(),
        usage: {
          ...usageTotals,
          activityDates: [date],
          dailyBreakdown: [{ ...usageTotals, ...day }],
          messageCounts: messages,
        },
      },
    ],
    totals: usageTotals,
    aggregates: {
      messages,
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [{ agentId: "main", totals: usageTotals }],
      byChannel: [],
      costDaily: [{ date, ...usageTotals }],
      daily: [{ ...day, messages: 2, toolCalls: 0, errors: 0 }],
    },
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

const withPage = (run: (fixture: { page: Page }) => Promise<void>) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
    run,
  );
const refreshButton = (page: Page) =>
  page.locator("openclaw-usage-page").getByRole("button", { name: "Refresh", exact: true });

function installUsage(page: Page, usage: unknown, responses: Record<string, unknown> = {}) {
  return installMockGateway(page, {
    methodResponses: {
      "sessions.usage": usage,
      "usage.status": { updatedAt: Date.now(), providers: [] },
      ...responses,
    },
  });
}

async function setVisibility(page: Page, visible: boolean, advanceMs = 0) {
  await page.evaluate(
    ({ visible: isVisible, advanceMs: clockOffset }) => {
      if (clockOffset) {
        const staleNow = Date.now() + clockOffset;
        Date.now = () => staleNow;
      }
      Object.defineProperties(document, {
        visibilityState: { configurable: true, get: () => (isVisible ? "visible" : "hidden") },
        hasFocus: { configurable: true, value: () => isVisible },
      });
      document.dispatchEvent(new Event("visibilitychange"));
      if (isVisible) {
        window.dispatchEvent(new Event("focus"));
      }
    },
    { visible, advanceMs },
  );
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect.poll(() => requestCount(gateway, method), { timeout: 10_000 }).toBe(count);
}

async function proxyReconnect(
  page: Page,
  gateway: MockGatewayControls,
  expectedSocketCount: number,
): Promise<void> {
  await gateway.closeLatest(1001, "proxy idle timeout");
  await expect.poll(() => gateway.getSocketCount(), { timeout: 10_000 }).toBe(expectedSocketCount);
  await waitForControlUiGatewayReady(page);
  await page.locator(".sidebar-shell__footer .gateway-status").waitFor({ state: "detached" });
}

async function usageBadges(page: Page): Promise<string[]> {
  return (await page.locator(".usage-metric-badge").allTextContents()).map((value) =>
    value.replace(/\s+/gu, " ").trim(),
  );
}

suite.define(() => {
  it("avoids a reload storm but retries Usage work interrupted by a proxy drop", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installUsage(page, sessionsUsage());

      expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar.locator('.sidebar-identity-menu [data-value="command:usage"]').click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => usageBadges(page))
        .toEqual(["120 Tokens", "$0.01 Cost", "1 Sessions"]);

      for (const socketCount of [2, 3, 4]) {
        await proxyReconnect(page, gateway, socketCount);
        expect(await requestCount(gateway, "sessions.usage")).toBe(1);
      }

      await setVisibility(page, false, USAGE_PAYLOAD_TTL_MS);
      await proxyReconnect(page, gateway, 5);
      expect(await requestCount(gateway, "sessions.usage")).toBe(1);

      await setVisibility(page, true);
      await waitForRequestCount(gateway, "sessions.usage", 2);

      await gateway.deferNext("sessions.usage");
      await refreshButton(page).click();
      await waitForRequestCount(gateway, "sessions.usage", 3);

      await proxyReconnect(page, gateway, 6);
      await waitForRequestCount(gateway, "sessions.usage", 4);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect
        .poll(() => usageBadges(page))
        .toEqual(["120 Tokens", "$0.01 Cost", "1 Sessions"]);
    });
  });
});
