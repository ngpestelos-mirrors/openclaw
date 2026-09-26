import { expect as expectBrowser } from "playwright/test";
import { assert, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session conversation return link" });

suite.define(() => {
  it("opens each session's channel directly and removes the link for a web-only session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page, context }) => {
      const sessions = [
        {
          key: "agent:main:discord-link",
          conversationLink: {
            label: "Discord Thread",
            url: "https://discord.com/channels/123456789012345678/234567890123456789",
          },
        },
        {
          key: "agent:main:slack-link",
          conversationLink: {
            label: "Slack Thread",
            url: "https://example.slack.com/archives/C123/p1234567890123456?thread_ts=1234567890.123456&cid=C123",
          },
        },
        { key: "agent:main:web-only", conversationLink: undefined },
      ].map((session) => Object.assign(session, { kind: "direct", agentId: "main", updatedAt: 1 }));
      const [firstSession] = sessions;
      assert(firstSession);
      await installMockGateway(page, {
        sessionKey: firstSession.key,
        historyMessages: [],
        methodResponses: {
          "sessions.list": { ts: 1, count: sessions.length, defaults: {}, sessions },
          "sessions.describe": {
            cases: sessions.map((session) => ({
              match: { key: session.key },
              response: { session },
            })),
          },
        },
      });
      // Capture navigation at the external boundary without contacting real workspaces.
      await context.route(/^https:\/\/(discord\.com|example\.slack\.com)\//, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<title>Conversation destination</title>",
        }),
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSession.key));
      await expectBrowser(page.locator(".session-conversation-link")).toBeVisible();
      for (const session of sessions) {
        await navigateToControlUiSession(page, session.key);
        const link = page.locator(".chat-pane-cache__pane--visible .session-conversation-link");
        if (!session.conversationLink) {
          await expectBrowser(link).toHaveCount(0);
          continue;
        }
        await expectBrowser(link).toHaveAccessibleName(`${session.conversationLink.label} ↗`);
        await expectBrowser(link).toHaveAttribute("href", session.conversationLink.url);
        const opened = page.waitForEvent("popup");
        await link.click();
        const destination = await opened;
        await expectBrowser(destination).toHaveURL(session.conversationLink.url);
        await destination.close();
      }
    });
  });
});
