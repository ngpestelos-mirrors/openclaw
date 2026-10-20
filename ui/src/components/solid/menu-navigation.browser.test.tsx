import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  item,
  mountMenu,
  navigationItems,
  openMenu,
  openSurfaces,
  phase,
  surface,
  trigger,
} from "../../test-helpers/solid-menu.tsx";
import {
  controlButton,
  controlInput,
  keyFocus,
  keyPhase,
  mountControls,
  menuContent,
  submenu,
  tabFocus,
  update,
} from "./menu-contract.test-support.tsx";
import { Menu, type MenuEntry, type MenuItem, type MenuProps } from "./menu.tsx";

afterEach(cleanup);

it.each([true, "while-open"] as const)(
  "retains lazy content only as requested (%s)",
  async (lazy) => {
    const transient = lazy === "while-open";
    const [label, setLabel] = createSignal(transient ? "First" : "Ready");
    let itemReads = 0;
    let childrenReads = 0;
    const view = mountMenu({
      lazy,
      get items() {
        itemReads++;
        return [{ id: "current", label: label() }];
      },
      get children() {
        childrenReads += transient ? 0 : 1;
        return transient ? undefined : "Lazy heading";
      },
    });
    if (!transient) {
      expect([itemReads, childrenReads]).toEqual([0, 0]);
    }
    expect(surface().querySelector("[role=menuitem]")).toBeNull();
    trigger().focus();
    await keyPhase("{ArrowDown}", "open");
    const first = item(transient ? "First" : "Ready");
    expect(document.activeElement).toBe(first);
    expect(document.querySelectorAll(":popover-open")).toHaveLength(1);
    if (!transient) {
      expect(childrenReads).toBe(1);
    }
    await keyPhase("{Escape}", "hidden");
    if (transient) {
      expect(surface().querySelector("[role=menuitem]")).toBeNull();
      update(() => setLabel("Second"));
    }
    expect(view.handle.open()).toBe(true);
    if (transient) {
      expect(document.activeElement).toBe(item("Second"));
    } else {
      await phase(surface(), "open");
      expect(item("Ready")).toBe(first);
      expect(childrenReads).toBe(1);
    }
  },
);

it.each([false, true])("rejects lazy admission without effects (veto=%s)", (veto) => {
  const view = mountMenu({
    lazy: true,
    items: veto ? [{ id: "ready", label: "Ready" }] : [],
    onBeforeShow: (event) => veto && event.preventDefault(),
  });
  trigger().focus();
  expect(view.handle.open()).toBe(false);
  expect(surface().matches(":popover-open")).toBe(false);
  expect(document.activeElement).toBe(trigger());
  expect(openSurfaces()).toEqual([]);
});

it("navigates search, grouped rows, and embedded controls", async () => {
  const selected: string[] = [];
  let pins = 0;
  const pin = (event: MouseEvent) => {
    event.stopPropagation();
    pins++;
  };
  const [revision, setRevision] = createSignal(0);
  mountControls((controls) => ({
    get items(): MenuEntry[] {
      revision();
      return [
        menuContent("search", <input ref={controls.ref()} data-search aria-label="Find agent" />),
        {
          kind: "group",
          id: "agents",
          class: "agent-list",
          items: [
            {
              id: "alpha",
              label: "Alpha",
              as: "div",
              content: (
                <>
                  Alpha
                  {controlButton(controls, "Pin Alpha", { tabindex: -1, onClick: pin })}
                </>
              ),
            },
            { id: "beta", label: "Beta" },
          ],
        },
        {
          id: "footer",
          label: "Footer",
          render: (attributes) => <button {...attributes}>Footer</button>,
        },
      ];
    },
    onSelect: (entry) => selected.push(entry.id),
  }));
  await openMenu();
  const group = surface().querySelector(".agent-list");
  const footer = item("Footer");
  const alpha = surface().querySelector<HTMLElement>('[data-value="alpha"]')!;
  alpha.focus();
  update(() => setRevision(1));
  expect(surface().querySelector(".agent-list")).toBe(group);
  expect(item("Footer")).toBe(footer);
  expect(document.activeElement).toBe(alpha);
  const search = surface().querySelector<HTMLInputElement>("input")!;
  search.focus();
  await keyFocus("{ArrowDown}", alpha);
  await tabFocus(surface().querySelector("[data-form-control]"));
  await tabFocus(alpha, true);
  await keyFocus("{ArrowUp}", search);
  await keyFocus("{ArrowDown}{ArrowDown}", item("Beta"));
  await userEvent.click(surface().querySelector<HTMLButtonElement>("[data-form-control]")!);
  expect(pins).toBe(1);
  expect(selected).toEqual([]);
  await keyFocus("{ArrowDown}", item("Beta"));
  await keyPhase("{Enter}", "hidden");
  expect(selected).toEqual(["beta"]);
  await openMenu();
  item("Footer").focus();
  await keyPhase("{Enter}", "hidden");
  expect(selected).toEqual(["beta", "footer"]);
});

