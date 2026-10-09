import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it.each([false, true])(
    "keeps provider-authoritative recommendations folded and searchable (empty=%s)",
    async (empty) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const models = [
          {
            provider: "nvidia",
            id: "nvidia/nemotron-3-ultra-550b-a55b",
            name: "Nemotron 3 Ultra",
            recommended: !empty,
          },
          {
            provider: "nvidia",
            id: "vendor/new-featured-chat",
            name: "New NVIDIA featured chat",
            recommended: !empty,
          },
          {
            provider: "nvidia",
            id: "nvidia/nemotron-3.5-lightning-30b-a3b",
            name: "Nemotron 3.5 Lightning",
            recommended: false,
          },
          { provider: "other", id: "central", name: "Central recommendation", recommended: true },
          { provider: "other", id: "rest", name: "Other available model" },
        ];
        await installMockGateway(page, {
          agentModel: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
          models,
          sessions: [
            {
              key: "agent:main:main",
              modelProvider: "nvidia",
              model: "nvidia/nemotron-3-ultra-550b-a55b",
              modelOverride: "nvidia/nemotron-3-ultra-550b-a55b",
              providerOverride: "nvidia",
            },
          ],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
        await picker
          .locator('[data-chat-model-option="nvidia/vendor/new-featured-chat"]')
          .waitFor({ state: "attached" });
        await picker.locator("[data-chat-model-select]").click();
        const nvidiaGroup = picker.locator('[data-chat-model-provider-group="nvidia"]');
        const novel = picker.locator('[data-chat-model-option="nvidia/vendor/new-featured-chat"]');
        const lightning = picker.locator(
          '[data-chat-model-option$="nemotron-3.5-lightning-30b-a3b"]',
        );
        const nvidiaToggle = nvidiaGroup.locator("[data-chat-model-provider-toggle]");
        if ((await nvidiaToggle.getAttribute("aria-expanded")) !== "true") {
          await nvidiaToggle.click();
        }
        await expect
          .poll(() => nvidiaGroup.locator("[data-chat-model-more-toggle]").isVisible())
          .toBe(true);
        expect(await novel.isVisible()).toBe(!empty);
        expect(await lightning.isVisible()).toBe(false);
        // Inherited Default remains visible even when the provider recommends none.
        expect(
          await nvidiaGroup
            .locator('[data-chat-model-option$="nemotron-3-ultra-550b-a55b"]')
            .isVisible(),
        ).toBe(true);
        const other = picker.locator('[data-chat-model-provider-group="other"]');
        await other.locator("[data-chat-model-provider-toggle]").click();
        expect(await other.locator('[data-chat-model-option="other/central"]').isVisible()).toBe(
          true,
        );
        expect(await other.locator('[data-chat-model-option="other/rest"]').isVisible()).toBe(
          false,
        );
        if (captureUiProofEnabled) {
          const frame = await takeControlUiScreenshotFrame(page, picker, [nvidiaGroup, other], {
            elements: [picker],
            animations: "disabled",
          });
          await writeFile(
            path.join(
              suite.artifactDir,
              empty ? "empty-recommendations.png" : "provider-recommendations.png",
            ),
            frame.png,
          );
        }
        const search = picker.locator("[data-chat-model-search]");
        await search.fill("Lightning");
        await expect.poll(() => lightning.isVisible()).toBe(true);
        await lightning.click();
        // A pinned nonrecommended selection stays above the fold on reopen.
        await picker.locator("[data-chat-model-select]").click();
        await expect.poll(() => lightning.isVisible()).toBe(true);
        expect(await lightning.getAttribute("aria-selected")).toBe("true");
      });
    },
  );
});
