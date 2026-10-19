/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
} from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
  createTauriDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DevicePage } from "./device-page.tsx";
import { DevicePermissionsPage } from "./permissions-page.tsx";

type DevicePageElement = HTMLElement & { updateComplete: Promise<boolean> };
const providers: HTMLElement[] = [];
const unmounts = new WeakMap<HTMLElement, () => void>();

function createCapability(
  snapshot: NativeDeviceSettingsSnapshot | null = createNativeDeviceSettingsSnapshot(),
) {
  const listeners = new Set<(value: NativeDeviceSettingsSnapshot) => void>();
  const capability = {
    snapshot,
    subscribe(listener: (value: NativeDeviceSettingsSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: vi.fn<NativeDeviceSettingsCapability["set"]>(),
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn().mockResolvedValue(createChromeExtensionSetupResult()),
    installChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    capability,
    settle(index: number, next = createNativeDeviceSettingsSnapshot(), error?: Error) {
      capability.snapshot = next;
      capability.set.mock.calls[index]?.[2]?.(error);
      listeners.forEach((listener) => listener(next));
    },
    publish(next: NativeDeviceSettingsSnapshot) {
      capability.snapshot = next;
      listeners.forEach((listener) => listener(next));
    },
  };
}

async function mount(
  tag: "openclaw-device-page" | "openclaw-device-permissions-page",
  nativeDeviceSettings: NativeDeviceSettingsCapability | null,
) {
  const context = { nativeDeviceSettings } as ApplicationContext;
  // The retained Lit Chrome setup child still consumes its DOM context.
  const provider = createApplicationContextProvider(context);
  document.body.append(provider);
  providers.push(provider);
  const fixture = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(
    () => createComponent(tag === "openclaw-device-page" ? DevicePage : DevicePermissionsPage, {}),
    { container: provider, wrapper: fixture.wrapper },
  );
  flush();
  const page = provider.querySelector<HTMLElement>(tag)!;
  unmounts.set(page, mounted.unmount);
  return page;
}

function unmountPage(page: HTMLElement) {
  unmounts.get(page)?.();
}

function row(page: HTMLElement, title: string): HTMLElement {
  const match = [...page.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!match) {
    throw new Error(`Missing row: ${title}`);
  }
  return match;
}

function toggle(page: HTMLElement, title: string, checked: boolean) {
  const element = toggleInput(row(page, title));
  element.checked = checked;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeInput(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeDomain(page: HTMLElement, value: string) {
  typeInput(row(page, "Domains").querySelector<HTMLInputElement>("input")!, value);
}

function submitDomain(page: HTMLElement) {
  row(page, "Domains")
    .querySelector<HTMLFormElement>("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function toggleInput(scope: HTMLElement) {
  return scope.querySelector<HTMLInputElement>("input.settings-toggle__input")!;
}

function profileInput(page: HTMLElement) {
  return row(page, "Target profile").querySelector<HTMLInputElement>("input")!;
}

async function mountProfileEditor() {
  vi.useFakeTimers();
  const native = createCapability();
  const page = await mount("openclaw-device-page", native.capability);
  return { ...native, page, input: profileInput(page) };
}

function cookieSnapshot(
  values: Partial<ReturnType<typeof createNativeDeviceSettingsSnapshot>["browser"]["cookieSync"]>,
) {
  const snapshot = createNativeDeviceSettingsSnapshot();
  Object.assign(snapshot.browser.cookieSync, values);
  return snapshot;
}

function expectCookieWrite(
  capability: ReturnType<typeof createCapability>["capability"],
  field: "domains" | "targetProfile",
  value: string | string[],
) {
  expect(capability.set).toHaveBeenLastCalledWith(
    `browser.cookieSync.${field}`,
    value,
    expect.any(Function),
  );
}

function addDomain(page: HTMLElement, value: string) {
  typeDomain(page, value);
  flush();
  submitDomain(page);
  flush();
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(async () => {
  providers.splice(0).forEach((provider) => provider.remove());
  await Promise.resolve();
  flush();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("native device settings pages", () => {
  it.each(["linux", "windows"] as const)(
    "edits %s desktop sharing and displays worker failures without unsupported controls",
    async (platform) => {
      const snapshot = createTauriDeviceSettingsSnapshot(platform);
      const native = createCapability(snapshot);
      const page = await mount("openclaw-device-page", native.capability);
      expect(page.textContent).toContain("This computer");
      expect(row(page, "Desktop sharing").textContent).toContain("authenticated local VNC server");
      expect(row(page, "Desktop sharing status").textContent).toContain("Running");
      expect(page.textContent).not.toContain("Computer Control");
      toggle(page, "Desktop sharing", false);
      expect(native.capability.set).toHaveBeenCalledExactlyOnceWith(
        "capabilities.desktopSharingEnabled",
        false,
      );
      native.publish({
        ...snapshot,
        capabilities: { desktopSharingEnabled: false },
        desktopSharing: { state: "off" },
      });
      flush();
      expect(toggleInput(row(page, "Desktop sharing")).checked).toBe(false);
      native.publish({
        ...snapshot,
        desktopSharing: {
          state: "error",
          detail: "Install the OpenClaw CLI to share this desktop.",
        },
      });
      flush();
      expect(row(page, "Desktop sharing status").textContent).toContain("Unavailable");
      expect(page.textContent).toContain("Install the OpenClaw CLI");
      const permissions = await mount("openclaw-device-permissions-page", native.capability);
      expect(permissions.querySelector("input.settings-toggle__input")).toBeNull();
      expect(permissions.textContent).not.toContain("Location access");
    },
  );
  it("switches the advertised Mac experience and follows the native owner's saved value", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const title = "Native experience (Experimental)";
    const experience = row(page, title);
    expect(toggleInput(experience).checked).toBe(false);
    expect(experience.textContent).toContain("When off, use the Web experience");
    toggle(page, title, true);
    expect(native.capability.set).toHaveBeenCalledExactlyOnceWith(
      "app.nativeExperienceEnabled",
      true,
    );
    const saved = createNativeDeviceSettingsSnapshot();
    saved.app.nativeExperienceEnabled = true;
    native.publish(saved);
    flush();
    expect(toggleInput(experience).checked).toBe(true);
    toggle(page, title, false);
    expect(native.capability.set).toHaveBeenLastCalledWith("app.nativeExperienceEnabled", false);
    delete saved.app.nativeExperienceEnabled;
    native.publish(saved);
    flush();
    expect(page.textContent).not.toContain(title);
  });

  it("switches Gateway hosting only when available and follows the native owner's result", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const title = "Keep OpenClaw running when the app is closed";
    const hosting = row(page, title);
    expect(hosting.previousElementSibling).toBe(row(page, "Launch at login"));
    expect(hosting.textContent).toContain(
      "Runs the Gateway as a background service so channels and automations keep working after you quit OpenClaw.",
    );
    expect(toggleInput(hosting).checked).toBe(false);
    toggle(page, title, true);
    expect(native.capability.set).toHaveBeenCalledExactlyOnceWith(
      "app.keepGatewayRunning",
      true,
      expect.any(Function),
    );
    flush();
    expect(toggleInput(hosting).disabled).toBe(true);
    const saved = createNativeDeviceSettingsSnapshot();
    saved.app.keepGatewayRunning = true;
    native.settle(0, saved);
    flush();
    expect(toggleInput(hosting).checked).toBe(true);
    toggle(page, title, false);
    expect(native.capability.set).toHaveBeenLastCalledWith(
      "app.keepGatewayRunning",
      false,
      expect.any(Function),
    );
    native.settle(1, saved, new Error("Gateway did not become ready."));
    flush();
    expect(toggleInput(hosting).checked).toBe(true);
    expect(hosting.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not change Gateway hosting. Gateway did not become ready.",
    );
    saved.app.keepGatewayRunningAvailable = false;
    native.publish(saved);
    flush();
    expect(toggleInput(hosting).disabled).toBe(true);
    native.capability.set.mockClear();
    hosting.click();
    expect(native.capability.set).not.toHaveBeenCalled();
    delete saved.app.keepGatewayRunning;
    native.publish(saved);
    flush();
    expect(page.textContent).not.toContain(title);
  });

  it("shows native desktop state and reconciles Keep computer awake with the native owner", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    const native = createCapability({
      ...snapshot,
      capabilities: { ...snapshot.capabilities, unattendedDesktopEnabled: false },
      desktopAvailability: { state: "locked" },
    });
    const page = await mount("openclaw-device-page", native.capability);
    const hosting = row(page, "Keep computer awake");
    expect(hosting.textContent).toContain("between jobs");
    expect(hosting.textContent).toContain("Manual lock and logout");
    expect(row(page, "Desktop availability").textContent).toContain("Locked");
    expect(native.capability.set).not.toHaveBeenCalled();
    toggle(page, "Keep computer awake", true);
    expect(native.capability.set).toHaveBeenCalledWith(
      "capabilities.unattendedDesktopEnabled",
      true,
    );
    native.publish({
      ...snapshot,
      capabilities: { ...snapshot.capabilities, unattendedDesktopEnabled: false },
      desktopAvailability: { state: "unknown" },
    });
    flush();
    expect(toggleInput(hosting).checked).toBe(false);
    expect(row(page, "Desktop availability").textContent).toContain("Unknown");
    const capabilities = { ...snapshot.capabilities };
    delete capabilities.unattendedDesktopEnabled;
    native.publish({ ...snapshot, capabilities, desktopAvailability: { state: "unlocked" } });
    flush();
    expect(row(page, "Desktop availability").textContent).toContain("Unlocked");
    expect(page.textContent).not.toContain("Keep computer awake");
  });

  it("leaves Chrome data untouched on entry and focus until explicit refresh", async () => {
    const { capability } = createCapability();
    const page = await mount("openclaw-device-page", capability);
    const setup = page.querySelector<DevicePageElement>("openclaw-native-chrome-setup")!;
    await setup.updateComplete;
    expect(capability.setupChromeExtension).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    flush();
    await setup.updateComplete;
    expect(capability.setupChromeExtension).not.toHaveBeenCalled();
    const refresh = [...setup.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Refresh setup status",
    )!;
    refresh.click();
    await vi.waitFor(() => expect(setup.textContent).toContain("Setup required on this device"));
    expect(capability.setupChromeExtension).toHaveBeenCalledExactlyOnceWith("inspect");
    expect(capability.installChromeExtension).not.toHaveBeenCalled();
  });
  it.each(["openclaw-device-page", "openclaw-device-permissions-page"] as const)(
    "shows an app-only state without a bridge and waits for the initial snapshot on %s",
    async (tag) => {
      const browserPage = await mount(tag, null);
      expect(browserPage.textContent).toContain("only available inside the OpenClaw app");
      expect(browserPage.querySelector("input.settings-toggle__input")).toBeNull();
      const { capability } = createCapability(null);
      const waitingPage = await mount(tag, capability);
      expect(waitingPage.textContent).toContain("Waiting for settings from the app");
      expect(waitingPage.querySelector("input.settings-toggle__input")).toBeNull();
    },
  );

  it("renders local settings and delegates native toggles and panels without Gateway access", async () => {
    const snapshot = createNativeDeviceSettingsSnapshot();
    snapshot.app.debugPaneEnabled = true;
    snapshot.app.quickChatShortcut = null;
    snapshot.app.launchAtLoginAvailable = false;
    const { capability } = createCapability(snapshot);
    const page = await mount("openclaw-device-page", capability);
    expect(page.querySelector(".page-title")?.textContent).toContain("This Mac");
    expect(page.querySelector<HTMLAnchorElement>(".page-subtitle a")?.href).toBe(
      "https://docs.openclaw.ai/platforms/macos",
    );
    expect(row(page, "Quick Chat shortcut").textContent).toContain("Not set");
    const iconStyles = row(page, "Dock icon").querySelector<HTMLSelectElement>("select")!;
    expect(iconStyles.value).toBe("paper");
    expect([...iconStyles.options].map((option) => option.textContent?.trim())).toEqual([
      "Original",
      "Heritage",
      "Clawmark",
      "Origami",
      "Pincer",
      "Open C",
    ]);
    iconStyles.value = "origami";
    iconStyles.dispatchEvent(new Event("change", { bubbles: true }));
    expect(capability.set).toHaveBeenCalledWith("app.iconStyle", "origami");
    expect(toggleInput(row(page, "Launch at login")).disabled).toBe(true);
    expect(row(page, "Launch at login").textContent).toContain("requires a bundled app");
    expect(
      row(page, "Computer Control provider").querySelector<HTMLOptionElement>(
        'option[value="cua"]',
      )!.disabled,
    ).toBe(true);
    expect(row(page, "Allow Computer Control").textContent).toContain(
      "without per-action confirmation. High risk.",
    );

    toggle(page, "Show Dock icon", false);
    expect(capability.set).toHaveBeenCalledWith("app.showDockIcon", false);
    for (const [title, panel] of [
      ["Quick Chat shortcut", "quick-chat-shortcut"],
      ["Browser logins", "browser-import"],
      ["Debug window", "debug"],
    ] as const) {
      row(page, title).querySelector<HTMLButtonElement>("button")!.click();
      expect(capability.openPanel).toHaveBeenCalledWith(panel);
    }
  });

  it("renders new native snapshots and removes controls whose native capabilities became unavailable", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    const next = createNativeDeviceSettingsSnapshot();
    next.app.iconStyle = {
      selectedId: "origami",
      available: [{ id: "origami", name: "Origami" }],
    };
    native.publish(next);
    flush();
    const iconStyles = row(page, "Dock icon").querySelector<HTMLSelectElement>("select")!;
    expect(iconStyles.value).toBe("origami");
    expect(iconStyles.options).toHaveLength(1);
    delete next.app.iconStyle;
    next.app.quickChatShortcut = "⌘K";
    next.app.showDockIcon = false;
    next.capabilities.computerControlEnabled = false;
    next.browser.importAvailable = false;
    next.browser.cookieSync.available = false;
    native.publish(next);
    flush();
    expect(row(page, "Quick Chat shortcut").textContent).toContain("⌘K");
    expect(toggleInput(row(page, "Show Dock icon")).checked).toBe(false);
    expect(toggleInput(row(page, "Enable Peekaboo Bridge")).disabled).toBe(true);
    expect(page.querySelector('[aria-label="Computer Control provider"]')).toBeNull();
    expect(page.querySelector('[aria-label="Dock icon"]')).toBeNull();
    expect(page.textContent).not.toContain("Import browser logins…");
    expect(page.querySelector('[aria-label="Target profile"]')).toBeNull();
    expect(page.textContent).toContain("Cookie sync requires remote mode");
    expect(page.textContent).not.toContain("Open Debug window…");
  });

  it("renders only published iOS settings and delegates app preferences and device panels", async () => {
    const { capability } = createCapability(createIosNativeDeviceSettingsSnapshot());
    const page = await mount("openclaw-device-page", capability);
    expect(page.querySelector(".page-title")?.textContent).toContain("This iPhone");
    expect(
      [...page.querySelectorAll(".settings-row__title")].map((element) =>
        element.textContent?.trim(),
      ),
    ).toEqual([
      "Appearance",
      "Notifications",
      "Allow Camera",
      "Keep awake",
      "Health summaries",
      "Diagnostics",
      "Licenses",
      "About",
      "Apple Watch",
    ]);
    const appearance = row(page, "Appearance").querySelector<HTMLSelectElement>("select")!;
    expect(appearance.value).toBe("system");
    expect([...appearance.options].map((option) => option.value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
    appearance.value = "dark";
    appearance.dispatchEvent(new Event("change", { bubbles: true }));
    expect(capability.set).toHaveBeenCalledWith("app.appearance", "dark");
    for (const [title, key] of [
      ["Notifications", "app.notificationsEnabled"],
      ["Keep awake", "capabilities.keepAwakeEnabled"],
      ["Health summaries", "capabilities.healthSummaryEnabled"],
    ] as const) {
      toggle(page, title, true);
      expect(capability.set).toHaveBeenCalledWith(key, true);
    }
    for (const [title, panel] of [
      ["Diagnostics", "diagnostics"],
      ["Licenses", "licenses"],
      ["About", "about"],
      ["Apple Watch", "watch"],
    ] as const) {
      row(page, title).querySelector<HTMLButtonElement>("button")!.click();
      expect(capability.openPanel).toHaveBeenCalledWith(panel);
    }
  });

  it("removes absent device families and fields and hides unavailable health summaries", async () => {
    const native = createCapability(createIosNativeDeviceSettingsSnapshot());
    const page = await mount("openclaw-device-page", native.capability);
    const next: NativeDeviceSettingsSnapshot = {
      ...createIosNativeDeviceSettingsSnapshot(),
      app: { notificationsEnabled: false },
      capabilities: { healthSummaryAvailable: false, healthSummaryEnabled: true },
    };
    native.publish(next);
    flush();
    expect(page.querySelector('[aria-label="Appearance"]')).toBeNull();
    expect(page.textContent).not.toContain("Health summaries");
    expect(toggleInput(row(page, "Notifications")).checked).toBe(false);
    delete next.app;
    delete next.capabilities;
    native.publish(next);
    flush();
    expect(page.querySelectorAll("select, input")).toHaveLength(0);
    expect(page.querySelectorAll(".settings-group")).toHaveLength(1);
    expect(row(page, "Diagnostics").querySelector("button")).not.toBeNull();
  });

  it("normalizes and deduplicates added cookie hostnames and removes a selected hostname", async () => {
    const { capability } = createCapability();
    const page = await mount("openclaw-device-page", capability);
    for (const hostname of ["  EXAMPLE.COM ", "  ACCOUNTS.EXAMPLE.ORG  "]) {
      addDomain(page, hostname);
    }
    expectCookieWrite(capability, "domains", ["example.com", "accounts.example.org"]);
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expectCookieWrite(capability, "domains", ["accounts.example.org"]);
  });

  it("preserves newer domain edits across an older native acknowledgement", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-page", native.capability);
    for (const hostname of ["a.example.com", "b.example.com"]) {
      addDomain(page, hostname);
    }

    native.settle(0, cookieSnapshot({ domains: ["example.com", "a.example.com"] }));
    flush();
    page.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')?.click();
    expectCookieWrite(native.capability, "domains", ["a.example.com", "b.example.com"]);

    native.settle(2, cookieSnapshot({ domains: ["a.example.com", "b.example.com"] }));
    flush();
    native.publish(cookieSnapshot({ domains: ["external.example.com"] }));
    flush();
    expect(row(page, "Domains").textContent).toContain("external.example.com");
    expect(row(page, "Domains").textContent).not.toContain("b.example.com");
  });

  it("debounces profile typing and flushes the latest edit once when leaving the page", async () => {
    const { capability, page, input } = await mountProfileEditor();
    for (const value of ["work", "work-browser"]) {
      typeInput(input, value);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(capability.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(capability.set).toHaveBeenCalledExactlyOnceWith(
      "browser.cookieSync.targetProfile",
      "work-browser",
      expect.any(Function),
    );
    typeInput(input, "personal-browser");
    unmountPage(page);
    expectCookieWrite(capability, "targetProfile", "personal-browser");
    await vi.advanceTimersByTimeAsync(500);
    expect(capability.set).toHaveBeenCalledTimes(2);
  });

  it("preserves the latest sent profile across an older native acknowledgement", async () => {
    const { capability, settle, publish, input } = await mountProfileEditor();
    for (const value of ["first-profile", "second-profile"]) {
      typeInput(input, value);
      await vi.advanceTimersByTimeAsync(400);
    }
    settle(0, cookieSnapshot({ targetProfile: "first-profile" }));
    flush();
    expect(input.value).toBe("second-profile");

    typeInput(input, `${input.value}-final`);
    await vi.advanceTimersByTimeAsync(400);
    expectCookieWrite(capability, "targetProfile", "second-profile-final");
    settle(2, cookieSnapshot({ targetProfile: "second-profile-final" }));
    flush();
    publish(cookieSnapshot({ targetProfile: "external-profile" }));
    flush();
    expect(input.value).toBe("external-profile");
  });

  it("preserves pending cookie sync edits across page navigation", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const first = await mount("openclaw-device-page", native.capability);
    typeDomain(first, "b.example.com");
    flush();
    submitDomain(first);
    typeInput(profileInput(first), "pending-profile");
    unmountPage(first);

    const second = await mount("openclaw-device-page", native.capability);
    typeDomain(second, "c.example.com");
    flush();
    submitDomain(second);
    expectCookieWrite(native.capability, "domains", [
      "example.com",
      "b.example.com",
      "c.example.com",
    ]);
    const secondProfile = profileInput(second);
    typeInput(secondProfile, `${secondProfile.value}-remote`);
    unmountPage(second);
    expectCookieWrite(native.capability, "targetProfile", "pending-profile-remote");

    const acknowledged = cookieSnapshot({
      domains: ["example.com", "b.example.com", "c.example.com"],
      targetProfile: "pending-profile-remote",
    });
    native.settle(2, acknowledged);
    native.settle(3, acknowledged);
    native.publish(
      cookieSnapshot({ domains: ["external.example.com"], targetProfile: "external-profile" }),
    );
    const third = await mount("openclaw-device-page", native.capability);
    expect(row(third, "Domains").textContent).toContain("external.example.com");
    expect(row(third, "Domains").textContent).not.toContain("b.example.com");
    expect(profileInput(third).value).toBe("external-profile");
  });

  it("settles cancelled cookie edits after navigation without reusing rejected values", async () => {
    vi.useFakeTimers();
    const native = createCapability();
    const first = await mount("openclaw-device-page", native.capability);
    typeDomain(first, "rejected.example.com");
    flush();
    submitDomain(first);
    typeInput(profileInput(first), "rejected-profile");
    unmountPage(first);
    const second = await mount("openclaw-device-page", native.capability);
    native.settle(0);
    native.settle(1);
    flush();
    expect(row(second, "Domains").textContent).not.toContain("rejected.example.com");
    expect(profileInput(second).value).toBe("default");
    second.querySelector<HTMLButtonElement>('[aria-label="Remove example.com"]')!.click();
    expect(native.capability.set.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "browser.cookieSync.domains",
      [],
    ]);
  });

  it("settles native profile normalization without losing a newer unsent edit", async () => {
    const { settle, input } = await mountProfileEditor();
    typeInput(input, " work ");
    await vi.advanceTimersByTimeAsync(400);
    const normalized = cookieSnapshot({ targetProfile: "work" });
    settle(0, normalized);
    flush();
    expect(input.value).toBe("work");
    typeInput(input, "older");
    await vi.advanceTimersByTimeAsync(400);
    typeInput(input, "newer");
    settle(1, normalized);
    flush();
    expect(input.value).toBe("newer");
    await vi.advanceTimersByTimeAsync(400);
    settle(2, normalized);
    flush();
    expect(input.value).toBe("work");
  });

  it("keeps a newer equal-valued profile pending when the first request settles", async () => {
    const { settle, input } = await mountProfileEditor();
    for (const value of ["first", "middle", "first"]) {
      typeInput(input, value);
      await vi.advanceTimersByTimeAsync(400);
    }
    settle(0, cookieSnapshot({ targetProfile: "first" }));
    settle(1);
    flush();
    expect(input.value).toBe("first");
    settle(2);
    flush();
    expect(input.value).toBe("default");
  });

  it.each([
    ["screenRecording", "Screen Recording", "notDetermined", "Not granted", "Grant…"],
    ["accessibility", "Accessibility", "notDetermined", "Not granted", "Grant…"],
    ["eventPosting", "Event Posting", "notDetermined", "Not granted", "Grant…"],
  ] as const)(
    "requests %s access and retains explicit settings recovery without assuming a prior denial",
    async (id, title, status, label, action) => {
      const snapshot = createNativeDeviceSettingsSnapshot();
      snapshot.permissions.entries = [{ id, status }];
      const native = createCapability(snapshot);
      const page = await mount("openclaw-device-permissions-page", native.capability);
      const permission = row(page, title);
      expect(permission.textContent).toContain(label);
      const button = permission.querySelector<HTMLButtonElement>("button");
      expect(button?.textContent?.trim()).toBe(action);
      expect(native.capability.requestPermission).not.toHaveBeenCalled();
      button!.click();
      expect(native.capability.requestPermission).toHaveBeenCalledExactlyOnceWith(id);
      expect(native.capability.openSystemSettings).not.toHaveBeenCalled();
      const recovery = permission.querySelector<HTMLButtonElement>(".settings-permission-recovery");
      expect(recovery?.textContent?.trim()).toBe("Open System Settings…");
      recovery!.click();
      expect(native.capability.openSystemSettings).toHaveBeenCalledExactlyOnceWith(id);
      expect(native.capability.requestPermission).toHaveBeenCalledTimes(1);
      snapshot.permissions.entries = [{ id, status: "granted" }];
      native.publish(snapshot);
      flush();
      expect(permission.textContent).toContain("Granted");
      expect(permission.querySelector("button")).toBeNull();
    },
  );

  it.each([false, undefined])(
    "keeps iOS permission order and system-owned precision read-only (editable: %s)",
    async (preciseEditable) => {
      const snapshot = createIosNativeDeviceSettingsSnapshot();
      snapshot.permissions.location.preciseEditable = preciseEditable;
      snapshot.permissions.entries = [
        { id: "photos", status: "limited" },
        { id: "contacts", status: "limited" },
        { id: "calendars", status: "notDetermined" },
        { id: "reminders", status: "denied" },
      ];
      snapshot.permissions.location.precise = false;
      const native = createCapability(snapshot);
      const page = await mount("openclaw-device-permissions-page", native.capability);
      expect(
        [...page.querySelector(".settings-group")!.querySelectorAll(".settings-row__title")].map(
          (element) => element.textContent?.trim(),
        ),
      ).toEqual(["Photos", "Contacts", "Calendars", "Reminders"]);
      for (const title of ["Photos", "Contacts"]) {
        expect(row(page, title).textContent).toContain("Limited");
        expect(
          row(page, title).querySelector(".settings-row__desc")?.textContent?.trim(),
        ).toBeTruthy();
      }
      row(page, "Calendars").querySelector<HTMLButtonElement>("button")!.click();
      expect(native.capability.requestPermission).toHaveBeenCalledWith("calendars");
      row(page, "Reminders").querySelector<HTMLButtonElement>("button")!.click();
      expect(native.capability.openSystemSettings).toHaveBeenCalledWith("reminders");
      expect(page.textContent).not.toContain("System-wide presence detection");
      expect(
        row(page, "Precise location").querySelector("input.settings-toggle__input"),
      ).toBeNull();
      expect(row(page, "Precise location").textContent).toContain("Disabled");
      const settings = row(page, "Precise location").querySelector<HTMLButtonElement>("button")!;
      expect(settings.textContent?.trim()).toBe("Open Settings");
      settings.click();
      expect(native.capability.openSystemSettings).toHaveBeenCalledWith("location");
      expect(native.capability.set).not.toHaveBeenCalled();

      native.publish({
        ...snapshot,
        permissions: {
          ...snapshot.permissions,
          location: { ...snapshot.permissions.location, precise: true },
        },
      });
      flush();
      expect(row(page, "Precise location").textContent).toContain("Enabled");
      expect(
        row(page, "Precise location").querySelector("input.settings-toggle__input"),
      ).toBeNull();
    },
  );

  it("enables precision with location access and changes local location and activity preferences", async () => {
    const native = createCapability();
    const page = await mount("openclaw-device-permissions-page", native.capability);
    expect(toggleInput(row(page, "Precise location")).disabled).toBe(true);
    row(page, "Location access")
      .querySelector<HTMLInputElement>('input.settings-segmented__input[value="whileUsing"]')!
      .click();
    expect(native.capability.set).toHaveBeenCalledWith("permissions.location.mode", "whileUsing");
    const next = createNativeDeviceSettingsSnapshot();
    next.permissions.location.mode = "whileUsing";
    native.publish(next);
    flush();
    expect(toggleInput(row(page, "Precise location")).disabled).toBe(false);
    toggle(page, "Precise location", true);
    expect(native.capability.set).toHaveBeenCalledWith("permissions.location.precise", true);
    toggle(page, "System-wide presence detection", true);
    expect(native.capability.set).toHaveBeenCalledWith(
      "capabilities.activeComputerPresenceEnabled",
      true,
    );
    expect(row(page, "System-wide presence detection").textContent).toContain(
      "Shares only idle duration, never keys, pointer positions, app names, or window titles.",
    );
  });
});
