import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import { ControlUiReadiness, type ControlUiCommittedPresentation } from "./control-ui-readiness.ts";

const owners: ControlUiReadiness[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.disconnect();
  }
  vi.unstubAllGlobals();
});

function fixture() {
  const root = document.createElement("openclaw-app");
  const owner = new ControlUiReadiness(root);
  owners.push(owner);
  // The owner reads these runtime contracts; transports and rendering are separate boundaries.
  const runtime = {
    context: {
      gateway: {
        connectionRevision: 1,
        snapshot: { phase: "connected", client: null },
        subscribe: () => () => {},
      },
      sessions: {
        canonicalListRevision: 1,
        state: { result: { sessions: [] }, loading: false },
        subscribe: () => () => {},
      },
      basePath: "",
      config: { current: {} },
    },
    router: {
      subscribe: () => () => {},
      getState: () => ({ status: "success", matches: [], pendingMatches: [] }),
    },
  } as unknown as ApplicationRuntime;
  return { owner, root, runtime };
}

it("does not publish a route commit while its adapter still shows loading", async () => {
  const { owner, runtime, root } = fixture();
  const entered = createDeferredCore();
  owner.connect(runtime, async () => {
    entered.resolve();
    return { kind: "loading", navigationVisible: true };
  });
  owner.commitRoot();
  await entered.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(owner.hook.snapshot().routeReady).toBe(false);
  expect(root.hasAttribute("data-openclaw-ready")).toBe(false);
});

it.each(["resolve", "reject"])(
  "settles a replacement before its retired adapter can %s",
  async (outcome) => {
    const { owner, root, runtime } = fixture();
    const obsolete = createDeferredCore<ControlUiCommittedPresentation>();
    owner.connect(runtime, () => obsolete.promise);
    owner.commitRoot();
    const entered = createDeferredCore();
    owner.connect({ ...runtime }, async () => {
      entered.resolve();
      return { kind: "shell", navigationVisible: false };
    });
    owner.commitRoot();
    const generation = owner.hook.snapshot().generation;
    await entered.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.hook.snapshot().ready).toBe(true);
    expect(root.getAttribute("data-openclaw-ready")).toBe(String(generation));
    if (outcome === "reject") {
      obsolete.reject(new Error("retired renderer"));
    } else {
      obsolete.resolve({ kind: "loading", navigationVisible: true });
    }
    await Promise.resolve();
    expect(owner.hook.snapshot().ready).toBe(true);
    expect(root.getAttribute("data-openclaw-ready")).toBe(String(generation));
  },
);
