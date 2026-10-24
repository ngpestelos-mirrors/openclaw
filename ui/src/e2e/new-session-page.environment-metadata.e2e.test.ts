import { expect, it } from "vitest";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  pollText,
  pollEnabled,
  pollDisabled,
  WORKSPACE,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const device = {
  id: "node:alpha-device",
  type: "node",
  label: "Build runner",
  status: "available",
  sessionHost: true,
};

suite.define(() => {
  it("retains selected device geometry and focus through authoritative inventory refreshes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [{ ...device, workerSlots: { total: 4, available: 2 } }],
            profiles: [{ id: "ephemeral", providerId: "crabbox", trust: "disposable" }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const place = page.locator(".oc-popover.new-session-page__where-popover");
      await openEnvironmentPicker(page);
      const selectedRow = place.locator('[data-value="device:alpha-device"]');
      await selectedRow.waitFor();
      const details = selectedRow
        .locator("xpath=ancestor::openclaw-tooltip[1]")
        .locator('[slot="content"]');
      const selectionLayout = () =>
        selectedRow.evaluate((element) =>
          [
            element,
            element.querySelector(".session-menu__text")!,
            element.querySelector(".session-menu__check")!,
          ].map((part) => {
            const { x, width } = part.getBoundingClientRect();
            return { x, width };
          }),
        );
      await selectedRow.hover();
      const beforeSelection = await selectionLayout();
      expect(beforeSelection.every(({ width }) => width > 0)).toBe(true);
      expect(await selectedRow.locator(".session-menu__check svg").count()).toBe(0);
      await selectedRow.click();
      await selectedRow.waitFor({ state: "hidden" });
      await openEnvironmentPicker(page);
      await selectedRow.hover();
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      expect(await selectedRow.locator(".session-menu__check svg").isVisible()).toBe(true);
      expect(await selectionLayout()).toEqual(beforeSelection);
      expect(await gateway.getRequests("node.list")).toHaveLength(0);
      const beforeRefresh = (await gateway.getRequests("environments.list")).length;
      await gateway.emitGatewayEvent("presence", {
        presence: [{ instanceId: "other-browser", mode: "webchat", roles: ["operator"] }],
      });
      await page.locator("openclaw-new-session-page").evaluate(async (element) => {
        await (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(beforeRefresh);
      expect(await selectedRow.isEnabled()).toBe(true);
      const catalog = (
        status: "available" | "unavailable",
        available: number,
        label = "Build runner",
      ) => ({
        environments: [{ ...device, label, status, workerSlots: { total: 4, available } }],
        profiles: [],
      });
      const selectedControl = await selectedRow.elementHandle();
      if (!selectedControl) {
        throw new Error("Selected device control is unavailable");
      }
      await page.keyboard.press("Tab");
      await selectedRow.focus();
      const emitInventory = async (count = 1) => {
        for (let index = 0; index < count; index += 1) {
          await gateway.emitGatewayEvent("node.runnerInventory.changed", {
            nodeId: "alpha-device",
          });
        }
      };
      await gateway.deferNext("environments.list");
      await emitInventory();
      await gateway.waitForRequest("environments.list", { after: beforeRefresh });
      await emitInventory(31);
      expect(await gateway.getRequests("environments.list")).toHaveLength(beforeRefresh + 1);
      await pollDisabled(selectedRow).toBe(true);
      expect(
        await selectedControl.evaluate((element) => ({
          connected: element.isConnected,
          focused: element === document.activeElement,
          device: element.getAttribute("data-value"),
        })),
      ).toEqual({ connected: true, focused: true, device: "device:alpha-device" });
      await page.keyboard.press("Enter");
      expect(await place.evaluate((element) => element.matches(":popover-open"))).toBe(true);
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        await gateway.deferNext("environments.list");
        await gateway.resolveDeferred(
          "environments.list",
          catalog("available", 2, `Build runner ${cycle}`),
        );
        await gateway.waitForRequest("environments.list", { after: beforeRefresh + cycle });
        await pollText(selectedRow).toContain(`Build runner ${cycle}`);
        expect(await gateway.getRequests("environments.list")).toHaveLength(
          beforeRefresh + cycle + 1,
        );
        expect(await selectedRow.isDisabled()).toBe(true);
        if (cycle < 4) {
          await emitInventory(8);
        }
      }
      await gateway.resolveDeferred("environments.list", catalog("available", 0));
      await selectedRow.hover();
      await pollText(details).toContain("No worker slots are available");
      expect(await selectedRow.getAttribute("aria-pressed")).toBe("true");
      expect(await selectedControl.evaluate((element) => element.isConnected)).toBe(true);
      await selectedControl.dispose();
      for (const source of ["presence", "hosting"]) {
        for (const enabled of [false, true]) {
          const previousRequests = (await gateway.getRequests("environments.list")).length;
          const next = catalog(source === "presence" && !enabled ? "unavailable" : "available", 4);
          next.environments[0]!.sessionHost = source === "presence" || enabled;
          await gateway.setMethodResponse("environments.list", next);
          if (source === "hosting") {
            await emitInventory();
          } else {
            await gateway.emitGatewayEvent("presence", {
              presence: [
                {
                  deviceId: "alpha-device",
                  mode: "node",
                  roles: ["node"],
                  reason: enabled ? "connect" : "disconnect",
                },
              ],
            });
          }
          await gateway.waitForRequest("environments.list", { after: previousRequests });
          await pollEnabled(selectedRow).toBe(enabled);
        }
      }
    });
  });
});
