// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationRouter } from "../app-routes.ts";
import { scheduleRoutePreload } from "../lib/route-preload.ts";
import { connectNavigationPrefetch } from "./navigation-prefetch.ts";

const cleanups: Array<() => void> = [];
const idleCallbacks: Array<() => void> = [];
const connection = { saveData: false };
const manifest = {
  "new-session": ["assets/new-1234abcd.js", "assets/new-1234abcd.css"],
  claws: ["assets/claws-1234abcd.js"],
  palette: ["assets/palette-1234abcd.js"],
  "model-picker": ["assets/model-picker-1234abcd.js"],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idleCallbacks.push(callback));
  vi.stubGlobal("cancelIdleCallback", () => idleCallbacks.splice(0));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => manifest })),
  );
  Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
  connection.saveData = false;
  const meta = document.createElement("meta");
  meta.id = "openclaw-navigation-preloads";
  meta.content = "assets/navigation-preloads-1234abcd.json";
  document.head.append(meta);
  cleanups.push(() => meta.remove());
});

afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  idleCallbacks.length = 0;
  Reflect.deleteProperty(navigator, "connection");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const state: ReturnType<ApplicationRouter["getState"]> = {
    location: { pathname: "/chat", search: "", hash: "" },
    resolvedLocation: null,
    status: "success",
    matches: [],
    pendingMatches: [],
    cachedMatches: [],
  };
  let notify = () => {};
  const outlet = { presentationSettled: false };
  const transcript = { ready: false };
  const shell = document.body.appendChild(document.createElement("div"));
  const stop = connectNavigationPrefetch({
    shell,
    resourceBasePath: "/control",
    router: {
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => true;
      },
    },
    gateway: {
      snapshot: {
        phase: "connected",
        client: null,
        hello: null,
        assistantAgentId: "main",
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
      },
      subscribe: () => () => {},
    },
    outlet: () => outlet,
    transcriptsReady: () => transcript.ready,
  });
  cleanups.push(stop, () => shell.remove());
  return { state, outlet, transcript, shell, stop, notify: () => notify() };
}

const hints = () => [...document.head.querySelectorAll<HTMLLinkElement>("link")];
async function idle() {
  await vi.advanceTimersByTimeAsync(500);
  idleCallbacks.shift()?.();
  await vi.advanceTimersByTimeAsync(0);
}

it("waits for presentation, preloads inert assets serially, and yields to navigation and disposal", async () => {
  const fixture = setup();
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.outlet.presentationSettled = true;
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  fixture.transcript.ready = true;
  await idle();
  expect(fetch).toHaveBeenCalledWith(
    new URL("/control/assets/navigation-preloads-1234abcd.json", location.origin),
    expect.anything(),
  );
  expect(
    hints().map((link) => [link.rel, link.as ?? "", link.getAttribute("href"), link.fetchPriority]),
  ).toEqual([
    ["modulepreload", "", new URL("/control/assets/new-1234abcd.js", location.origin).href, "low"],
    ["preload", "style", new URL("/control/assets/new-1234abcd.css", location.origin).href, "low"],
  ]);
  await idle();
  expect(hints()).toHaveLength(2);
  fixture.state.status = "loading";
  fixture.notify();
  hints().forEach((link) => link.dispatchEvent(new Event("load")));
  await idle();
  expect(hints()).toHaveLength(2);
  fixture.state.status = "success";
  fixture.notify();
  await idle();
  expect(hints()).toHaveLength(3);
  fixture.stop();
  await idle();
  expect(hints()).toHaveLength(0);
});

it("prioritizes keyboard intent without mounting a dialog and rechecks Save-Data at effect time", async () => {
  const fixture = setup();
  fixture.outlet.presentationSettled = true;
  fixture.transcript.ready = true;
  const trigger = fixture.shell.appendChild(document.createElement("button"));
  trigger.className = "topbar-search";
  connection.saveData = true;
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await idle();
  expect(fetch).not.toHaveBeenCalled();
  connection.saveData = false;
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);
  expect(hints().map((link) => link.href)).toEqual([
    new URL("/control/assets/palette-1234abcd.js", location.origin).href,
  ]);
  expect(fixture.shell.children).toHaveLength(1);

  trigger.className = "chat-controls__model-trigger";
  trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  hints().forEach((link) => link.dispatchEvent(new Event("load")));
  await idle();
  expect(hints().map((link) => link.href)).toContain(
    new URL("/control/assets/model-picker-1234abcd.js", location.origin).href,
  );

  const timers = new Map();
  const preload = vi.fn();
  trigger.addEventListener("pointerenter", (event) =>
    scheduleRoutePreload(timers, "sessions", event, preload),
  );
  trigger.dispatchEvent(new Event("pointerenter"));
  connection.saveData = true;
  await vi.advanceTimersByTimeAsync(50);
  expect(preload).not.toHaveBeenCalled();
});
