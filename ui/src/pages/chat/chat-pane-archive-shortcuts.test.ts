/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { showToast } from "../../lib/toast.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
const modal = document.createElement("div");
afterEach(() => {
  vi.unstubAllGlobals();
  document.openClawModalLayers?.delete(modal);
});

const rowPatches: Record<string, Partial<GatewaySessionRow>> = {
  protected: { key: "agent:main:main" },
  archived: { archived: true },
  "non-durable": { sessionId: undefined },
};
function fixture(guard = "") {
  const client = createGatewayBrowserClientFixture();
  const row: GatewaySessionRow = {
    key: "agent:main:current",
    sessionId: "current-id",
    kind: "direct",
    ...rowPatches[guard],
  };
  const other: GatewaySessionRow = {
    key: "agent:main:other",
    sessionId: "other-id",
    kind: "direct",
  };
  const result = { ...sessionsResult([row, other]), path: "" };
  const patch = vi.fn(async () => ({}));
  const sessions = createSessionCapabilityFixture({
    patch,
    state: { result, error: null },
    captureConnectionScope: () => ({ client, epoch: 1 }),
    isConnectionScopeCurrent: () => true,
    invalidate: vi.fn(),
    refreshReplacement: vi.fn(async () => result),
  });
  const { pane, state } = createTestChatPane({ client, sessions });
  pane.active = true;
  state.sessionKey = row.key;
  state.sessionsResult = guard === "missing-row" ? null : result;
  state.connected = guard !== "offline";
  pane.onboarding = guard === "onboarding";
  state.chatMessage = "Keep the unsent foreground draft";
  pane.onPaneSessionChange = vi.fn();
  return { pane, state, sessions, patch, row };
}

function press(pane: TestChatPane, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "A",
    code: "KeyA",
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
    ...init,
  });
  pane.handleDocumentKeydown(event);
  return event;
}

it("uses the header lifecycle and Undo for the current session via the keyboard", async () => {
  const { pane, state, patch, row } = fixture();
  vi.mocked(showToast).mockClear();
  const action = vi.spyOn(pane, "handleHeaderSessionAction");
  const scope = { agentId: "main", expectedSessionId: row.sessionId };
  expect(press(pane).defaultPrevented).toBe(true);
  expect(action).toHaveBeenCalledExactlyOnceWith({ kind: "toggle-archived" }, row);
  await action.mock.results[0]?.value;
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ actionLabel: t("common.undo") }),
  );
  expect(patch).toHaveBeenCalledExactlyOnceWith(row.key, { archived: true }, scope);
  expect(state.chatMessage).toBe("Keep the unsent foreground draft");
  expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
  vi.mocked(showToast).mock.calls.at(-1)?.[0].onAction?.();
  await vi.waitFor(() =>
    expect(patch).toHaveBeenCalledWith(
      row.key,
      { archived: false },
      { ...scope, deferListRefresh: true },
    ),
  );
});

it("deduplicates rapid requests through the shared archive owner", async () => {
  const { pane, patch, sessions, row } = fixture();
  const pending = createDeferred<Record<string, never>>();
  patch.mockImplementation(() => pending.promise);
  press(pane);
  press(pane);
  await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
  expect(sessions.archiveVisibility(row.key)).toBe("pending");
  expect(press(pane).defaultPrevented).toBe(false);
  pending.resolve({});
  await vi.waitFor(() => expect(sessions.archiveVisibility(row.key)).toBeUndefined());
  expect(patch).toHaveBeenCalledOnce();
});

it.each([
  ["protected", false],
  ["archived", false],
  ["non-durable", false],
  ["modal", false],
  ["onboarding", false],
  ["offline", false],
  ["read-only", false],
  ["unavailable", false],
  ["missing-row", false],
  ["repeated-keydown", false],
  ["authority", true],
  ["presentation", true],
] as const)("does not archive when %s (revoked after admission: %s)", async (guard, late) => {
  const { pane, patch } = fixture(guard);
  if (late) {
    expect(press(pane).defaultPrevented).toBe(true);
  }
  if (guard === "read-only" || guard === "authority") {
    pane.context.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
  }
  if (guard === "unavailable") {
    pane.context.gateway.snapshot.hello!.features!.methods = [];
  }
  if (guard === "modal") {
    (document.openClawModalLayers ??= new Set()).add(modal);
  }
  if (guard === "presentation") {
    pane.presented = false;
  }
  if (!late) {
    expect(press(pane, { repeat: guard === "repeated-keydown" }).defaultPrevented).toBe(false);
  }
  await vi.dynamicImportSettled();
  expect(patch).not.toHaveBeenCalled();
});

it("keeps the draft and reports archive failure without navigating or offering Undo", async () => {
  const { pane, state, patch, sessions, row } = fixture();
  vi.mocked(showToast).mockClear();
  patch.mockRejectedValue(new Error("Archive rejected"));
  expect(press(pane).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(state.chatError).toContain("Archive rejected"));
  expect(state.chatMessage).toBe("Keep the unsent foreground draft");
  expect(pane.onPaneSessionChange).not.toHaveBeenCalled();
  expect(showToast).not.toHaveBeenCalled();
  expect(sessions.archiveVisibility(row.key)).toBeUndefined();
});
