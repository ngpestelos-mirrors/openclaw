import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI tool summary keyboard focus",
  startServerBeforeBrowser: true,
});

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 100; index += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((element) => element === document.activeElement)) {
      expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      return;
    }
  }
  throw new Error("Tool summary was not reachable with Tab");
}

async function expectTopRing(page: Page, summary: Locator, screenshotPath: string) {
  expect(await summary.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  const geometry = await summary.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const row = button.closest(".chat-virtual-row");
    if (!row) {
      throw new Error("Expected the production virtual transcript row");
    }
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineOffset: Number.parseFloat(style.outlineOffset),
      outlineStyle: style.outlineStyle,
      color: style.outlineColor
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number),
      rowTop: row.getBoundingClientRect().top,
      contentVisibility: getComputedStyle(row).contentVisibility,
    };
  });
  expect(geometry.outlineStyle).toBe("solid");
  expect(geometry.outlineWidth).toBeGreaterThanOrEqual(2);
  const png = await page.screenshot({ path: screenshotPath });
  const image = photon.PhotonImage.new_from_byteslice(png);
  try {
    const pixels = image.get_raw_pixels();
    // Sample the straight middle of the top outline, not rounded corners or glyphs.
    const top = Math.floor(geometry.y - geometry.outlineOffset - geometry.outlineWidth);
    const bottom = Math.ceil(geometry.y - geometry.outlineOffset);
    let matches = 0;
    const start = Math.ceil(geometry.x + geometry.width * 0.25);
    const end = Math.floor(geometry.x + geometry.width * 0.75);
    for (let x = start; x < end; x += 1) {
      for (let y = top; y < bottom; y += 1) {
        const offset = (y * image.get_width() + x) * 4;
        if (
          geometry.color.every((value, channel) => {
            const actual = pixels[offset + channel];
            return actual !== undefined && Math.abs(actual - value) <= 8;
          })
        ) {
          matches += 1;
          break;
        }
      }
    }
    expect(matches / (end - start), JSON.stringify(geometry)).toBeGreaterThan(0.9);
  } finally {
    image.free();
  }
}

suite.define(() => {
  it.each([
    { width: 390, completed: false },
    { width: 1280, completed: false },
    { width: 390, completed: true },
    { width: 1280, completed: true },
  ])(
    "keeps the top focus ring painted through expand/collapse at $width px (completed: $completed)",
    async ({ width, completed }) => {
      const artifactDir = createControlUiE2eArtifactDir(`tool-focus-${width}-${completed}`);
      await suite.withPage(
        {
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          colorScheme: "dark",
        },
        async ({ page }) => {
          await installMockGateway(page, {
            historyMessages: [
              { role: "user", content: "Run the six checks.", timestamp: 1000 },
              { role: "assistant", content: "The checks are ready to inspect.", timestamp: 2000 },
              ...Array.from({ length: 6 }, (_, index) => [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: `focus-${index}`,
                      name: "exec",
                      arguments: { command: `echo check-${index}` },
                    },
                  ],
                  timestamp: 3000 + index * 2,
                },
                {
                  role: "toolResult",
                  toolCallId: `focus-${index}`,
                  toolName: "exec",
                  content: "Check passed.",
                  timestamp: 3001 + index * 2,
                },
              ]).flat(),
              ...(completed
                ? [{ role: "assistant", content: "All checks completed.", timestamp: 4000 }]
                : []),
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const summary = page.locator(".chat-activity-group__summary").first();
          await summary.waitFor();
          await waitForChatScrollIdle(page);
          await tabTo(page, summary);
          expect(await summary.textContent()).toContain("Ran 6 commands");
          expect(await summary.getAttribute("aria-expanded")).toBe("false");
          await expectTopRing(page, summary, path.join(artifactDir, "collapsed.png"));
          await page.keyboard.press("Enter");
          await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("true");
          await waitForChatScrollIdle(page);
          await expectTopRing(page, summary, path.join(artifactDir, "expanded.png"));
          await page.keyboard.press("Space");
          await expect.poll(() => summary.getAttribute("aria-expanded")).toBe("false");
          await waitForChatScrollIdle(page);
          await expectTopRing(page, summary, path.join(artifactDir, "recollapsed.png"));
        },
      );
    },
  );
});
