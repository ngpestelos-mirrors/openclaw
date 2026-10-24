import { expect, it } from "vitest";
import { installMockGateway } from "./chat-flow.test-support.ts";
import {
  polledAttribute,
  polledCount,
  polledText,
  polledVisible,
} from "./chat-presentation.test-support.ts";
import { modelAuthStatus, modelPicker } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const compositionScenario = {
  agentModel: "openai/gpt-5.5",
  models: [
    { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  ],
};
const suite = createControlUiE2eSuite({
  name: "Control UI mocked Gateway E2E",
});
const accountLabel = "Sign in with ChatGPT";
const catalog = (
  models: { id: string; name: string; provider: string }[],
  authProfileId: string,
) => ({
  models,
  accountSelection: { kind: "shared", authProfileId, label: accountLabel },
});
const authStatus = (profileId: string, email: string) =>
  modelAuthStatus([{ profileId, type: "oauth", status: "ok", displayName: accountLabel, email }]);

suite.define(() => {
  it("refreshes the mounted composer's account identity after an auth publication", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = [{ id: "shared-alpha", name: "Shared Alpha", provider: "openai" }];
      const inventory = (authProfileId: string, label: string) => ({
        profileId: "test-person",
        accounts: [
          { authProfileId, label, provider: "openai", authType: "oauth", selected: false },
        ],
        links: [],
      });
      const gateway = await installMockGateway(page, {
        agentModel: "openai/shared-alpha",
        models,
        methodResponses: {
          "models.list": catalog(models, "openai:previous"),
          "models.authStatus": authStatus("openai:previous", "previous@example.test"),
          "users.listModelAccounts": inventory("openai:old-alternate", "Old alternate"),
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const { picker, trigger, search } = modelPicker(page);
      await trigger.click();
      await polledCount(picker.locator("[data-chat-model-provider-toggle]")).toBe(1);
      const account = picker.locator(".chat-controls__account-selection");
      await polledText(account).toContain("previous@example.test");
      const accountToggle = picker.locator("[data-chat-account-group-toggle]");
      await accountToggle.click();
      const oldAlternate = picker.locator(
        '[data-chat-account-option="account:openai:old-alternate"]',
      );
      await polledVisible(oldAlternate).toBe(true);

      await gateway.setMethodResponse("models.list", catalog(models, "openai:replacement"));
      await gateway.setMethodResponse(
        "models.authStatus",
        authStatus("openai:replacement", "replacement@example.test"),
      );
      await gateway.setMethodResponse(
        "users.listModelAccounts",
        inventory("openai:new-alternate", "New alternate"),
      );
      const catalogReads = (await gateway.getRequests("models.list")).length;
      await gateway.emitGatewayEvent("chat.metadata.changed", {
        authChanged: true,
        modelCatalogChanged: true,
      });
      await gateway.waitForRequest("models.list", { after: catalogReads });
      await polledText(account).toContain("replacement@example.test");
      expect(await account.textContent()).not.toContain("previous@example.test");
      expect(await picker.getAttribute("open")).not.toBeNull();
      await accountToggle.click();
      const newAlternate = picker.locator(
        '[data-chat-account-option="account:openai:new-alternate"]',
      );
      await polledVisible(newAlternate).toBe(true);
      await search.fill("Old alternate");
      await polledVisible(picker.locator("[data-chat-model-search-empty]")).toBe(true);
      expect(await oldAlternate.count()).toBe(0);
      await search.fill("New alternate");
      await polledVisible(newAlternate).toBe(true);
    });
  });

  it.each([
    { width: 1280, height: 900, minimumTarget: 32 },
    { width: 390, height: 844, minimumTarget: 44 },
  ])(
    "keeps provider auth metadata outside the $width px disclosure hit target",
    async ({ width, height, minimumTarget }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const models = [
          { id: "shared-alpha", name: "Shared Alpha", provider: "openai" },
          { id: "shared-beta", name: "Shared Beta", provider: "anthropic" },
        ];
        await installMockGateway(page, {
          agentModel: "openai/shared-alpha",
          models,
          methodResponses: {
            "models.list": catalog(models, "openai:siwc"),
            "models.authStatus": authStatus("openai:siwc", "long-account-name+siwc@example.test"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const { picker, trigger } = modelPicker(page);
        await page.locator(".agent-chat__composer-combobox textarea").click();
        await trigger.click();
        await polledCount(picker.locator("[data-chat-model-provider-toggle]")).toBe(2);
        const openai = picker.locator(
          '[data-chat-model-provider-group="openai"] [data-chat-model-provider-toggle]',
        );
        const auth = picker.locator(
          '[data-chat-model-provider="openai"] .chat-controls__auth-meta',
        );
        await polledText(auth).toContain("long-account-name+siwc@example.test");
        await auth.waitFor({ state: "visible" });
        const toggleContentsRight = await openai.evaluate((button) =>
          Math.max(...Array.from(button.children, (child) => child.getBoundingClientRect().right)),
        );
        expect(toggleContentsRight).toBeLessThanOrEqual((await auth.boundingBox())!.x);
        await openai.click({ trial: true });
        await expect
          .poll(() => openai.evaluate((button) => button.getBoundingClientRect().height))
          .toBeGreaterThanOrEqual(minimumTarget);
      });
    },
  );

  for (const composition of ["active", "keyCode229"] as const) {
    it.for(["Enter", "Escape"])(
      `respects ${composition} composition ownership for model-search %s`,
      async (key) => {
        await suite.withPage({}, async ({ page }) => {
          const gateway = await installMockGateway(page, compositionScenario);
          await page.goto(`${suite.server.baseUrl}chat`);
          const { picker, trigger, search } = modelPicker(page);
          await polledAttribute(trigger, "aria-disabled").toBe("false");
          await trigger.click();
          await polledCount(picker.locator("[data-chat-model-option]")).toBe(1);
          await page.mouse.move(0, 0);
          const query = "anthropic";
          await search.fill(query);
          await polledCount(picker.locator("[data-chat-model-option]")).toBe(1);
          await search.focus();
          // This exercises browser event ownership, not a native OS IME candidate window.
          const { prevented, highlightedBefore } = await search.evaluate(
            (input, args) => {
              const previousHighlight = input.getAttribute("aria-activedescendant");
              const event = new KeyboardEvent("keydown", {
                key: args.key,
                isComposing: args.composition === "active",
                keyCode: args.composition === "keyCode229" ? 229 : 0,
                bubbles: true,
                cancelable: true,
                composed: true,
              });
              input.dispatchEvent(event);
              return {
                prevented: event.defaultPrevented,
                highlightedBefore: previousHighlight,
              };
            },
            { key, composition },
          );

          expect(highlightedBefore).toBeTruthy();

          expect.soft(prevented).toBe(false);
          expect.soft(await picker.getAttribute("open")).not.toBeNull();
          expect.soft(await search.inputValue()).toBe(query);
          expect.soft(await search.getAttribute("aria-activedescendant")).toBe(highlightedBefore);
          expect.soft(await gateway.getRequests("sessions.patch")).toEqual([]);
        });
      },
    );
  }
});
