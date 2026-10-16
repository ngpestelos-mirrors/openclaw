/* @vitest-environment jsdom */

import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderChatComposerNotices, renderChatTopbarNotices } from "./chat-view-notices.tsx";

const unsafeModel = "<img src=x onerror=alert(1)>";
type ComposerProps = Parameters<typeof renderChatComposerNotices>[0];

function mountComposer(props: Omit<ComposerProps, "messages">) {
  return mountSolid(() => renderChatComposerNotices({ messages: [], ...props })).container;
}

function publishedNotices<P extends object>(Notices: (props: P) => JSX.Element, initial: P) {
  const [props, publish] = createSignal(initial);
  return { ...mountSolid(() => <Notices {...props()} />), publish };
}
const publishedComposer = (initial: ComposerProps) =>
  publishedNotices(renderChatComposerNotices, initial);
const failedPlacement = (error: string) => ({
  sessionKey: "agent:main:failed-start",
  phase: "failed" as const,
  startedAt: 1,
  retryable: false,
  error,
});

afterEach(() => {
  document.body.replaceChildren();
});

it.each([
  [
    "transferring",
    25 * 1_024 * 1_024,
    "Updating worker runtime · 25 MB of 100 MB (25%)",
    "Transferring the new worker runtime to this device: 25 MB of 100 MB (25%). The next turn starts when it finishes.",
  ],
  [
    "installing",
    100 * 1_024 * 1_024,
    "Installing worker runtime",
    "Installing the new worker runtime on this device.",
  ],
] as const)(
  "renders worker runtime progress for %s at %s bytes",
  (phase, transferredBytes, title, body) => {
    const { container, publish } = publishedNotices<Parameters<typeof renderChatTopbarNotices>[0]>(
      renderChatTopbarNotices,
      {
        workerRuntimeInstall: {
          phase,
          transferredBytes,
          totalBytes: 100 * 1_024 * 1_024,
          startedAtMs: 1,
          updatedAtMs: 2,
        },
      },
    );
    const notice = container.querySelector(".chat-worker-runtime-install-notice");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.querySelector("strong")).toMatchObject({ textContent: title });
    expect(notice).toMatchObject({ title: body });
    expect(notice?.textContent).toContain(body);

    publish({});
    flush();
    expect(container.querySelector(".chat-worker-runtime-install-notice")).toBeNull();
  },
);

it.each([
  ["buffering", "status", "OpenAI is reviewing this response for cyber safety."],
  ["blocked", "alert", "OpenAI blocked this response under its cyber policy."],
  ["fallback", "status", `OpenAI routed this response to ${unsafeModel}.`],
  ["escalated", "status", `OpenAI declined this request; retried on ${unsafeModel}.`],
  ["unavailable", "alert", `OpenAI declined this request; ${unsafeModel} is not authorized.`],
] as const)("renders %s provider notice as plain text", (state, role, copy) => {
  const { container, publish } = publishedComposer({
    messages: [],
    providerPolicyNotice: {
      runId: "run-1",
      seq: 1,
      state,
      model: "original-model",
      fallbackModel: unsafeModel,
    },
  });
  const notice = container.querySelector(".chat-provider-policy-notice");
  expect(notice?.getAttribute("role")).toBe(role);
  expect(notice?.textContent).toContain(copy);
  expect(notice?.querySelector("img, button")).toBeNull();

  publish({ messages: [] });
  flush();
  expect(container.querySelector(".chat-provider-policy-notice")).toBeNull();
});

it("retains the provider notice across unrelated pane publications", () => {
  const providerPolicyNotice = { runId: "run-1", seq: 1, state: "buffering" as const };
  const { container, publish } = publishedComposer({ messages: [], providerPolicyNotice });
  const notice = container.querySelector(".chat-provider-policy-notice");
  expect(notice).not.toBeNull();
  for (const messages of [[], [{ role: "assistant", content: "Updated history" }]]) {
    publish({ messages, providerPolicyNotice });
    flush();
    expect(container.querySelector(".chat-provider-policy-notice")).toBe(notice);
    expect(notice?.getAttribute("role")).toBe("status");
  }
});

