/* @vitest-environment jsdom */
import type { JSX } from "@solidjs/web";
import { createSignal, flush, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { currentThemeBranding, setCurrentThemeBranding } from "../app/theme-branding.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { resolveIdentityAvatarView, type AgentIdentity } from "../lib/identity-avatar-view.ts";
import type { IdentityAvatarInput } from "../lib/identity-avatar.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import {
  IdentityAvatarImage,
  createIdentityAvatarPresentation,
} from "./solid/identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./solid/identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./solid/identity-avatar.tsx";

const imageResponse = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });

function mountAvatar<T>(initial: T, render: (value: () => T) => JSX.Element, frameClass: string) {
  const [input, setInput] = createSignal(initial);
  const [presented, setPresented] = createSignal(true);
  const mounted = mountSolid(() => <Show when={presented()}>{render(input)}</Show>);
  return {
    ...mounted,
    image: () => mounted.container.querySelector<HTMLImageElement>("img"),
    frame: () => mounted.container.querySelector(frameClass),
    update: (next: T) => {
      setInput(() => next);
      flush();
    },
    present: (next: boolean) => {
      setPresented(next);
      flush();
    },
    loaded: (src: string) =>
      vi.waitFor(() =>
        expect(mounted.container.querySelector("img")?.getAttribute("src")).toBe(src),
      ),
  };
}
const mountImage = (identity: IdentityAvatarInput) =>
  mountAvatar(identity, (value) => <ProfileImage identity={value()} />, ".test-avatar");
const mountAgent = (agent: AgentIdentity) =>
  mountAvatar(agent, (value) => <AgentIdentityAvatar agent={value()} />, ".identity-avatar--agent");

function profile(revision = 1, name = "Ada Lovelace") {
  return {
    id: "profile-ada",
    name,
    profileAvatarUrl: `/api/users/profile-ada/avatar?v=${revision}`,
  };
}

function ProfileImage(props: { identity: IdentityAvatarInput }) {
  const view = useIdentityAvatarView(() => props.identity);
  const presentation = createIdentityAvatarPresentation(view);
  return (
    <span class={["test-avatar", presentation.classes()]} data-avatar-state={presentation.state()}>
      <IdentityAvatarImage
        view={view()}
        onStateChange={presentation.onStateChange}
        class="test-avatar__image"
        alt="Ada Lovelace"
        ariaHidden
      />
    </span>
  );
}

afterEach(() => {
  cleanupSolid();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
});

