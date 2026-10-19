import { createComponent, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { PaneDetails } from "../chat-pane-header-view.tsx";
import "./chat-details.tsx";

afterEach(cleanupSolid);

it("keeps Details in the mobile host through opening, parking, and returning", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  let updateHost!: (patch: Partial<ChatMobileHost>) => void;
  const close = vi.fn();
  const navigate = vi.fn();
  const view = mountSolid(() => {
    const [host, setHost] = createSignal<ChatMobileHost>({
      scopeKey: "details-mobile",
      open: true,
      suspended: false,
      mode: "dock",
      height: 280,
      reservedHeight: 280,
      destination: { area: "details" },
      detailsMount: target,
      setDetailsMount() {},
      navigate,
      reveal() {},
      close,
      back() {},
      toggleExpanded() {},
      resize() {},
      keyboardVisible: false,
      onComposerEditingChange() {},
      onViewportChange() {},
    });
    updateHost = (patch) => setHost((previous) => ({ ...previous, ...patch }));
    return createComponent(PaneDetails, {
      chat: {
        sessionKey: "agent:main:details-mobile",
        currentAgentId: "main",
        selectedSession: { key: "agent:main:details-mobile", kind: "direct" },
        messages: [],
        gatewayScope: {},
        detailsWorkspace: { root: "/workspace/mobile", label: "mobile" },
      },
      elements: undefined,
      mobile: true,
      get mobileHost() {
        return host();
      },
      presentation: true,
      setRef() {},
    });
  });
  try {
    const element = view.container.querySelector("openclaw-chat-details")!;
    await element.updateComplete;
    flush();
    const panel = target.querySelector<HTMLElement>(".chat-details")!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(false);
    expect(panel.matches(":popover-open")).toBe(false);
    expect(panel.querySelector(".chat-details__toolbar")).toBeNull();
    await expect.poll(() => panel.querySelector(".chat-details-session")).not.toBeNull();
    const content = panel.firstElementChild;
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();

    updateHost({ open: false });
    flush();
    expect(panel.hidden).toBe(true);
    updateHost({ open: true, suspended: true });
    flush();
    expect(panel.hidden).toBe(true);
    updateHost({ suspended: false });
    flush();
    expect(panel.hidden).toBe(false);
    expect(panel.firstElementChild).toBe(content);
    expect(target.querySelectorAll(".chat-details")).toHaveLength(1);
    element.open(document.body);
    expect(navigate).toHaveBeenCalledWith({ area: "details" }, document.body);
  } finally {
    target.remove();
  }
});