it("offers an explicit discard action with the full warning when unsaved starts block recovery", () => {
  const discardAndReload = vi.fn();
  const retry = vi.fn();
  const container = mountComposer({
    placementStartup: {
      ...failedPlacement(t("newSession.placementReloadBlocked")),
      discardAndReload,
    },
    onRetrySessionPlacementStartup: retry,
  });

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.querySelector("details")).toBeNull();
  expect(alert?.textContent).toContain("Recovery needs a reload. Unsaved starts will be lost.");
  const action = [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Discard unsaved starts and reload",
  );
  expect(action).toBeDefined();
  expect(discardAndReload).not.toHaveBeenCalled();

  action?.click();

  expect(discardAndReload).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
});

it.each([
  { contention: false, connected: true },
  { contention: false, connected: false },
  { contention: true, connected: true },
  { contention: true, connected: false },
])(
  "refreshes errors without retrying (contention=$contention, connected=$connected)",
  ({ contention, connected }) => {
    const onRefresh = vi.fn(),
      onRetrySessionPlacementStartup = vi.fn();
    const diagnostic = contention
      ? "Temporarily busy. Check status before trying again.\nState contention: session store; attempts exhausted.\n<img src=x onerror=alert(1)>"
      : "The conversation changed before your message could run.";
    const container = mountComposer({
      connected,
      runError: {
        ...(contention ? { kind: "state_contention" as const } : {}),
        summary: diagnostic,
      },
      onRefresh,
      ...(contention ? { onRetrySessionPlacementStartup } : {}),
    });
    const notice = container.querySelector(".chat-error");
    if (contention) {
      expect(notice?.classList.contains("chat-composer-neighbor-card--warn")).toBe(true);
      expect(notice?.classList.contains("chat-composer-neighbor-card--danger")).toBe(false);
      expect(notice?.getAttribute("role")).toBe("status");
      const details = notice?.querySelector("details");
      expect(details).toMatchObject({ open: false });
      expect(details?.querySelector("strong")?.textContent).toBe(
        "OpenClaw is busy. Check status before trying again.",
      );
      expect(details?.querySelector("pre")?.textContent).toBe(diagnostic);
      expect(notice?.querySelector("img")).toBeNull();
    }
    const action = notice?.querySelector<HTMLButtonElement>(".chat-error__refresh");
    expect(action).not.toBeNull();
    expect(action).toMatchObject({ disabled: !connected });
    expect(action?.textContent?.trim()).toBe(contention ? "Check status" : "Refresh");
    action?.click();
    expect(onRefresh).toHaveBeenCalledTimes(connected ? 1 : 0);
    if (contention) {
      expect(onRetrySessionPlacementStartup).not.toHaveBeenCalled();
    }
  },
);

it.each(["run", "placement"] as const)("preserves expanded diagnostics and focus (%s)", (kind) => {
  const diagnostic = "Synthetic failure\n  at workspace/session.ts:42";
  const initial: Parameters<typeof renderChatComposerNotices>[0] = {
    messages: [],
    runError: kind === "run" ? { summary: diagnostic } : undefined,
    placementStartup: kind === "placement" ? failedPlacement(diagnostic) : undefined,
  };
  const { container, publish } = publishedComposer(initial);
  const details = container.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  details.open = true;
  summary.focus();
  for (const messages of [[], [{ role: "assistant", content: "Updated history" }]]) {
    publish({
      ...initial,
      messages,
      runError: initial.runError && { ...initial.runError },
      placementStartup: initial.placementStartup && { ...initial.placementStartup },
    });
    flush();
    expect(container.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary);
    expect(details.querySelector("pre")?.textContent).toBe(
      kind === "run" ? diagnostic : t("newSession.placementStartFailed", { error: diagnostic }),
    );
  }
});
