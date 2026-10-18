/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseApprovalRequestedEvent,
  resolveApprovalRequest,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
} from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  ExecApprovalCard,
  SidebarApprovalRow,
  type ExecApprovalCardProps,
} from "./exec-approval-card-solid.tsx";

let container: HTMLDivElement;

function approval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "plugin",
    request: {
      command: "Codex approval",
      agentId: "main",
      sessionKey: "agent:main:session-1",
    },
    pluginTitle: "Codex approval",
    pluginDescription: "Command: pnpm test",
    pluginId: "codex",
    createdAtMs: 1,
    expiresAtMs: 61_000,
    ...overrides,
  };
}

function plugin(request: Record<string, unknown>, live = false) {
  const now = live ? Date.now() : 1;
  const result = parseApprovalRequestedEvent("plugin.approval.requested", {
    id: "plugin",
    request,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  });
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error("Plugin approval event was not parsed");
  }
  return result;
}

function renderSurface(
  request: ExecApprovalRequest,
  variant: "inline" | "modal" | "sidebar" = "modal",
  onDecision: ExecApprovalCardProps["onDecision"] = vi.fn(),
  presentation?: "mobile",
) {
  const props = { approval: request, busy: false, connected: true, canGrant: true, error: null };
  const view = mountSolid(
    () =>
      variant === "sidebar"
        ? createComponent(SidebarApprovalRow, {
            ...props,
            onDecision: (_event, id, decision) => void onDecision(id, decision),
          })
        : createComponent(ExecApprovalCard, {
            props: { ...props, variant, presentation, onDecision },
          }),
    { container },
  );
  return { ...view, card: container.querySelector<HTMLElement>(".exec-approval-card") };
}

function renderCard(
  request: ExecApprovalRequest,
  variant: "inline" | "modal" = "modal",
  presentation?: "mobile",
) {
  return renderSurface(request, variant, undefined, presentation).card;
}