it("preserves middle-click and context-menu intent", async () => {
  const selected: string[] = [];
  let parentContextMenus = 0;
  render(() => (
    <aside
      onContextMenu={(event) => {
        parentContextMenus += 1;
        event.preventDefault();
      }}
    >
      <Menu
        id="people"
        label="People"
        items={[{ id: "new", label: "New session", href: "/new?agent=main" }]}
        onSelect={(entry) => selected.push(entry.id)}
      />
    </aside>
  ));
  flush();
  await openMenu();
  const link = surface().querySelector<HTMLAnchorElement>("a")!;
  const prevented: boolean[] = [];
  const stopNavigation = (event: MouseEvent) => {
    prevented.push(event.defaultPrevented);
    // Observe the menu's decision before suppressing browser navigation in this test.
    event.preventDefault();
  };
  window.addEventListener("auxclick", stopNavigation);
  try {
    link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(prevented).toEqual([false]);
  } finally {
    window.removeEventListener("auxclick", stopNavigation);
  }
  const contextMenu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
  });
  link.dispatchEvent(contextMenu);
  expect(contextMenu.defaultPrevented).toBe(false);
  expect(parentContextMenus).toBe(0);
  expect(selected).toEqual([]);
  expect(surface().matches(":popover-open")).toBe(true);
  const triggerContextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  trigger().dispatchEvent(triggerContextMenu);
  expect(triggerContextMenu.defaultPrevented).toBe(true);
  expect(parentContextMenus).toBe(1);
});

it("keeps disabled links inert", async () => {
  const selected: string[] = [];
  mountMenu({
    items: [
      { id: "disabled", label: "Unavailable", href: "/new?agent=other", disabled: true },
      { id: "new", label: "New session", href: "/new?agent=main" },
    ],
    onSelect: (entry, event) => {
      selected.push(entry.id);
      event.preventDefault();
    },
  });
  await openMenu();
  const disabled = surface().querySelector<HTMLAnchorElement>('a[data-value="disabled"]')!;
  expect(disabled).toMatchObject({ tabIndex: -1 });
  expect([disabled.getAttribute("href"), disabled.getAttribute("aria-disabled")]).toEqual([
    null,
    "true",
  ]);
  disabled.click();
  expect(selected).toEqual([]);
});

