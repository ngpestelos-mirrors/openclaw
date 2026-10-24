import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Snapshot route admission" });
const id = "b1c2cd3c-1234-4321-9876-123456789abc";
const sessionKey = `agent:main:chat:${id}`;
const transcript = "The cached conversation is ready before route resolution.";
const row = createControlUiSessionRow(sessionKey, "Snapshot conversation", 1);

async function openCachedRoute(page: Page) {
  const gateway = await installMockGateway(page, {
    sessionKey,
    authMethod: "trusted-proxy",
    authMode: "trusted-proxy",
    sessions: [],
    heldMethods: ["sessions.resolve", "chat.startup", "chat.send"],
    historyMessages: [{ role: "assistant", content: transcript }],
    methodResponses: {
      "sessions.describe": { session: row },
      "sessions.resolve": { ok: true, ...row },
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await gateway.waitForRequest("chat.startup");
  await gateway.resolveDeferred("chat.startup");
  await page.getByText(transcript, { exact: true }).waitFor();
  await page.waitForFunction(() =>
    Object.keys(localStorage).some((key) => key.startsWith("openclaw.control.bootRecord.v1:")),
  );
  await page.evaluate(async () => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    await Reflect.get(pane!, "sessionSnapshotStore").flush();
  });
  return gateway;
}

suite.define(() => {
  it("keeps live metadata actions available while only message delivery waits for confirmation", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        await gateway.waitForRequest("chat.startup");
        await gateway.resolveDeferred("chat.startup", {
          messages: [{ role: "assistant", content: transcript }],
          sessionInfo: { ...row, unread: true, sharingRole: "owner" },
        });
        const pane = page.locator(".chat-pane-cache__pane--active");
        await pane
          .getByText("Snapshot conversation", { exact: true })
          .filter({ visible: true })
          .first()
          .waitFor();
        await pane.locator(".chat-header-session-menu__trigger").click();
        const rename = page.getByRole("menuitem", { name: "Rename…", exact: true });
        expect(await rename.isEnabled()).toBe(true);
        await rename.click();
        const name = pane.locator(".chat-pane__session-title-input");
        await name.fill("Renamed from live metadata");
        await name.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toMatchObject({
          key: sessionKey,
          expectedSessionId: row.sessionId,
          label: "Renamed from live metadata",
        });
        expect(await pane.locator(".chat-send-btn--send").isDisabled()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.resolve", { ok: true, ...row });
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        await pane.locator(".chat-header-session-menu__trigger").click();
        expect(await rename.isEnabled()).toBe(true);
      },
    );
  });

  it("rejects stale route confirmation across reconnect while cached rows are admitted", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await openCachedRoute(page);
        await page.goto(new URL(`/chat/main/${id}`, suite.server.baseUrl).href);
        await page.getByText(transcript, { exact: true }).waitFor();
        await gateway.waitForRequest("sessions.resolve");
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.fill("Keep this draft across route admission reconnect");
        const connects = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(4000, "synthetic reconnect during route confirmation");
        await gateway.waitForRequest("connect", { after: connects });
        await gateway.resolveDeferred("sessions.resolve", {
          ok: true,
          ...row,
          key: `agent:other:chat:${id}`,
          agentId: "other",
        });
        expect(new URL(page.url()).pathname).toBe(`/chat/main/${id}`);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.setMethodResponse("sessions.resolve", { ok: true, ...row });
        await gateway.deferNext("sessions.resolve");
        await gateway.resolveDeferred("connect");
        await gateway.waitForRequest("sessions.resolve", { after: 1 });
        await composer.waitFor({ state: "hidden" });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await gateway.resolveDeferred("sessions.resolve", { ok: true, ...row });
        await gateway.resolveDeferred("chat.startup");
        await page.getByText(transcript, { exact: true }).waitFor();
        await page.waitForFunction(() => window.openclawControlUi?.snapshot().routeReady === true);
        expect(new URL(page.url()).pathname).toMatch(/^\/chat\/main\//);
        expect((await composer.inputValue()).trimEnd()).toBe(
          "Keep this draft across route admission reconnect",
        );
        await composer.press("Enter");
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey,
          message: "Keep this draft across route admission reconnect",
        });
      },
    );
  });
});
