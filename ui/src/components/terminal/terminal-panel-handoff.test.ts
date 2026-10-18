/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);
const terminals: ReturnType<typeof createTerminalController>[] = [];

function gatewayFixture(liveCatalog = false) {
  const opened: TerminalSessionInfo[] = [];
  let nextId = 0;
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "terminal.open") {
      const result = terminalOpenResult(`session-${++nextId}`);
      opened.push({ ...result, attached: true, createdAtMs: 1 });
      return result;
    }
    if (method === "terminal.upload") {
      return { path: "/tmp/synthetic-file.txt", size: 4 };
    }
    if (method === "terminal.attach") {
      const { sessionId } = params as { sessionId: string };
      return { ...terminalOpenResult(sessionId), buffer: "live owner", seq: 10 };
    }
    return method === "terminal.list"
      ? {
          sessions: liveCatalog ? opened : [],
        }
      : { ok: true };
  });
  const client: TerminalGatewayClient = {
    request: request as TerminalGatewayClient["request"],
    forceReconnect: vi.fn(),
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    request,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}

async function mount(client: TerminalGatewayClient, embedded = true, expectedTabs = 1) {
  const panel = createTestTerminalPanel(tag);
  panel.embedded = embedded;
  panel.client = client;
  panel.available = true;
  document.body.append(panel);
  if (!panel.terminalPanelOpen) {
    panel.toggle();
  }
  await panel.updateComplete;
  await vi.waitFor(() => expect(panel.hostedTabs).toHaveLength(expectedTabs));
  await vi.waitFor(() =>
    expect(panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(false),
  );
  return panel;
}

beforeAll(async () => {
  await import("@openclaw/libterminal/browser");
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  await i18n.setLocale("en");
  terminals.length = 0;
  createTerminal.mockImplementation(async () => {
    const terminal = createTerminalController();
    terminals.push(terminal);
    return terminal;
  });
});
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  createTerminal.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function dockButton(panel: HTMLElement) {
  const button = panel.querySelector<HTMLButtonElement>('[aria-label="Dock to bottom"]');
  expect(button).not.toBeNull();
  return button!;
}

it("keeps a destination's live PTY beside its detached diagnostic view", async () => {
  const gateway = gatewayFixture();
  const source = await mount(gateway.client);
  gateway.emit("terminal.exit", {
    sessionId: "session-1",
    reason: "detached",
    exitCode: null,
    signal: 15,
  });
  const diagnostic = terminals[0]!;
  const diagnosticHost = createTerminal.mock.calls[0]![0].parent;
  const target = await mount(gateway.client, false);
  target.handleToggleRequest(
    new CustomEvent("openclaw:terminal-toggle", {
      detail: { open: true, terminalSessionId: "session-1" },
    }),
  );
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(2));
  await vi.waitFor(() =>
    expect(target.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true),
  );
  const live = terminals[2]!;
  const liveId = target.activeHostedTabId;
  const liveHost = createTerminal.mock.calls[2]![0].parent;
  source.activateTerminalHost();
  await source.updateComplete;
  expect(dockButton(source).disabled).toBe(false);
  dockButton(source).click();
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(3));
  expect(target.contains(liveHost)).toBe(true);
  expect(target.contains(diagnosticHost)).toBe(true);
  const diagnosticTab = target.hostedTabs.find((tab) => tab.className === "is-exited");
  expect(diagnosticTab?.statusLabel).toMatch(/detached/i);
  expect(target.activeHostedTabId).toBe(diagnosticTab?.id);
  expect(live.dispose).not.toHaveBeenCalled();
  expect(diagnostic.dispose).not.toHaveBeenCalled();
  target.handleToggleRequest(
    new CustomEvent("openclaw:terminal-toggle", {
      detail: { open: true, terminalSessionId: "session-1" },
    }),
  );
  await vi.waitFor(() => expect(target.activeHostedTabId).toBe(liveId));
  expect(
    gateway.request.mock.calls.filter(([method]) => method === "terminal.attach"),
  ).toHaveLength(1);
});