it("vetoes Tab exit and honors custom focus destinations", async () => {
  let credential!: HTMLInputElement;
  let veto = true;
  render(() => (
    <>
      <button>Before picker</button>
      <Menu
        id="provider"
        label="Provider"
        items={[{ id: "beta", label: "Beta" }]}
        tabFocusTarget={(backward) => (backward ? trigger("provider") : credential)}
        onBeforeHide={(event) => veto && event.preventDefault()}
      />
      <input ref={(node) => (credential = node)} aria-label="Credential" />
    </>
  ));
  flush();
  credential.value = "synthetic-key";
  await openMenu("provider");
  await userEvent.tab();
  expect(surface("provider").matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(item("Beta", "provider"));
  veto = false;
  await userEvent.tab();
  await phase(surface("provider"), "hidden");
  expect(document.activeElement).toBe(credential);
  expect(credential.value).toBe("synthetic-key");
  await openMenu("provider");
  await userEvent.tab({ shift: true });
  await phase(surface("provider"), "hidden");
  expect(document.activeElement).toBe(trigger("provider"));
});

it("reopens checked items through a custom trigger", async () => {
  const [selected, setSelected] = createSignal("alpha");
  const choices = ["Alpha", "Beta", "Gamma"].map((label) => ({
    id: label.toLowerCase(),
    label,
  }));
  const view = mountMenu({
    get triggerAttributes(): MenuProps["triggerAttributes"] {
      return { id: "provider-trigger", "data-value": selected(), "aria-busy": "false" };
    },
    get items() {
      return choices.map<MenuItem>((choice) => ({
        id: choice.id,
        label: choice.label,
        type: "radio",
        checked: choice.id === selected(),
        attributes: { "data-initial-focus": choice.id === selected() ? "" : undefined },
      }));
    },
    onSelect: (entry) => setSelected(entry.id),
  });
  const button = view.getByRole("button", { name: "People" });
  expect(button.id).toBe("provider-trigger");
  expect(button.getAttribute("aria-busy")).toBe("false");
  expect(button.getAttribute("aria-controls")).toBe(surface().id);
  expect(surface().getAttribute("aria-labelledby")).toBe("provider-trigger");
  button.focus();
  await keyPhase("{Enter}", "open");
  expect(document.activeElement).toBe(item("Alpha"));
  await userEvent.keyboard("{ArrowDown}{Enter}");
  flush();
  await phase(surface(), "hidden");
  expect(button.getAttribute("data-value")).toBe("beta");
  expect(document.activeElement).toBe(button);
  await keyPhase("{Enter}", "open");
  expect(item("Beta").getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(item("Beta"));
  await keyFocus("{Home}", item("Alpha"));
  await keyFocus("{End}", item("Gamma"));
  await keyPhase("{Escape}", "hidden");
  expect(document.activeElement).toBe(button);
  await keyPhase("{ArrowUp}", "open");
  expect(document.activeElement).toBe(item("Gamma"));
  await keyPhase("{Escape}", "hidden");
  expect(document.activeElement).toBe(button);
});

it.each(["ArrowDown", "ArrowUp"])("skips disabled submenus on %s", async (key) => {
  mountMenu({
    items: [
      submenu("first", "Unavailable first", [{ id: "one", label: "One" }], true),
      { id: "enabled", label: "Enabled" },
      submenu("last", "Unavailable last", [{ id: "two", label: "Two" }], true),
    ],
  });
  trigger().focus();
  await keyPhase(`{${key}}`, "open");
  expect(document.activeElement).toBe(item("Enabled"));
  await keyFocus("{ArrowDown}", item("Enabled"));
  expect(trigger("people-first").getAttribute("aria-disabled")).toBe("true");
});

it.each(["ltr", "rtl"] as const)("keeps sibling navigation and Back/Down in %s", async (dir) => {
  mountMenu({ dir });
  await openMenu();
  expect(trigger("people-assign").dataset.value).toBe("assign");
  expect(trigger("people-move").dataset.value).toBe("move");
  await openMenu("people-assign");
  trigger("people-move").focus();
  await keyPhase(dir === "ltr" ? "{ArrowRight}" : "{ArrowLeft}", "open", "people-move");
  expect(surface("people-assign").matches(":popover-open")).toBe(false);
  expect(document.activeElement).toBe(item("Engineering", "people-move"));
  await keyFocus(dir === "ltr" ? "{ArrowLeft}" : "{ArrowRight}", trigger("people-move"));
  await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => document.activeElement).toBe(item("Archive"));
  await keyFocus("{Home}", trigger("people-assign"));
  await phase(surface("people-move"), "hidden");
  expect(openSurfaces()).toEqual([surface()]);
});

it.each(["before first open", "before reopen"] as const)("updates RTL keys %s", async (when) => {
  const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
  mountMenu({
    get dir() {
      return direction();
    },
  });
  if (when === "before reopen") {
    await openMenu();
    trigger("people-assign").focus();
    await keyPhase("{ArrowRight}", "open", "people-assign");
    await keyPhase("{ArrowLeft}{Escape}", "hidden");
  }
  update(() => setDirection("rtl"));
  await openMenu();
  trigger("people-assign").focus();
  await keyPhase("{ArrowLeft}", "open", "people-assign");
  expect(document.activeElement).toBe(item("Ada Rivera", "people-assign"));
  await keyPhase("{ArrowRight}", "hidden", "people-assign");
  expect(document.activeElement).toBe(trigger("people-assign"));
  await keyFocus("{ArrowDown}", trigger("people-move"));
});

it.each([undefined, "checkbox", "radio"] as const)(
  "focuses and activates typeahead (%s)",
  async (type) => {
    const selected: string[] = [];
    mountMenu({
      items: [...navigationItems.slice(0, -1), { id: "configured-choice", label: "Archive", type }],
      onSelect: (entry) => selected.push(entry.id),
    });
    await openMenu();
    await keyFocus("{End}", item("Archive"));
    await keyFocus("{ArrowUp}", trigger("people-move"));
    await keyFocus("{Home}a", item("Archive"));
    expect(surface().hasAttribute("aria-activedescendant")).toBe(false);
    expect(item("Archive").tabIndex).toBe(0);
    await keyPhase("{Enter}", "hidden");
    expect(selected).toEqual(["configured-choice"]);
    expect(document.activeElement).toBe(trigger());
  },
);

it("clears search before closing the deepest menu", async () => {
  mountControls((controls) => ({
    items: [
      {
        id: "search",
        label: "Find person",
        children: [{ id: "ada", label: "Ada" }],
        content: controlInput(controls, "Search people", {
          "data-search": "",
          "data-initial-focus": "",
        }),
      },
    ],
  }));
  await openMenu();
  await openMenu("people-search");
  const search = surface("people-search").querySelector("input")!;
  expect(document.activeElement).toBe(search);
  await userEvent.fill(search, "Grace");
  await userEvent.keyboard("{Escape}");
  expect(search.value).toBe("");
  expect(surface("people-search").matches(":popover-open")).toBe(true);
  await keyPhase("{Escape}", "hidden", "people-search");
  expect(surface().matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(trigger("people-search"));
  await keyPhase("{Escape}", "hidden");
  expect(document.activeElement).toBe(trigger());
});

it("skips ineligible controls without disrupting editing", async () => {
  const view = mountControls((controls) => ({
    items: [],
    children: (
      <>
        {controlButton(controls, "Default")}
        {controlButton(controls, "Disabled", { disabled: true })}
        {controlButton(controls, "Unavailable", { "aria-disabled": "true" })}
        {controlInput(controls, "Hidden attribute", { "data-form-control": "", hidden: true })}
        {controlInput(controls, "", { type: "hidden", "data-form-control": "" })}
        <span style={{ visibility: "hidden" }}>
          {controlInput(controls, "Invisible", { "data-form-control": "" })}
        </span>
        <span ref={controls.ref()} data-form-control="">
          Not focusable
        </span>
        {controlButton(controls, "Not sequential", { tabindex: -1 })}
        <div inert>{controlInput(controls, "Inert control", { "data-form-control": "" })}</div>
        {controlButton(controls, "Coral")}
        {controlInput(controls, "Custom icon", { "data-form-control": "" })}
      </>
    ),
  }));
  await openMenu();
  const first = view.getByRole("button", { name: "Default" });
  const second = view.getByRole("button", { name: "Coral" });
  const input = view.getByRole("textbox", { name: "Custom icon" }) as HTMLInputElement;
  first.focus();
  await tabFocus(second);
  await tabFocus(first, true);
  await userEvent.tab();
  await tabFocus(input);
  await userEvent.fill(input, "abc");
  await userEvent.keyboard("{ArrowLeft}X");
  expect(input.value).toBe("abXc");
  await keyPhase("{Escape}", "hidden");
  await openMenu();
  expect(view.getByRole("textbox", { name: "Custom icon" })).toBe(input);
  expect(input.value).toBe("abXc");
  input.focus();
  await userEvent.tab();
  await phase(surface(), "hidden");
  expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
});

it("Tabs between rows and embedded settings", async () => {
  const view = mountControls((controls) => ({
    items: [
      { id: "before", label: "Before settings" },
      menuContent(
        "settings",
        <>
          {controlInput(controls, "Filter settings", { "data-search": "" })}
          {controlButton(controls, "Send always")}
          {controlButton(controls, "Receive always")}
        </>,
      ),
      { id: "after", label: "After settings" },
    ],
  }));
  await openMenu();
  const before = item("Before settings");
  const after = item("After settings");
  const search = view.getByRole("textbox", { name: "Filter settings" });
  const send = view.getByRole("button", { name: "Send always" });
  const receive = view.getByRole("button", { name: "Receive always" });
  before.focus();
  for (const target of [search, send, receive, after]) {
    await tabFocus(target);
  }
  for (const target of [receive, send, search, before]) {
    await tabFocus(target, true);
  }
  expect(surface().matches(":popover-open")).toBe(true);
});

it("excludes descendant controls from parent Tab order", async () => {
  let veto = true;
  const view = mountControls((controls) => ({
    items: [],
    children: (
      <>
        {controlInput(controls, "First control", { "data-form-control": "" })}
        <Menu
          id="nested-controls"
          label="Nested controls"
          items={[]}
          controls={controls}
          onBeforeHide={(event) => veto && event.preventDefault()}
        >
          {controlInput(controls, "Descendant control", { "data-form-control": "" })}
        </Menu>
        {controlInput(controls, "Last control", { "data-form-control": "" })}
      </>
    ),
  }));
  await openMenu();
  await openMenu("nested-controls");
  const first = view.getByRole("textbox", { name: "First control" });
  const last = view.getByRole("textbox", { name: "Last control" });
  first.focus();
  expect(surface("nested-controls").matches(":popover-open")).toBe(true);
  await tabFocus(last);
  await tabFocus(first, true);
  veto = false;
  last.focus();
  await userEvent.tab();
  await phase(surface(), "hidden");
  expect(document.activeElement).toBe(view.getByRole("button", { name: "After menu" }));
});

it("publishes cancelable checkbox/radio selection", async () => {
  const [entries, setEntries] = createSignal<readonly MenuItem[]>([
    { id: "notify", label: "Notify", type: "checkbox", checked: false, closeOnSelect: false },
    { id: "default", label: "Default", type: "radio", checked: true },
    { id: "restricted", label: "Restricted", type: "radio", checked: false },
  ]);
  let veto = true;
  mountMenu({
    get items() {
      return entries();
    },
    onSelect: (entry, event) => {
      if (veto) {
        event.preventDefault();
        return;
      }
      setEntries((current) =>
        current.map((value) => ({
          ...value,
          checked:
            value.type === "radio" && entry.type === "radio"
              ? value.id === entry.id
              : value.id === entry.id
                ? !value.checked
                : value.checked,
        })),
      );
    },
  });
  await openMenu();
  await userEvent.click(item("Restricted"));
  expect(item("Restricted").getAttribute("aria-checked")).toBe("false");
  expect(surface().matches(":popover-open")).toBe(true);
  veto = false;
  await userEvent.click(item("Notify"));
  flush();
  expect(item("Notify").getAttribute("aria-checked")).toBe("true");
  expect(surface().matches(":popover-open")).toBe(true);
  await userEvent.click(item("Restricted"));
  flush();
  await phase(surface(), "hidden");
  await openMenu();
  expect(item("Restricted").getAttribute("aria-checked")).toBe("true");
  expect(item("Default").getAttribute("aria-checked")).toBe("false");
});
