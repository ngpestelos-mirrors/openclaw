import type { Locator, Page } from "playwright";
import { expect } from "vitest";

function visibleDetails(page: Page | Locator): Locator {
  return page
    .locator(".chat-details:not(.chat-mobile-host .chat-details)")
    .or(page.locator(".chat-mobile-host:has(.chat-mobile-host__details:not([hidden]))"))
    .filter({ visible: true });
}

/** Pass a pane locator when more than one chat is presented. */
export async function openChatDetails(page: Page | Locator): Promise<Locator> {
  const details = visibleDetails(page);
  if (!(await details.isVisible())) {
    // Both native entries survive reconnect; mobile opens Details from the title.
    const entry = page
      .locator(".mobile-header__title")
      .or(
        page
          .getByRole("button", { name: "Details", exact: true })
          .and(page.locator(".chat-details-toggle")),
      )
      .filter({ visible: true })
      .first();
    await entry.click();
  }
  await details.waitFor();
  return details;
}

/** Dismiss through the visible native control on either platform. */
export async function closeChatDetails(page: Page | Locator): Promise<void> {
  const details = visibleDetails(page);
  await details.waitFor();
  const mobileClose = details.locator(".chat-mobile-host__header").getByRole("button", {
    name: "Close",
    exact: true,
  });
  if (await mobileClose.isVisible()) {
    await mobileClose.click();
  } else {
    await page
      .getByRole("button", { name: "Details", exact: true })
      .and(page.locator(".chat-details-toggle"))
      .click();
  }
  await details.waitFor({ state: "hidden" });
}

export async function openDetailsPullRequests(page: Page | Locator): Promise<Locator> {
  const details = await openChatDetails(page);
  const session = details.locator(".chat-details-session");
  const pullRequests = session.locator('[data-details-group="pull-requests"]');
  if ((await pullRequests.getAttribute("open")) === null) {
    await pullRequests.locator(":scope > summary").click();
  }
  await expect.poll(() => pullRequests.getAttribute("open")).not.toBeNull();
  return pullRequests;
}
