import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderModelPicker } from "./model-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../styles/base.css";
import "../styles/settings-controls.css";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("searchable model menu layout", () => {
  it.each([
    { width: 1280, placement: "bottom" as const },
    { width: 390, placement: "top" as const },
  ])("keeps distinct model labels readable at $width pixels", async ({ width, placement }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 844);
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;right:12px;${placement === "top" ? "bottom" : "top"}:32px;width:120px`;
    document.body.append(host);
    const onChange = vi.fn();
    render(
      renderModelPicker({
        label: "Model",
        value: "fixture/anchor",
        placement,
        options: [
          { value: "fixture/anchor", label: "Anchor", provider: "fixture" },
          { value: "fixture/aurora-large", label: "Aurora Large", provider: "fixture" },
          { value: "fixture/aurora-small", label: "Aurora Small", provider: "fixture" },
          ...["Birch", "Cedar", "Delta", "Elm", "Forest", "Granite"].map((label) => ({
            value: `fixture/${label.toLowerCase()}`,
            label,
            provider: "fixture",
          })),
        ],
        onChange,
      }),
      host,
    );
    const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    await page.getByRole("button", { name: "Model: Anchor", exact: true }).click();
    const row = picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!;
    await expect.element(row).toBeVisible();
    const label = row.querySelector<HTMLElement>(".picker-select__label")!;
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
    const bounds = menu.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
    await page.getByRole("combobox", { name: "Search", exact: true }).fill("Aurora Large");
    expect(onChange).not.toHaveBeenCalled();
    await picker.updateComplete;
    await page
      .elementLocator(picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!)
      .click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/aurora-large");
  });

  it("keeps a short menu fitted to its trigger", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(390, 844);
    const host = document.createElement("div");
    host.style.cssText = "width:160px;padding:24px";
    document.body.append(host);
    render(
      renderModelPicker({
        label: "Model",
        value: "auto",
        options: [
          { value: "auto", label: "Auto" },
          { value: "off", label: "Off" },
        ],
        onChange: vi.fn(),
      }),
      host,
    );
    const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    const trigger = page.getByRole("button", { name: "Model: Auto", exact: true });
    await trigger.click();
    await expect.element(page.getByRole("option", { name: "Off", exact: true })).toBeVisible();
    expect(picker.querySelector("input")).toBeNull();
    const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
    expect(menu.getBoundingClientRect().width).toBeCloseTo(
      picker.querySelector("button")!.getBoundingClientRect().width,
      0,
    );
  });
});
