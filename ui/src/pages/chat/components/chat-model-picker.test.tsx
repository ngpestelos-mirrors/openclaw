/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelProviderAuthLabel } from "../../../lib/model-provider-auth-label.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelPicker } from "./chat-model-picker.tsx";

afterEach(() => document.body.replaceChildren());

type PickerProps = Parameters<typeof ChatModelPicker>[0];
type Option = PickerProps["modelOptions"][number];
function option(provider: string, id: string, overrides: Partial<Option> = {}): Option {
  return {
    provider,
    value: `${provider}/${id}`,
    commitValue: `${provider}/${id}`,
    label: id,
    isDefault: false,
    ...overrides,
  };
}
function pickerProps(overrides: Partial<PickerProps> = {}): PickerProps {
  return {
    disabled: false,
    modelSelectionLocked: false,
    modelOptions: [],
    selectedModelValue: "fixture/current",
    sessionModelPinned: true,
    sessionKey: "main",
    triggerModelLabel: "Current",
    onModelSelect: vi.fn(async () => {}),
    ...overrides,
  };
}
function mountPicker(params: Partial<PickerProps>) {
  const container = document.body.appendChild(document.createElement("div"));
  let update!: (next: PickerProps) => void;
  mountSolid(
    () => {
      const [props, setProps] = createSignal(pickerProps(params));
      update = (next) => {
        setProps(() => next);
        flush();
      };
      return <ChatModelPicker {...props()} />;
    },
    { container },
  );
  flush();
  return { container, update };
}
const waitForMenu = (container: HTMLElement) =>
  waitForSolid(() => expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull());

it("mounts model choices on first open and retains them across dismissal", async () => {
  const onModelSelect = vi.fn(async () => {});
  const { container } = mountPicker({
    modelOptions: [option("fixture", "current", { label: "Current" })],
    onModelSelect,
  });
  expect(container.querySelector("[data-chat-model-option]")).toBeNull();
  expect(container.querySelector(".chat-controls__model-menu")).toBeNull();
  const details = container.querySelector("details")!;
  details.querySelector("summary")!.click();
  flush();
  await waitForMenu(container);
  const choice = container.querySelector<HTMLButtonElement>("[data-chat-model-option]")!;
  expect(choice.hidden).toBe(false);
  details.open = false;
  details.dispatchEvent(new Event("toggle"));
  flush();
  details.querySelector("summary")!.click();
  flush();
  await waitForMenu(container);
  expect(container.querySelector("[data-chat-model-option]")).toBe(choice);
  choice.click();
  expect(onModelSelect).toHaveBeenCalledWith("fixture/current", "main", undefined);
});

it.each([false, true])(
  "initially expands the selected provider and retains toggles on reopen (inherited=%s)",
  async (inherited) => {
    const params = pickerProps({
      modelOptions: [
        option("other", "first", { label: "Other" }),
        option("selected", "current", {
          commitValue: inherited ? "" : "selected/current",
          label: "Current",
          isDefault: inherited,
        }),
      ],
      selectedModelValue: inherited ? "" : "selected/current",
      sessionModelPinned: !inherited,
      open: true,
    });
    const { container, update } = mountPicker(params);
    await waitForMenu(container);
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    const selected = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="selected/current"]',
    )!;
    const other = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="other/first"]',
    )!;
    const toggle = selected
      .closest("section")!
      .querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(selected.hidden).toBe(false);
    expect(other.hidden).toBe(true);

    // A deliberate collapse survives closing and reopening the picker.
    toggle.click();
    flush();
    expect(selected.hidden).toBe(true);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(selected.hidden).toBe(true);
    expect(other.hidden).toBe(true);

    // The next selection, including a change while closed, owns the open group.
    update({ ...params, open: false, selectedModelValue: "other/first" });
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    expect(other.hidden).toBe(false);
    expect(selected.hidden).toBe(true);
  },
);

