import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../ui/src/e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../ui/src/test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { hash, writeGallery, type Capture } from "./report.ts";
import { baseScenario, fixedTime, profiles, scenes } from "./scenarios.ts";

const options: { output?: string; scene?: string; profile?: string; css?: string } = JSON.parse(
  process.env.OPENCLAW_PARITY_OPTIONS ?? "{}",
);
const selectedScenes = scenes.filter(
  (scene) => !options.scene || new RegExp(options.scene, "u").test(scene.id),
);
const selectedProfiles = profiles.filter(
  (profile) => !options.profile || new RegExp(options.profile, "u").test(profile.id),
);
if (!selectedScenes.length || !selectedProfiles.length) {
  throw new Error("Parity selection matches no scenes or profiles");
}
const suite = createControlUiE2eSuite({
  name: "Control UI visual parity",
  startServerBeforeBrowser: true,
});
const captureOrigin = "http://parity.localhost:18789";
let directory: string;
let stylesheet: string | undefined;
let capture: Capture;
suite.define(() => {
  beforeAll(async () => {
    directory = createControlUiE2eArtifactDir("parity", options.output);
    stylesheet = options.css ? await readFile(options.css, "utf8") : undefined;
    const contract = {
      expectedShots: selectedProfiles.flatMap((profile) =>
        selectedScenes.map((scene) => `${scene.id}--${profile.id}`),
      ),
      fixtures: hash(
        JSON.stringify({
          fixedTime,
          profiles: selectedProfiles,
          scenes: selectedScenes.map((scene) => scene.id),
          // Hash the recipe source, not absolute fixture paths, so two worktrees compare.
          recipes: await Promise.all(
            ["capture.test.ts", "scenarios.ts", "fixtures.ts"].map(async (file) =>
              hash(await readFile(new URL(file, import.meta.url))),
            ),
          ),
        }),
      ),
    };
    capture = {
      version: 1,
      source: {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean),
      },
      browser: suite.browser.version(),
      platform: `${process.platform}-${process.arch}`,
      catalog: hash(JSON.stringify(contract)),
      contract,
      options: { ...options, css: stylesheet ? hash(stylesheet) : undefined },
      shots: [],
      failures: [],
      complete: false,
    };
    await writeGallery(directory, capture);
  });
  afterAll(async () => {
    if (!capture) {
      return;
    }
    capture.complete =
      capture.failures.length === 0 &&
      capture.shots.length === selectedScenes.length * selectedProfiles.length;
    await writeGallery(directory, capture);
    console.log(
      `[control-ui-parity] ${capture.shots.length} shots, ${capture.failures.length} failures: ${directory}`,
    );
  });
  for (const profile of selectedProfiles) {
    for (const scene of selectedScenes) {
      const id = `${scene.id}--${profile.id}`;
      it(
        id,
        async () => {
          try {
            await suite.withPage(
              {
                viewport: { width: profile.width, height: profile.height },
                colorScheme: profile.theme,
                locale: "en-US",
                timezoneId: "UTC",
                serviceWorkers: "block",
                deviceScaleFactor: 1,
                forcedColors: profile.forced ? "active" : "none",
                reducedMotion: profile.reduced ? "reduce" : "no-preference",
              },
              async ({ page }) => {
                const pageErrors: string[] = [];
                page.on("pageerror", (error) => pageErrors.push(error.message));
                await page.route("**/*", async (route) => {
                  const url = new URL(route.request().url());
                  if (url.origin !== captureOrigin) {
                    await route.abort();
                    return;
                  }
                  // The visible connection URL must not inherit the server's random port.
                  const response = await route.fetch({
                    url: new URL(`${url.pathname}${url.search}`, suite.server.baseUrl).href,
                  });
                  await route.fulfill({ response });
                });
                await page.clock.setFixedTime(fixedTime);
                await page.addInitScript(() => {
                  let seed = 1;
                  Math.random = () => {
                    seed = (seed * 16807) % 2147483647;
                    return seed / 2147483647;
                  };
                });
                const gateway = await installMockGateway(page, {
                  ...baseScenario,
                  ...scene.scenario,
                  methodResponses: {
                    ...baseScenario.methodResponses,
                    ...scene.scenario?.methodResponses,
                  },
                });
                await page.goto(new URL(scene.path, captureOrigin).href);
                if (scene.route) {
                  await waitForControlUiRoute(page, { routeId: scene.route });
                }
                const content = page.locator(scene.ready).first();
                await content.waitFor();
                await page.evaluate(({ rtl, scale }) => {
                  if (rtl) {
                    document.documentElement.dir = "rtl";
                  }
                  if (scale) {
                    document.documentElement.style.fontSize = `${16 * scale}px`;
                  }
                }, profile);
                if (stylesheet) {
                  await page.addStyleTag({ content: stylesheet });
                }
                await scene.prepare?.(page, gateway);
                expect(pageErrors, "Synthetic scene must render without uncaught errors").toEqual(
                  [],
                );
                // The invitation is never part of visual evidence, even after fixture changes.
                expect(await page.locator(".community-invite").count()).toBe(0);
                const frame = await takeControlUiScreenshotFrame(
                  page,
                  page.locator("openclaw-app"),
                  [content],
                  {
                    animations: "disabled",
                    ...(scene.scrollTo ? { scrollTo: page.locator(scene.scrollTo) } : {}),
                  },
                );
                const file = `${id}.png`;
                await writeFile(path.join(directory, file), frame.png);
                capture.shots.push({
                  id,
                  scene: scene.id,
                  profile: profile.id,
                  label: `${scene.label} / ${profile.id}`,
                  file,
                  sha256: hash(frame.png),
                  width: profile.width,
                  height: profile.height,
                });
              },
            );
          } catch (error) {
            capture.failures.push({
              id,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            await writeGallery(directory, capture);
          }
        },
        90_000,
      );
    }
  }
  it("keeps gallery feedback across reload and exports the labeled example", async () => {
    await suite.withPage(
      { permissions: ["clipboard-read", "clipboard-write"] },
      async ({ page }) => {
        const shot = capture.shots[0]!;
        await page.goto(pathToFileURL(path.join(directory, "index.html")).href);
        const feedback = page.locator(`textarea[data-id="${shot.id}"]`);
        await feedback.fill("Review spacing beside this control.");
        await page.reload();
        expect(await feedback.inputValue()).toBe("Review spacing beside this control.");
        await page.getByRole("button", { name: "Copy feedback", exact: true }).click();
        await expect.poll(() => page.locator("#copy-result").textContent()).toBe("Copied");
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        expect(copied).toBe(`## ${shot.id}\n${shot.label}\nReview spacing beside this control.`);
        await feedback.fill("");
      },
    );
  });
});