describe("exec approval card", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps plugin error severity to the danger accent", () => {
    const card = renderCard(approval({ pluginSeverity: "error" }));
    expect(card?.classList.contains("exec-approval-card--severity-danger")).toBe(true);
  });

  it("expires a mounted sidebar approval and disables its decisions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(0);
    const onDecision = vi.fn();
    const view = renderSurface(approval({ expiresAtMs: 2_000 }), "sidebar", onDecision);
    const timer = view.getByRole("timer");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(timer.getAttribute("aria-label")).toBe("expires in 00:02");
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    flush();
    expect(timer).toMatchObject({ textContent: "00:00", title: "expired" });
    expect(timer.getAttribute("aria-label")).toBe("expired");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    for (const button of buttons) {
      button.click();
    }
    expect(onDecision).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves command text while highlighting ordered, non-overlapping valid spans", () => {
    const command = "echo hello | cat";
    const card = renderCard(
      approval({
        kind: "exec",
        request: {
          command,
          commandSpans: [
            { startIndex: 13, endIndex: 16 },
            { startIndex: 0, endIndex: 2 },
            { startIndex: 0, endIndex: 4 },
            { startIndex: 3, endIndex: 7 },
            { startIndex: 5, endIndex: 10 },
            { startIndex: -1, endIndex: 1 },
            { startIndex: 11, endIndex: 11 },
            { startIndex: 12, endIndex: 99 },
          ],
        },
      }),
    );
    expect(card?.querySelector(".exec-approval-command")?.textContent).toBe(command);
    expect(Array.from(card?.querySelectorAll("mark") ?? [], (mark) => mark.textContent)).toEqual([
      "echo",
      "hello",
      "cat",
    ]);
  });

  it.each(["modal", "sidebar"] as const)(
    "uses plugin decision action labels and resolves their original decisions in the %s surface",
    async (variant) => {
      const request = plugin(
        {
          title: "Allow parts.search?",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          actions: [
            { kind: "decision", decision: "allow-once", label: "Allow once", command: "" },
            {
              kind: "decision",
              decision: "allow-always",
              label: "Allow while this App is open",
              command: "",
            },
            { kind: "command", decision: "deny", label: "Run a command", command: "status" },
            { kind: "decision", decision: "deny", label: "Deny", command: "" },
          ],
        },
        true,
      );
      const client = { request: vi.fn(async () => ({})) };
      const onDecision = vi.fn((id: string, decision: ExecApprovalDecision) => {
        expect(id).toBe(request.id);
        return resolveApprovalRequest(client, request, decision);
      });
      renderSurface(request, variant, onDecision);
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Allow once",
        "Allow while this App is open",
        "Deny",
      ]);
      for (const button of buttons) {
        button.click();
      }
      await Promise.all(onDecision.mock.results.map((result) => result.value));
      expect(client.request.mock.calls).toEqual([
        ["plugin.approval.resolve", { id: request.id, decision: "allow-once" }],
        ["plugin.approval.resolve", { id: request.id, decision: "allow-always" }],
        ["plugin.approval.resolve", { id: request.id, decision: "deny" }],
      ]);
    },
  );

  it("shows the full plugin request detail as plain text in the modal card", () => {
    const detail = `  Command: pnpm test\n${"review context\n".repeat(700)}<script>blocked()</script>`;
    const request = plugin({ title: "Review command", description: "Run the test suite", detail });
    const card = renderCard(request);
    const previews = Array.from(card?.querySelectorAll("pre") ?? []);
    expect(previews.map((preview) => preview.textContent)).toEqual(["Run the test suite", detail]);
    expect(previews[1]?.closest("details")).toBeNull();
    expect(card?.querySelector("script")).toBeNull();
  });

  it("labels an approval projected from a child session", () => {
    const card = renderCard(approval({ sourceSessionKey: "agent:main:cloud-child" }), "inline");
    expect(card?.textContent).toContain("Approval requested by session cloud-child");
  });

  it("keeps host and cwd visible while collapsing lower-value exec metadata", () => {
    const card = renderCard(
      approval({
        kind: "exec",
        request: {
          command: "pnpm test",
          host: "gateway",
          cwd: "/workspace",
          resolvedPath: "/usr/bin/pnpm",
          security: "allowlist",
          ask: "on-request",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      }),
      "inline",
    );
    const details = card?.querySelector<HTMLDetailsElement>(".exec-approval-details");
    expect(card?.querySelector(".exec-approval-meta")?.textContent).toContain("gateway");
    expect(card?.querySelector(".exec-approval-meta")?.textContent).toContain("/workspace");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Resolved");
    expect(details?.textContent).toContain("Security");
    expect(details?.textContent).toContain("Ask");
    expect(card?.querySelector('[data-approval-chip="agent"]')).toBeNull();
    expect(card?.textContent).not.toContain("agent:main:session-1");
  });

  it("discloses mobile requests without deciding, retains updates and resets for the next request", () => {
    const onDecision = vi.fn();
    const command = "printf '%s\\n' 'a long command that must remain completely readable'";
    const request = approval({
      kind: "exec",
      request: { command, host: "gateway", cwd: "/workspace/project" },
      expiresAtMs: Date.now() + 60_000,
    });
    const [props, setProps] = createSignal<ExecApprovalCardProps>({
      approval: request,
      variant: "inline",
      presentation: "mobile",
      busy: false,
      connected: true,
      canGrant: true,
      error: null,
      onDecision,
    });
    const view = mountSolid(
      () =>
        createComponent(ExecApprovalCard, {
          get props() {
            return props();
          },
        }),
      { container },
    );
    const disclosure = container.querySelector<HTMLDetailsElement>("details")!;
    expect(disclosure.open).toBe(false);
    expect(view.getByRole("timer").textContent).toContain("expires in");
    expect(view.getByText("Run this command?")).toBeTruthy();
    disclosure.querySelector("summary")!.click();
    expect(disclosure.open).toBe(true);
    expect(view.getByText(command)).toBeTruthy();
    expect(view.getByText("Directory")).toBeTruthy();
    expect(view.getByText("/workspace/project")).toBeTruthy();
    expect(onDecision).not.toHaveBeenCalled();

    setProps({ ...props(), approval: { ...request }, busy: true });
    flush();
    expect(container.querySelector("details")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    const allow = view.getByRole<HTMLButtonElement>("button", { name: "Allow once" });
    expect(allow.disabled).toBe(true);
    allow.click();
    expect(onDecision).not.toHaveBeenCalled();

    setProps({ ...props(), busy: false, error: "Approval failed: connection lost" });
    flush();
    expect(view.getByRole("alert").textContent).toBe("Approval failed: connection lost");
    allow.click();
    expect(onDecision).toHaveBeenCalledExactlyOnceWith("approval-1", "allow-once");

    setProps({ ...props(), approval: { ...request, id: "approval-2" }, canGrant: false });
    flush();
    expect(container.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    expect(view.getByRole<HTMLButtonElement>("button", { name: "Allow once" }).disabled).toBe(true);
  });

  it.each([
    [undefined, undefined, ["Always allow", "Deny", "Allow once"]],
    [undefined, "always", ["Deny", "Allow once"]],
    [["deny", "allow-once"], undefined, ["Deny", "Allow once"]],
  ] as const)(
    "keeps native mobile eligibility for decisions %j and ask %s",
    (allowed, ask, labels) => {
      const card = renderCard(
        approval({
          kind: "exec",
          request: { command: "echo review", allowedDecisions: allowed && [...allowed], ask },
        }),
        "inline",
        "mobile",
      );
      expect(
        Array.from(card!.querySelectorAll("button"), (button) => button.textContent?.trim()),
      ).toEqual(labels);
      expect(card!.textContent).not.toContain("Allow Always is unavailable");
      expect(card!.querySelectorAll("summary")).toHaveLength(1);
    },
  );

  it.each(["modal", "plugin"] as const)(
    "ignores the mobile opt-in for the %s presentation",
    (surface) => {
      const card = renderCard(
        surface === "modal"
          ? approval({ kind: "exec", request: { command: "echo modal" } })
          : approval(),
        surface === "modal" ? "modal" : "inline",
        "mobile",
      );
      expect(card!.textContent).toContain(
        surface === "modal" ? "Exec approval needed" : "Codex approval",
      );
      if (surface === "modal") {
        expect(card!.textContent).toContain("Always allow here");
      } else {
        expect(card!.querySelector("details")).toBeNull();
      }
    },
  );
});
