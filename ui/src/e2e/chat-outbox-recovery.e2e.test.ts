import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser, type Page } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  chatMessage,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { seedLegacyComposerDraft } from "./chat-outbox-legacy-draft.test-support.ts";
import { outboxButton as button } from "./chat-outbox-payloads.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = { locale: "en-US", serviceWorkers: "block" as const };
const viewport = { width: 1280, height: 900 };
const composerFor = (page: Page) => page.locator(".agent-chat__composer-combobox textarea");
const userFor = (page: Page, text: string, exact = false) =>
  page.locator(".chat-group.user").getByText(text, { exact });
const pendingInput = (
  id: string,
  sessionKey: string,
  sendRunId: string,
  extra: Record<string, unknown>,
) => ({
  id,
  sessionKey,
  sendRunId,
  text: "Please check the deployment notes",
  createdAt: 1,
  sendAttempts: 1,
  sendState: "waiting-reconnect",
  ...extra,
});
async function seedComposer(
  page: Page,
  version: number,
  data: Record<string, unknown>,
  options: { marker?: string; account?: boolean } = {},
) {
  const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
  await page.addInitScript(
    ({ gatewayUrl: owner, version: format, data: state, marker, account }) => {
      if (marker && sessionStorage.getItem(marker)) {
        return;
      }
      if (marker) {
        sessionStorage.setItem(marker, "yes");
      }
      const key = `openclaw.control.chatComposer.v${format}:${encodeURIComponent(owner)}${account ? ":account:e2e-recovery-scope" : ""}`;
      sessionStorage.setItem(
        key,
        JSON.stringify({ version: format, gatewayOwner: owner, ...state }),
      );
    },
    { gatewayUrl, version, data, ...options },
  );
}