describe("shared identity avatar view", () => {
  it.each(["profile", "agent"] as const)(
    "refreshes a mounted %s image when Gateway credentials change",
    async (kind) => {
      setAvatarGatewayOrigin("https://gateway.example.test", ["old-token"]);
      const fetchAvatar = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => imageResponse());
      vi.spyOn(URL, "createObjectURL")
        .mockReturnValueOnce("blob:old-identity")
        .mockReturnValueOnce("blob:new-identity");
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      const url = kind === "profile" ? "/api/users/ada/avatar" : "/avatar/ada";
      const view =
        kind === "profile"
          ? mountImage({ id: "ada", name: "Ada", profileAvatarUrl: url })
          : mountAgent({ id: "ada", name: "Ada", avatar: url, textAvatar: "A" });
      await view.loaded("blob:old-identity");
      const image = view.image();
      setAvatarGatewayOrigin("https://gateway.example.test", ["new-token"]);
      await view.loaded("blob:new-identity");
      expect(view.image()).toBe(image);
      expect(revoke).toHaveBeenCalledWith("blob:old-identity");
      expect(fetchAvatar).toHaveBeenLastCalledWith(
        `https://gateway.example.test${url}`,
        expect.objectContaining({ headers: { Authorization: "Bearer new-token" } }),
      );
    },
  );

  it("keeps hostile origins out of the authenticated renderer", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    const view = resolveIdentityAvatarView({
      id: "profile-mallory",
      name: "Mallory",
      profileAvatarUrl: "https://evil.example/api/users/profile-mallory/avatar",
    });
    expect(view).toMatchObject({ fallback: { initials: "M" }, imageUrl: null, pending: false });
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("shares authenticated loading and preserves event state on an unchanged source", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(imageResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:shared-identity-avatar");
    const identity = profile(7);
    const view = mountImage(identity);
    expect(view.frame()?.classList.contains("is-pending")).toBe(true);
    expect(view.frame()?.classList.contains("is-fallback")).toBe(false);
    await view.loaded("blob:shared-identity-avatar");
    const image = view.image()!;
    expect(image.getAttribute("alt")).toBe("Ada Lovelace");
    expect(image.getAttribute("aria-hidden")).toBe("true");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(fetchAvatar).toHaveBeenCalledWith(
      "https://gateway.example.test/api/users/profile-ada/avatar?v=7",
      expect.objectContaining({ headers: { Authorization: "Bearer avatar-token" } }),
    );
    image.dispatchEvent(new Event("load"));
    view.update({ ...identity });
    expect(view.image()).toBe(image);
    expect(view.frame()?.getAttribute("data-avatar-state")).toBe("loaded");
    image.dispatchEvent(new Event("error"));
    flush();
    expect(view.frame()?.classList.contains("is-fallback")).toBe(true);
    image.dispatchEvent(new Event("load"));
    flush();
    expect(view.frame()?.classList.contains("is-fallback")).toBe(false);
  });

  it("reuses its image while a newer revision loads", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => imageResponse());
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:identity-avatar-v1")
      .mockReturnValueOnce("blob:identity-avatar-v2");
    const identity = profile();
    const view = mountImage(identity);
    await view.loaded("blob:identity-avatar-v1");
    const first = view.image();
    first?.dispatchEvent(new Event("load"));
    view.update({ ...identity, profileAvatarUrl: "/api/users/profile-ada/avatar?v=2" });
    expect(view.frame()?.classList.contains("is-pending")).toBe(true);
    await view.loaded("blob:identity-avatar-v2");
    expect(view.image()).toBe(first);
    view.image()?.dispatchEvent(new Event("load"));
    expect(view.frame()?.classList.contains("is-fallback")).toBe(false);
  });

  it("does not restore a retired Gateway's image after remount", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["old-token"]);
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockResolvedValue(imageResponse());
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old-gateway");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const view = mountImage({
      id: "profile-ada",
      name: "Ada",
      profileAvatarUrl: "https://gateway.example.test/api/users/profile-ada/avatar?v=1",
    });
    await view.loaded("blob:old-gateway");
    view.present(false);
    setAvatarGatewayOrigin("https://replacement.example.test", ["new-token"]);
    view.present(true);
    expect(view.image()?.getAttribute("src")).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:old-gateway");
    expect(fetchAvatar).toHaveBeenCalledOnce();
  });

  it("retains pending images independently through replacement and remount under pressure", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const avatar = createDeferred<Response>();
    const pressure = createDeferred<Response>();
    let requests = 0;
    const fetchAvatar = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/avatar/pending-")) {
        return pressure.promise;
      }
      return ++requests === 1 ? avatar.promise : Promise.resolve(imageResponse());
    });
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:view-${sequence++}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const identity = profile(1, "Ada");
    const first = mountImage(identity);
    const second = mountImage(identity);
    const pressureLoads = Array.from({ length: 128 }, (_, index) =>
      Promise.resolve(resolveAvatarImageUrl(`/avatar/pending-${index}?v=1`)),
    );
    first.unmount();
    avatar.resolve(imageResponse());
    try {
      await second.loaded("blob:view-0");
      second.image()?.dispatchEvent(new Event("load"));
      expect(revoke).not.toHaveBeenCalledWith("blob:view-0");
      second.present(false);
      expect(revoke).toHaveBeenCalledWith("blob:view-0");
      second.present(true);
      await second.loaded("blob:view-1");
      second.update({ ...identity });
      expect(revoke).not.toHaveBeenCalledWith("blob:view-1");
      expect(requests).toBe(2);
      second.update({ ...identity, profileAvatarUrl: "/api/users/profile-ada/avatar?v=2" });
      await second.loaded("blob:view-2");
      expect(revoke).toHaveBeenCalledWith("blob:view-1");
      expect(revoke).not.toHaveBeenCalledWith("blob:view-2");
      expect(fetchAvatar).toHaveBeenCalledTimes(131);
    } finally {
      second.unmount();
      pressure.resolve(new Response(null, { status: 404 }));
      await Promise.all(pressureLoads);
    }
  });
});

