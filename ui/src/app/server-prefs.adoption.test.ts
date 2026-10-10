/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { createProfilePrefsServer } from "./server-prefs.test-support.ts";
import { flushServerUiPrefs, pushServerUiPrefs, resetServerUiPrefsSync } from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const scope = "ws://navigation";
const pins = "ui.sidebarEntries";
const pendingKey = "openclaw.control.serverPrefs.pending.v1:" + scope + ":profile:a";
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["empty", "scope", "unpersisted-scope", "order"])(
  "folds newly persisted sibling pins into an adopted %s writer",
  async (mode) => {
    const editsScope = mode === "scope" || mode === "unpersisted-scope";
    const backend = createProfilePrefsServer({
      a: {
        [pins]: mode === "order" ? ["route:cron", "route:usage"] : ["route:usage"],
        "ui.navigationScope": "mine",
      },
    });
    const b = backend.connect("a");
    await b.refresh();
    Object.assign(b.writer.state, { connected: false });
    const hooks = { profileId: "a", canWrite: true };
    flushServerUiPrefs(b.writer, hooks);
    if (editsScope) {
      const originalSet = localStorage.setItem.bind(localStorage);
      const quota =
        mode === "unpersisted-scope"
          ? vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
              if (key === pendingKey) {
                throw new Error("quota");
              }
              originalSet(key, value);
            })
          : null;
      const previous = loadSettings();
      const next = patchSettings({ navigationScope: "all" });
      pushServerUiPrefs(b.writer, changedServerUiPrefs(previous, next)!, hooks);
      await vi.dynamicImportSettled();
      quota?.mockRestore();
    }
    // Another realm persists its offline addition after B adopted an empty pin pool.
    localStorage.setItem(
      pendingKey,
      JSON.stringify({
        sidebarEntries: ["route:usage", "route:cron"],
        sidebarEntriesBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
        ...(mode === "order" ? { sidebarEntriesOrder: true } : {}),
        ...(mode === "scope"
          ? { navigationScope: "all" }
          : mode === "unpersisted-scope"
            ? { navigationScope: "mine" }
            : {}),
      }),
    );
    patchSettings({ sidebarEntries: ["route:usage", "route:cron"] });
    const before = loadSettings();
    const next = patchSettings({ sidebarEntries: [...before.sidebarEntries, "route:plugins"] });
    pushServerUiPrefs(b.writer, changedServerUiPrefs(before, next)!, hooks);
    await vi.dynamicImportSettled();
    const queued = JSON.parse(localStorage.getItem(pendingKey)!);
    Object.assign(b.writer.state, { connected: true });
    flushServerUiPrefs(b.writer, hooks);
    await vi.dynamicImportSettled();
    expect(backend.profiles.a?.[pins]).toEqual(["route:usage", "route:cron", "route:plugins"]);
    expect(queued).toMatchObject({
      sidebarEntries: ["route:usage", "route:cron", "route:plugins"],
      sidebarEntriesBase: mode === "order" ? ["route:usage", "route:cron"] : ["route:usage"],
      ...(mode === "order" ? { sidebarEntriesOrder: true } : {}),
    });
    if (editsScope) {
      expect(backend.profiles.a?.["ui.navigationScope"]).toBe("all");
    }
    expect(localStorage.getItem(pendingKey)).toBeNull();
  },
);

it("flushes a sibling's new pool after the same adopted writer reconnects", async () => {
  const backend = createProfilePrefsServer({ a: { [pins]: ["route:usage"] } });
  const b = backend.connect("a");
  Object.assign(b.writer.state, { connected: false });
  const hooks = { profileId: "a", canWrite: true };
  flushServerUiPrefs(b.writer, hooks);
  localStorage.setItem(
    pendingKey,
    JSON.stringify({
      sidebarEntries: ["route:usage", "route:cron"],
      sidebarEntriesBase: ["route:usage"],
    }),
  );
  Object.assign(b.writer.state, { connected: true });
  flushServerUiPrefs(b.writer, hooks);
  await vi.dynamicImportSettled();
  expect(backend.profiles.a?.[pins]).toEqual(["route:usage", "route:cron"]);
  expect(localStorage.getItem(pendingKey)).toBeNull();
});