it.each([false, true])(
  "keeps current visible in a bounded catalog with Default=%s",
  async (hasDefault) => {
    const { container } = mountPicker({
      open: true,
      modelOptions: Array.from({ length: 300 }, (_, index) =>
        option("fixture", `model-${index}`, {
          commitValue: hasDefault && index === 0 ? "" : `fixture/model-${index}`,
          label: `Model ${index}`,
          isDefault: hasDefault && index === 0,
        }),
      ),
      selectedModelValue: "fixture/model-299",
      triggerModelLabel: "Model 299",
    });
    await waitForMenu(container);
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
    expect(rows).toHaveLength(300);
    expect(rows.filter((row) => !row.hidden)).toHaveLength(9);
    expect(rows.slice(0, 3).map((row) => row.dataset.chatModelOption)).toEqual(
      hasDefault
        ? ["fixture/model-0", "fixture/model-299", "fixture/model-1"]
        : ["fixture/model-299", "fixture/model-0", "fixture/model-1"],
    );
    expect(rows[hasDefault ? 1 : 0]?.getAttribute("aria-selected")).toBe("true");
    const more = container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!;
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
    search.value = "Model 298";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows.filter((row) => !row.hidden).map((row) => row.dataset.chatModelOption)).toEqual([
      "fixture/model-298",
    ]);
    expect(more.hidden).toBe(true);
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows.filter((row) => !row.hidden)).toHaveLength(9);
    more.click();
    expect(rows.filter((row) => !row.hidden)).toHaveLength(300);
    expect(more.hidden).toBe(true);
  },
);

it.each([false, true])(
  "drops the All models row once expanded so the rest continue the group (rest disabled=%s)",
  async (restDisabled) => {
    const { container } = mountPicker({
      modelOptions: [
        option("fixture", "lead", { recommended: true }),
        option("fixture", "rest", { disabled: restDisabled }),
      ],
      selectedModelValue: "fixture/lead",
      triggerModelLabel: "lead",
      open: true,
    });
    await waitForMenu(container);
    const more = container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!;
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    const rest = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="fixture/rest"]',
    )!;
    const group = container.querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(more.hidden).toBe(false);
    expect(rest.hidden).toBe(true);

    more.focus();
    more.click();
    flush();
    expect(more.hidden).toBe(true);
    expect(rest.hidden).toBe(false);
    // Keyboard focus lands on the first selectable revealed model, else back on search.
    expect(document.activeElement).toBe(
      restDisabled ? container.querySelector("[data-chat-model-search]") : rest,
    );

    // Collapsing and reopening the provider group keeps the models inline, with no row to re-collapse.
    group.click();
    flush();
    group.click();
    flush();
    expect(more.hidden).toBe(true);
    expect(rest.hidden).toBe(false);
    container.remove();
  },
);

it("groups Anthropic refs pinned to Claude CLI under Claude CLI", async () => {
  const { container } = mountPicker({
    open: true,
    modelOptions: [
      option("anthropic", "claude-opus-4-8", { agentRuntimeId: "claude-cli" }),
      option("claude-cli", "claude-haiku-5-5"),
      option("anthropic", "claude-sonnet-5-5", { agentRuntimeId: "openclaw" }),
    ],
    selectedModelValue: "anthropic/claude-opus-4-8",
    triggerModelLabel: "claude-opus-4-8",
    providerAuth: new Map<string, ModelProviderAuthLabel>([
      ["anthropic", { kind: "subscription", label: "Claude Max" }],
    ]),
  });
  await waitForMenu(container);
  const groups = Object.fromEntries(
    Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]")).map(
      (group) => [
        group.dataset.chatModelProviderGroup,
        Array.from(group.querySelectorAll<HTMLElement>("[data-chat-model-option]")).map(
          (row) => row.dataset.chatModelOption,
        ),
      ],
    ),
  );
  expect(groups).toEqual({
    "claude-cli": ["anthropic/claude-opus-4-8", "claude-cli/claude-haiku-5-5"],
    anthropic: ["anthropic/claude-sonnet-5-5"],
  });
  // Claude CLI signs in through the Anthropic account, so its group carries that auth label.
  expect(
    container.querySelector(
      '[data-chat-model-provider-group="claude-cli"] .chat-controls__auth-meta-label',
    )?.textContent,
  ).toBe("Claude Max");
});