describe("shared agent avatar view", () => {
  it("preserves public images through remount without authenticated fetching", () => {
    setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"], "/control");
    const fetchAvatar = vi.spyOn(globalThis, "fetch");
    const view = mountAgent({ id: "main", avatar: "/favicon.svg", textAvatar: "🦀" });
    expect(view.image()?.getAttribute("src")).toBe("/favicon.svg");
    view.present(false);
    view.present(true);
    expect(view.image()?.getAttribute("src")).toBe("/favicon.svg");
    expect(fetchAvatar).not.toHaveBeenCalled();
  });

  it("updates reserved avatars on theme publication without rerendering the host", async () => {
    const previous = currentThemeBranding();
    setCurrentThemeBranding(resolveThemeBranding(undefined));
    const view = mountAgent({ id: "openclaw", name: "Assistant" });
    try {
      expect(view.image()?.getAttribute("src")).toContain("favicon.svg");
      setCurrentThemeBranding(
        resolveThemeBranding({
          brandIcon: "compass",
          artwork: { icons: { compass: { url: "data:image/svg+xml,compass" } } },
        }),
      );
      flush();
      await vi.waitFor(() =>
        expect(view.container.querySelector("openclaw-theme-brand-icon")).not.toBeNull(),
      );
      setCurrentThemeBranding(resolveThemeBranding(undefined));
      flush();
      expect(view.container.querySelector("openclaw-theme-brand-icon")).toBeNull();
      expect(view.image()?.getAttribute("src")).toContain("favicon.svg");
    } finally {
      setCurrentThemeBranding(previous);
    }
  });

  it("hides an existing fallback immediately when an image is configured and restores it on failure", async () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    const response = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockReturnValue(response.promise);
    const view = mountAgent({ id: "hydrated", textAvatar: "🦀" });
    const frame = view.frame();
    expect(frame?.classList.contains("is-fallback")).toBe(true);
    view.update({ id: "hydrated", textAvatar: "🦀", avatar: "/avatar/hydrated" });
    expect(view.frame()).toBe(frame);
    expect(frame?.classList.contains("is-pending")).toBe(true);
    expect(frame?.classList.contains("is-fallback")).toBe(false);
    response.resolve(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(frame?.classList.contains("is-fallback")).toBe(true));
    expect(frame?.getAttribute("data-avatar-state")).toBe("failed");
  });

  it("recognizes cached image decoding across remount without another load event", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
    const view = mountAgent({ id: "cached", avatar: "/avatar/cached" });
    view.present(false);
    view.present(true);
    await Promise.resolve();
    flush();
    expect(view.frame()?.classList.contains("is-pending")).toBe(false);
    expect(view.frame()?.getAttribute("data-avatar-state")).toBe("loaded");
  });

  it("uses the UI mount and build for the system mark with a remote Gateway", () => {
    setAvatarGatewayOrigin("https://gateway.example.test", ["avatar-token"]);
    vi.stubGlobal("__OPENCLAW_CONTROL_UI_BASE_PATH__", "/control");
    document.documentElement.setAttribute("data-openclaw-control-ui-build-id", "build-1");
    try {
      const view = mountAgent({ id: "openclaw" });
      expect(view.image()?.getAttribute("src")).toBe("/control/favicon.svg?v=build-1");
    } finally {
      vi.unstubAllGlobals();
      document.documentElement.removeAttribute("data-openclaw-control-ui-build-id");
    }
  });

  it("does not let pending face artwork replace a hydrated emoji", async () => {
    const view = mountAgent({ id: "hydrating" });
    view.update({ id: "hydrating", textAvatar: "🦀" });
    await vi.dynamicImportSettled();
    expect(
      view.container.querySelector(".identity-avatar__text")?.getAttribute("data-avatar"),
    ).toBe("🦀");
    expect(view.container.querySelector("svg")).toBeNull();
  });
});
