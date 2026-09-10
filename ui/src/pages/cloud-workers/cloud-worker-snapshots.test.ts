/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness, deferred } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";
import "./cloud-workers-page.ts";

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: confirm }));

function button(container: Element, label: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    ),
    label,
  );
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  confirm.mockClear();
});

function mountPage(
  methods: string[],
  options: {
    response?: (method: string) => unknown;
    scopes?: string[];
  } = {},
) {
  const request = vi.fn(async (method: string) => {
    const response = options.response?.(method);
    if (response !== undefined) {
      return response;
    }
    if (method === "environments.list") {
      return { environments: [] };
    }
    if (method === "projects.list") {
      return {
        projects: [
          { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
        ],
      };
    }
    if (method === "worktrees.list") {
      return { worktrees: [] };
    }
    if (method === "environments.prepare") {
      return { environmentId: "build-app", preparationKey: "build-key", reused: false };
    }
    if (method === "environments.destroy") {
      return {};
    }
    if (method === "config.get") {
      return {
        config: {},
        sourceConfig: {},
        raw: "{}",
        hash: "snapshot-config",
        valid: true,
        issues: [],
      };
    }
    if (method === "crabbox.images.list") {
      return snapshotListFixture();
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const harness = createGatewayHarness(client);
  harness.publish(true, client, gatewayHelloForMethods(methods, options.scopes));
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const context = {
    gateway: harness.gateway,
    runtimeConfig,
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-cloud-workers-page");
  provider.append(page);
  document.body.append(provider);
  return {
    page,
    request,
    harness,
    client,
    dispose: () => {
      provider.remove();
      runtimeConfig.dispose();
    },
  };
}

describe("Cloud worker snapshots", () => {
  it("keeps the segment discoverable without calling an unadvertised plugin method", async () => {
    const fixture = mountPage([]);
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      button(fixture.page, "Snapshots").click();
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain(
          "Snapshots are available when the Crabbox worker provider is enabled and the Gateway advertises them.",
        ),
      );
      expect(
        [...fixture.page.querySelectorAll("button")].some(
          (entry) => entry.textContent?.trim() === "Refresh",
        ),
      ).toBe(false);
      expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
    } finally {
      fixture.dispose();
    }
  });

  it("loads on entry, groups old and current records, and refreshes only on request", async () => {
    const fixture = mountPage(["crabbox.images.list", "crabbox.images.recover"]);
    try {
      await waitForFast(() =>
        expect(fixture.page.textContent).toContain("No cloud worker profiles"),
      );
      expect(fixture.request).not.toHaveBeenCalledWith("crabbox.images.list", expect.anything());
      button(fixture.page, "Snapshots").click();
      await waitForFast(() => expect(fixture.page.textContent).toContain("github.com/acme/app"));
      const snapshots = expectDefined(
        fixture.page.querySelector("openclaw-cloud-worker-snapshots"),
        "Snapshots view",
      );
      const groups = [...snapshots.querySelectorAll(".settings-section")];
      const build = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("linux-build")),
        "Build group",
      );
      expect(build.textContent).toContain("aws · standard, burst · linux · Warm images on");
      expect(build.querySelectorAll(".settings-row")).toHaveLength(2);
      const projectRow = expectDefined(
        [...build.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("github.com/acme/app"),
        ),
        "Project snapshot with pending predecessor deletion",
      );
      expect(projectRow.textContent).toContain("Available");
      expect(projectRow.textContent).toContain("Checkpoint deletion pending");
      expect(projectRow.textContent).toContain("image-app-predecessor");
      expect(projectRow.textContent).toContain(
        "Cleanup retries during the next warm-image capture or worker teardown.",
      );
      expect(projectRow.querySelector("button")).toBeNull();
      const retiringRow = expectDefined(
        [...snapshots.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("github.com/acme/retiring"),
        ),
        "Snapshot awaiting deletion",
      );
      expect(retiringRow.textContent).toContain("Retiring");
      expect(retiringRow.textContent).toContain("Checkpoint deletion pending");
      expect(retiringRow.textContent).toContain("image-retiring");
      expect(retiringRow.textContent).not.toContain("Available");
      expect(retiringRow.querySelector("button")).toBeNull();
      expect(build.textContent).toContain("Building: creating");
      expect(build.textContent).toContain("Machine image");
      const machineRow = expectDefined(
        [...build.querySelectorAll(".settings-row")].find((row) =>
          row.textContent?.includes("Machine image"),
        ),
        "Machine snapshot row",
      );
      expect(machineRow.textContent).toContain("aws · burst");
      expect(machineRow.textContent).not.toContain("Created");
      expect(machineRow.textContent).not.toContain("Last used");
      expect(machineRow.textContent).not.toContain("Runtime:");
      for (const row of snapshots.querySelectorAll(".settings-row")) {
        expect(row.textContent).not.toContain("Unlabeled");
      }
      expect(build.textContent).toContain("Commit: 01234567");
      expect(build.textContent).toContain("Allocations: 21");
      expect(build.textContent).toContain("Runtime: abcdef012345");
      expect(snapshots.textContent).toContain("Unlabeled profile");
      expect(snapshots.textContent).toContain("Project image");
      const cold = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("cold-build")),
        "Configured profile without snapshots",
      );
      expect(cold.textContent).toContain("aws · standard · linux · Warm images off");
      expect(cold.textContent).not.toContain("Unlabeled");
      const classless = expectDefined(
        groups.find((group) => group.querySelector("h2")?.textContent?.includes("classless-build")),
        "Configured profile without a class",
      );
      expect(classless.textContent).toContain("aws · linux · Warm images off");
      expect(classless.textContent).not.toContain("Unlabeled");
      expect(snapshots.textContent).toContain("Needs migration");
      expect(snapshots.textContent).toContain("openclaw doctor --fix");
      expect(
        [...snapshots.querySelectorAll(".settings-summary dd")].map((entry) => entry.textContent),
      ).toEqual(["2", "1", "1", "4"]);
      expect(
        [...snapshots.querySelectorAll("button")].filter(
          (entry) => entry.textContent?.trim() === "Recover",
        ),
      ).toHaveLength(1);
      button(snapshots, "Refresh").click();
      await waitForFast(() =>
        expect(
          fixture.request.mock.calls.filter(([method]) => method === "crabbox.images.list"),
        ).toHaveLength(2),
      );
    } finally {
      fixture.dispose();
    }
  });
});