it("disposes an explicitly cancelled diagnostic handoff without a dead attach", async () => {
  const gateway = gatewayFixture();
  const panel = await mount(gateway.client);
  gateway.emit("terminal.exit", { sessionId: "session-1", reason: "process_exit", exitCode: 17 });
  const diagnostic = terminals[0]!;
  dockButton(panel).click();
  expect(panel.hostedTabs).toHaveLength(0);
  expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
  expect(diagnostic.dispose).not.toHaveBeenCalled();
  panel.closeTerminalPanel();
  expect(diagnostic.dispose).toHaveBeenCalledOnce();
  expect(gateway.request.mock.calls.some(([method]) => method === "terminal.attach")).toBe(false);
});

it("keeps catalog first-output readiness at its source until output arrives", async () => {
  sessionStorage.setItem(
    "openclaw.terminal.actions.v1",
    JSON.stringify([
      {
        kind: "catalog",
        agentId: "ops",
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "waiting" },
      },
    ]),
  );
  const gateway = gatewayFixture();
  const panel = await mount(gateway.client);
  const terminal = terminals[0]!;
  const dock = dockButton(panel);
  expect(panel.hostedTabs[0]?.className).toBe("is-connecting");
  expect(dock.disabled).toBe(true);
  dock.click();
  expect(panel.hostedTabs).toHaveLength(1);
  expect(terminal.dispose).not.toHaveBeenCalled();
  gateway.emit("terminal.data", { sessionId: "session-1", seq: 5, data: "ready" });
  await vi.waitFor(() => expect(dock.disabled).toBe(false));
  expect(panel.hostedTabs[0]?.className).toBe("is-live");
  await vi.advanceTimersByTimeAsync(panel.catalogReadyTimeoutMs + 1);
  await panel.updateComplete;
  expect(panel.hostedTabs[0]?.className).toBe("is-live");
  expect(panel.querySelector(".tp-error")).toBeNull();
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(gateway.request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
});

it("retains unsent text and uploaded attachments across tabs and a native docking handoff", async () => {
  const gateway = gatewayFixture(true);
  const source = await mount(gateway.client);
  const first = source.activeHostedTabId!;
  source.selectHostedTab(first);
  await source.updateComplete;
  const input = source.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!;
  input.value = "cat";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const file = new File(["test"], "synthetic-file.txt");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("test").buffer,
  });
  const fileInput = source.querySelector<HTMLInputElement>(".tp-file-input")!;
  Object.defineProperty(fileInput, "files", { value: [file] });
  fileInput.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(source.querySelector(".tp-attachment")?.textContent).toContain("synthetic-file.txt"),
  );
  expect(terminals[0]!.terminal.paste).not.toHaveBeenCalled();
  expect(terminals[0]!.terminal.input).not.toHaveBeenCalled();
  source.handleToggleRequest(
    new CustomEvent("openclaw:terminal-toggle", { detail: { open: true, newSession: true } }),
  );
  await vi.waitFor(() => expect(source.hostedTabs).toHaveLength(2));
  await vi.waitFor(() =>
    expect(
      source.hostedTabs.every((tab) => tab.className === "is-live"),
      "source tabs ready",
    ).toBe(true),
  );
  await source.updateComplete;
  expect(source.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.value).toBe("");
  source.selectHostedTab(first);
  await source.updateComplete;
  expect(source.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.value).toBe(
    "cat",
  );
  const target = await mount(gateway.client, false, 2);
  source.activateTerminalHost();
  await source.updateComplete;
  dockButton(source).click();
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(2));
  await vi.waitFor(() =>
    expect(
      target.hostedTabs.every((tab) => tab.className === "is-live"),
      "target tabs ready",
    ).toBe(true),
  );
  target.embedded = true;
  await target.updateComplete;
  await vi.waitFor(() =>
    expect(target.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')?.value).toBe(
      "cat",
    ),
  );
  expect(target.querySelector(".tp-attachment")?.textContent).toContain("synthetic-file.txt");
  expect(
    terminals.every((terminal) => terminal.terminal.paste.mock.calls.length === 0),
    "no paste before submit",
  ).toBe(true);
  target
    .querySelector("form.tp-composer")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await target.updateComplete;
  const submitted = terminals.find((terminal) => terminal.terminal.paste.mock.calls.length > 0)!;
  expect(submitted.terminal.paste).toHaveBeenCalledExactlyOnceWith("cat /tmp/synthetic-file.txt");
  expect(submitted.terminal.input).toHaveBeenCalledExactlyOnceWith("\r", true);
  expect(target.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!.value).toBe("");
  expect(target.querySelector(".tp-attachment")).toBeNull();
});