suite.define(() => {
  it(
    "keeps delivery recovery visible and keyboard-reachable in narrow chat",
    () =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 320, height: 844 } },
        async ({ page }) => {
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          await installMockGateway(page, {
            historyMessages: ["failed", "waiting-reconnect", "held"].flatMap((state, index) => [
              chatMessage("user", "Pending " + state, {
                timestamp: 1_000 + index * 2,
                __openclaw: {
                  id: "delivery-" + index,
                  kind: "pending-send",
                  state,
                  ...(index === 1
                    ? {
                        senderId: "peer",
                        senderName: "Peer",
                        senderIdentity: { type: "profile", id: "peer" },
                      }
                    : {}),
                },
              }),
              chatMessage("assistant", "Separate turn", {
                timestamp: 1_001 + index * 2,
              }),
            ]),
          });
          await page.goto(suite.server.baseUrl + "chat");
          const statuses = page.locator(".chat-send-status");
          await expectBrowser(statuses).toHaveCount(3, { timeout: 30_000 });
          const held = page.locator('.chat-send-status[data-send-state="held"]');
          await expectBrowser(held).toContainText("Needs review");
          await expectBrowser(button(held, "Discard")).toBeVisible();
          // Enlarged text must not push recovery controls outside the conversation.
          await page.addStyleTag({ content: ".chat-send-status { font-size: 24px; }" });
          for (const theme of ["light", "dark"]) {
            await page.evaluate((mode) => {
              document.documentElement.dataset.themeMode = mode;
            }, theme);
            for (const status of await statuses.all()) {
              await status.scrollIntoViewIfNeeded();
              await page.mouse.move(0, 0);
              const footer = status.locator(
                "xpath=ancestor::div[contains(@class, 'chat-group-footer--send-status')]",
              );
              await expectBrowser(footer).toHaveCSS("opacity", "1");
              for (const action of await status.getByRole("button").all()) {
                await expectBrowser(action).toBeVisible();
                await expectBrowser(action).toBeEnabled();
                const bounds = await action.boundingBox();
                if (!bounds) {
                  throw new Error("Recovery action has no rendered bounds");
                }
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
              }
            }
            const failed = page.locator('.chat-send-status[data-send-state="failed"]');
            const retry = failed.getByRole("button", { name: "Retry queued message" });
            await retry.focus();
            await page.keyboard.press("Tab");
            await expectBrowser(button(failed, "Discard")).toBeFocused();
            await page.keyboard.press("Shift+Tab");
            await expectBrowser(retry).toBeFocused();
            await retry.evaluate((element) => (element as HTMLElement).blur());
          }
        },
      ),
    60_000,
  );

  it("retires a delivered recovery row when its exact submission loads in history", () =>
    suite.withPage(pageOptions, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
      await seedComposer(
        page,
        4,
        {
          sessions: {},
          recovery: {
            delivered: {
              sourceVersion: 4,
              sourceScopeKey: `${sessionKey}\u0000agent:main`,
              session: {
                updatedAt: 1790955600000,
                queue: [
                  pendingInput("delivered-input", sessionKey, "delivered-attempt", {
                    sessionId: `session:${sessionKey}`,
                  }),
                ],
              },
            },
          },
        },
        { account: true },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const row = page.locator(".chat-outbox-recovery-row");
      await row.getByText("Please check the deployment notes", { exact: true }).waitFor();
      await gateway.setHistoryMessages([
        {
          role: "user",
          content: "Please check the deployment notes",
          __openclaw: { id: "delivered-message", seq: 1, idempotencyKey: "delivered-attempt:user" },
        },
      ]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        messageId: "delivered-message",
        messageSeq: 1,
        hasActiveRun: false,
        status: "done",
      });
      await userFor(page, "Please check the deployment notes", true).waitFor();
      await row.waitFor({ state: "detached" });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(
        await page.evaluate(
          (gatewayUrl) =>
            JSON.parse(
              sessionStorage.getItem(
                `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}:account:e2e-recovery-scope`,
              ) ?? '{"recovery":{}}',
            ).recovery,
          controlUiBundledGatewayUrl(suite.server.baseUrl),
        ),
      ).toEqual({});
    }));

  it.each(["duplicate", "rejection", "discard"] as const)(
    "reconciles an ACK-lost send on reconnect (%s)",
    (outcome) =>
      suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
        const artifactDir = captureUiProofEnabled
          ? createControlUiE2eArtifactDir(`chat-send-reconcile-${outcome}`)
          : undefined;
        const gateway = await installMockGateway(page, {
          heldMethods: ["chat.send"],
          methodResponses: {
            "chat.history": {
              messages: [],
              sessionId: "session:agent:main:main",
              sessionInfo: { hasActiveRun: false, status: "done" },
              thinkingLevel: null,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const prompt = "Reconcile this exact submission";
        await composerFor(page).fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const first = await gateway.waitForRequest("chat.send");
        const firstParams = requireRecord(first.params);
        const runId = requireString(firstParams.idempotencyKey, "original idempotency key");
        await gateway.setOnline(false);
        const pending = page.locator('.chat-send-status[data-send-state="waiting-reconnect"]');
        await pending.getByText("Waiting for reconnect", { exact: true }).waitFor();
        await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
        await expectBrowser(pending.getByRole("button", { name: /Retry/ })).toHaveCount(0);
        await button(pending, "Discard").waitFor();
        if (artifactDir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-chat-pane"),
            [
              userFor(page, prompt, true),
              pending.getByText("Waiting for reconnect", { exact: true }),
            ],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifactDir, "after-waiting-for-reconnect.png"), frame.png);
        }

        if (outcome === "discard") {
          await button(pending, "Discard").click();
          await userFor(page, prompt, true).waitFor({ state: "detached" });
          await composerFor(page).fill("The next queued message");
          await page.getByRole("button", { name: "Send message" }).click();
        }
        await gateway.setOnline(true);
        const sends = await waitForRequests(gateway, "chat.send", 2);
        const nextParams = requireRecord(sends[1]?.params);
        expect(nextParams.sessionKey).toBe(firstParams.sessionKey);
        let requestCount = 2;
        let acceptedRunId = runId;
        if (outcome === "discard") {
          expect(nextParams.message).toBe("The next queued message");
          expect(nextParams.idempotencyKey).not.toBe(runId);
          acceptedRunId = requireString(nextParams.idempotencyKey, "next submission key");
          expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
        } else {
          expect(nextParams).toEqual({ ...firstParams, __controlUiReconnectResume: true });
          if (artifactDir && outcome === "duplicate") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-chat-pane"),
              [userFor(page, prompt, true), page.locator(".chat-send-status")],
              { animations: "disabled" },
            );
            await writeFile(path.join(artifactDir, "after-replaying-original-key.png"), frame.png);
          }
          if (outcome === "rejection") {
            await gateway.rejectDeferred("chat.send", {
              code: "INVALID_REQUEST",
              message: "Synthetic admission rejection",
            });
            const failed = page.locator('.chat-send-status[data-send-state="failed"]');
            await failed.getByText("Not sent", { exact: true }).waitFor();
            if (artifactDir) {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator("openclaw-chat-pane"),
                [
                  failed.getByText("Not sent", { exact: true }),
                  failed.getByRole("button", { name: "Retry queued message" }),
                ],
                { animations: "disabled" },
              );
              await writeFile(path.join(artifactDir, "after-rejection.png"), frame.png);
            }
            await gateway.deferNext("chat.send");
            await failed.getByRole("button", { name: "Retry queued message" }).click();
            const retry = await gateway.waitForRequest("chat.send", { after: 2 });
            const retryParams = requireRecord(retry.params);
            expect(retryParams).toEqual({
              ...nextParams,
              idempotencyKey: expect.any(String),
            });
            acceptedRunId = requireString(retryParams.idempotencyKey, "retry submission key");
            expect(acceptedRunId).not.toBe(runId);
            requestCount = 3;
          }
        }
        await gateway.resolveDeferred("chat.send", { runId: acceptedRunId, status: "ok" });
        await page.locator(".chat-send-status").waitFor({ state: "detached" });
        await expectRequestCountStable(gateway, "chat.send", requestCount);
        expect(
          (await gateway.getRequests("chat.history")).some(
            (request) => requireRecord(request.params).limit === 1000,
          ),
        ).toBe(false);
      }),
  );

  it("keeps a recovered legacy send unsent until destination confirmation and explicit Retry", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await seedComposer(
        page,
        2,
        {
          sessions: {
            "global\u0000agent:main": {
              updatedAt: 1790955600000,
              queue: [pendingInput("old-followup", "global", "old-attempt", { agentId: "main" })],
            },
          },
        },
        { marker: "outbox-recovery-seeded" },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.locator(".agent-chat__composer-shell .chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Please check the deployment notes")
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await button(notice, "Restore").click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByText(/Add this saved copy to “Main/).waitFor();
      await dialog.getByText(/Nothing will be sent/).waitFor();
      await button(dialog, "Restore").click();
      const restored = page.locator(".chat-queue__item", {
        hasText: "Please check the deployment notes",
      });
      await restored.getByText("Failed", { exact: true }).waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await page.reload();
      await restored.getByText("Failed", { exact: true }).waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await restored.getByRole("button", { name: /Retry/i }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(requireRecord(request.params)).toMatchObject({
        sessionKey,
        message: "Please check the deployment notes",
      });
      expect(requireRecord(request.params).idempotencyKey).not.toBe("old-attempt");
      expect(
        (await gateway.getRequests("chat.history")).every(
          (historyRequest) => requireRecord(historyRequest.params).sessionKey === sessionKey,
        ),
      ).toBe(true);
    }));
  it.each(["agent:main:main", "global", "agent:work:workspace"])(
    "keeps exact history and send targets for %s across offline reload and agent navigation",
    (sessionKey) =>
      suite.withPage(pageOptions, async ({ page }) => {
        const otherKey = "agent:other:thread";
        const mainKey = sessionKey.endsWith(":workspace") ? "workspace" : "main";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionScope: sessionKey === "global" ? "global" : "per-sender",
          mainSessionKey: sessionKey === "global" ? "global" : `agent:main:${mainKey}`,
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey,
              scope: sessionKey === "global" ? "global" : "per-sender",
              agents: ["main", "other", "work"].map((id) => ({
                id,
                name: id,
                model: { primary: "openai/gpt-5.5" },
              })),
            },
          },
          sessions: [sessionKey, otherKey].map((key) => ({
            key,
            kind: key === "global" ? "global" : "direct",
            label: key,
            updatedAt: 1,
            hasActiveRun: false,
            activeRunIds: [],
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = composerFor(page);
        await composer.waitFor();
        await gateway.setOnline(false);
        await page.locator(".agent-chat__input--offline").waitFor();
        await composer.fill(`retain destination ${sessionKey}`);
        await page.getByRole("button", { name: "Send message" }).click();
        await page.locator(".chat-queue").getByText("Waiting for reconnect").waitFor();
        expect(await userFor(page, `retain destination ${sessionKey}`).count()).toBe(0);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        await gateway.setOnline(true);
        await composerFor(page).waitFor();
        const request = await gateway.waitForRequest("chat.send");
        expect(requireRecord(request.params)).toMatchObject({
          sessionKey,
          message: `retain destination ${sessionKey}`,
          ...(sessionKey === "global" ? { agentId: "main" } : {}),
        });
        const history = (await gateway.getRequests("chat.history"))
          .map((historyRequest) => requireRecord(historyRequest.params))
          .filter((params) => params.limit === 1);
        expect(history.length).toBeGreaterThan(0);
        expect(
          history.every(
            (params) =>
              params.sessionKey === sessionKey &&
              (sessionKey !== "global" || params.agentId === "main"),
          ),
        ).toBe(true);
      }),
  );

  it("recovers an ambiguous IndexedDB attachment draft through rendered controls without sending", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.startup"],
        historyMessages: [chatMessage("assistant", "Existing conversation is ready.")],
      });
      const gatewayAddress = controlUiBundledGatewayUrl(suite.server.baseUrl);
      // Seed the legacy database before app boot can open the current version.
      await page.route("**/outbox-recovery-seed", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock recovery seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-recovery-seed`);
      const seededDatabaseVersion = await seedLegacyComposerDraft(page, {
        gatewayOwner: gatewayAddress,
        scopeKey: "global\u0000agent:main",
        text: "Review the attached deployment note",
        revision: 42,
        writeId: "legacy-attachment",
        attachment: { content: "deployment note", fileName: "legacy-note.txt", sizeBytes: 15 },
      });
      expect(seededDatabaseVersion).toBe(1);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const notice = page.locator(".chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Review the attached deployment note", { exact: true })
        .waitFor();
      await gateway.waitForRequest("chat.startup");
      await gateway.resolveDeferred("chat.startup");
      // Recovery can render before history establishes the destination's identity.
      await page
        .locator(".chat-group.assistant")
        .getByText("Existing conversation is ready.", { exact: true })
        .waitFor();
      await button(notice, "Restore").click();
      await button(page.locator("openclaw-modal-dialog"), "Restore").click();
      const composer = composerFor(page);
      const attachment = page
        .locator(".chat-attachments-preview .chat-attachment-file__name")
        .getByText("legacy-note.txt", { exact: true });
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await attachment.waitFor();
      await page.reload();
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await attachment.waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
    }));

  it("shows only meaningful saved drafts and deletes a reviewed copy without sending", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      const sessions: Record<string, { updatedAt: number; draftRevision: number; draft?: string }> =
        Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `agent:main:old-${index}\u0000agent:main`,
            { updatedAt: 1790955600000, draftRevision: 42 },
          ]),
        );
      sessions["global\u0000agent:main"] = {
        updatedAt: 1790955600000,
        draftRevision: 43,
        draft: "Could you summarize the latest test results?",
      };
      await seedComposer(
        page,
        4,
        { sessions, recovery: {} },
        { marker: "saved-draft-notice-seeded" },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const notice = page.locator(".chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Could you summarize the latest test results?", { exact: true })
        .waitFor();
      expect(await notice.locator(".chat-outbox-recovery-row").count()).toBe(1);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === "dark");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await notice.getByText("Draft", { exact: true }).waitFor();
      expect(await notice.getByText("Unsent", { exact: true }).count()).toBe(0);
      await button(notice, "Delete").click();
      const dialog = page.locator("openclaw-modal-dialog");
      await button(dialog, "Cancel").click();
      expect(await notice.locator(".chat-outbox-recovery-row").count()).toBe(1);
      await button(notice, "Delete").click();
      await button(dialog, "Delete").click();
      await notice.waitFor({ state: "detached" });
      await page.reload();
      await composerFor(page).waitFor();
      expect(await notice.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    }));
});
