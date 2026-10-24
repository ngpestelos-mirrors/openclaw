import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session transcript search" });

suite.define(() => {
  it("retries an indexing response without presenting it as an empty result", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 800, width: 1200 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: { "sessions.search": { indexing: true, results: [] } },
        });
        await page.goto(`${suite.server.baseUrl}sessions`);
        const search = page.getByRole("search", { name: "Search transcripts" });
        await search.getByRole("button", { name: "Search transcripts" }).click();
        const input = search.getByRole("searchbox", { name: "Search session transcripts" });
        await input.fill("recent phrase");
        await input.press("Enter");
        const indexing = page.getByText(
          "The transcript index is still updating. Retry to include recent messages.",
        );
        const empty = page.getByText("No transcript messages match that search.", { exact: true });
        await indexing.waitFor({ state: "visible", timeout: 10_000 });
        expect(await empty.count()).toBe(0);
        await gateway.setMethodResponse("sessions.search", { results: [] });
        await page.getByRole("button", { name: "Retry" }).click();
        await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
        await empty.waitFor({ state: "visible", timeout: 10_000 });
        expect(await indexing.count()).toBe(0);
      },
    );
  });
});