const buildMethods = [
  "crabbox.images.list",
  "environments.list",
  "environments.prepare",
  "environments.destroy",
  "projects.list",
  "worktrees.list",
];

function buildFixture(state = "provisioning") {
  return {
    id: "build-app",
    type: "worker",
    status: "starting",
    preparation: { purpose: "build", key: "build-key" },
    worker: {
      profileId: "linux-build",
      providerId: "crabbox",
      leaseId: "lease-app",
      state,
      ageMs: 60_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  };
}

async function openSnapshots(fixture: ReturnType<typeof mountPage>) {
  await waitForFast(() => expect(fixture.page.textContent).toContain("No cloud worker profiles"));
  button(fixture.page, "Snapshots").click();
  await waitForFast(() => expect(fixture.page.querySelector(".settings-summary")).not.toBeNull());
  return expectDefined(
    fixture.page.querySelector("openclaw-cloud-worker-snapshots"),
    "Snapshots view",
  );
}

function select(container: Element, index: number, value: string) {
  const input = expectDefined(container.querySelectorAll("select")[index], "Build selection");
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function openBuild(snapshots: Element) {
  button(snapshots, "Build snapshot").click();
  await waitForFast(() => expect(snapshots.querySelectorAll("option").length).toBeGreaterThan(4));
  return expectDefined(snapshots.querySelector("openclaw-modal-dialog"), "Build dialog");
}

async function chooseBuild(dialog: Element) {
  select(dialog, 0, "linux-build");
  select(dialog, 1, "/projects/app");
  await waitForFast(() => expect(button(dialog, "Build snapshot").disabled).toBe(false));
}

describe("Snapshot builds", () => {
  it.each([false, true])(
    "validates choices and submits the local repository root (reused=%s)",
    async (reused) => {
      const fixture = mountPage(buildMethods, {
        response: (method) => (method === "environments.prepare" ? { reused } : undefined),
      });
      try {
        const snapshots = await openSnapshots(fixture);
        const dialog = await openBuild(snapshots);
        const submit = button(dialog, "Build snapshot");
        expect(submit.disabled).toBe(true);
        const disabledProfile = expectDefined(
          dialog.querySelector<HTMLOptionElement>('option[value="cold-build"]'),
          "Disabled cold profile",
        );
        expect(disabledProfile.disabled).toBe(true);
        expect(disabledProfile.textContent).toContain("Warm images are explicitly disabled.");
        select(dialog, 0, "linux-build");
        await Promise.resolve();
        expect(submit.disabled).toBe(true);
        await chooseBuild(dialog);
        submit.click();
        await waitForFast(() =>
          expect(snapshots.textContent).toContain(
            reused ? "Reusing the build already in progress" : "Build started",
          ),
        );
        expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
          profileId: "linux-build",
          projectPath: "/projects/app",
        });
        expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull();
      } finally {
        fixture.dispose();
      }
    },
  );

  it("keeps a pending build dialog open and displays its eventual error", async () => {
    const pending = deferred<{ reused: boolean }>();
    const fixture = mountPage(buildMethods, {
      response: (method) => (method === "environments.prepare" ? pending.promise : undefined),
    });
    try {
      const snapshots = await openSnapshots(fixture);
      const dialog = await openBuild(snapshots);
      await chooseBuild(dialog);
      button(dialog, "Build snapshot").click();
      await waitForFast(() => expect(button(dialog, "Cancel").disabled).toBe(true));
      const dismiss = new CustomEvent("modal-cancel", { cancelable: true, bubbles: true });
      dialog.dispatchEvent(dismiss);
      expect(dismiss.defaultPrevented).toBe(true);
      pending.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Preparation failed",
          details: { code: "capacity" },
        }),
      );
      await waitForFast(() => expect(dialog.textContent).toContain("Raise the prepared pool cap"));
      expect(button(dialog, "Cancel").disabled).toBe(false);
      dialog.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true, bubbles: true }));
      await waitForFast(() => expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull());
    } finally {
      pending.resolve({ reused: false });
      fixture.dispose();
    }
  });

  it.each([
    ["capacity", "Raise the prepared pool cap or destroy an unused worker"],
    ["invalid_project", "accessible local Git checkout root with a HEAD commit"],
    ["invalid_profile", "does not support project preparation"],
    ["profile_not_found", "does not support project preparation"],
  ])("keeps %s errors inline with a recovery action", async (code, message) => {
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.prepare") {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Preparation failed",
            details: { code },
          });
        }
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      const dialog = await openBuild(snapshots);
      await chooseBuild(dialog);
      button(dialog, "Build snapshot").click();
      await waitForFast(() =>
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(message),
      );
      expect(button(dialog, "Build snapshot").disabled).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it.each([true, false])(
    "rebuilds project roots independently of optional labels (label=%s)",
    async (hasLabel) => {
      const images = snapshotListFixture();
      const project = expectDefined(images.images[0], "Project snapshot");
      const fixture = mountPage(buildMethods, {
        response: (method) =>
          method === "crabbox.images.list"
            ? {
                ...images,
                images: [
                  {
                    ...project,
                    projectLabel: hasLabel ? project.projectLabel : undefined,
                    projectRoot: "/projects/app",
                  },
                  ...images.images.slice(1),
                ],
              }
            : undefined,
      });
      try {
        const snapshots = await openSnapshots(fixture);
        expect(
          [...snapshots.querySelectorAll("button")].filter(
            (entry) => entry.textContent?.trim() === "Rebuild",
          ),
        ).toHaveLength(1);
        button(snapshots, "Rebuild").click();
        await waitForFast(() =>
          expect(fixture.request).toHaveBeenCalledWith("environments.prepare", {
            profileId: "linux-build",
            projectPath: "/projects/app",
          }),
        );
      } finally {
        fixture.dispose();
      }
    },
  );

  it("groups active builds, deduplicates captures, polls both lists, and stops after readiness", async () => {
    let builds = [buildFixture()];
    const result = snapshotListFixture();
    const images = result.images.map((image) =>
      image.capture?.phase === "creating"
        ? { ...image, capture: { ...image.capture, leaseId: "lease-app" } }
        : image,
    );
    const fixture = mountPage(buildMethods, {
      response: (method) =>
        method === "environments.list"
          ? { environments: builds }
          : method === "crabbox.images.list"
            ? { ...result, images }
            : undefined,
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const snapshots = await openSnapshots(fixture);
      const group = expectDefined(
        [...snapshots.querySelectorAll(".settings-section")].find((entry) =>
          entry.querySelector("h2")?.textContent?.includes("linux-build"),
        ),
        "Build profile group",
      );
      expect(group.textContent).toContain("build-app");
      expect(group.textContent).toContain("Provisioning");
      expect(group.textContent).toContain("Age: 1m");
      expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("1");
      const imageCalls = () =>
        fixture.request.mock.calls.filter(([method]) => method === "crabbox.images.list").length;
      const environmentCalls = () =>
        fixture.request.mock.calls.filter(([method]) => method === "environments.list").length;
      const before = environmentCalls();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(imageCalls()).toBe(2);
      expect(environmentCalls()).toBe(before + 1);
      builds = [buildFixture("ready")];
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots.textContent).not.toContain("build-app");
      expect(imageCalls()).toBe(3);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(imageCalls()).toBe(3);
      button(snapshots, "Refresh").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(imageCalls()).toBe(4);
      expect(environmentCalls()).toBe(before + 3);
    } finally {
      fixture.dispose();
    }
  });

  it("counts distinct captures and build environments and cancels by environment ID", async () => {
    let environments = [buildFixture()];
    const fixture = mountPage(buildMethods, {
      response: (method) => {
        if (method === "environments.list") {
          return { environments };
        }
        if (method === "environments.destroy") {
          environments = [];
          return {};
        }
        return undefined;
      },
    });
    try {
      const snapshots = await openSnapshots(fixture);
      expect(snapshots.querySelectorAll(".settings-summary dd")[1]?.textContent).toBe("2");
      button(snapshots, "Cancel").click();
      await waitForFast(() => expect(snapshots.textContent).toContain("Build canceled"));
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cancel build", details: "build-app" }),
      );
      expect(fixture.request).toHaveBeenCalledWith("environments.destroy", {
        environmentId: "build-app",
      });
      expect(snapshots.textContent).not.toContain("build-app");
    } finally {
      fixture.dispose();
    }
  });

  it("hides build actions without advertisement and clears a pending picker on disconnect", async () => {
    const fixture = mountPage(["crabbox.images.list"]);
    try {
      const snapshots = await openSnapshots(fixture);
      expect(snapshots.textContent).not.toContain("Build snapshot");
      fixture.harness.publish(true, fixture.client, gatewayHelloForMethods(buildMethods));
      await waitForFast(() => expect(snapshots.textContent).toContain("Build snapshot"));
      await openBuild(snapshots);
      fixture.harness.publish(false, fixture.client);
      await waitForFast(() => expect(snapshots.querySelector("openclaw-modal-dialog")).toBeNull());
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "environments.prepare"),
      ).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });
});
