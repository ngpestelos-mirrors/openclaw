/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../../packages/gateway-client/src/protocol-request.js";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import type {
  PluginInstallRequest,
  PluginListResult,
  PluginMutationResult,
} from "../../lib/plugins/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickPluginAction,
  createClient,
  createScriptedClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createResult,
  createRuntimeConfigHarness,
  mountPage,
  resetPluginsPageTestState,
  settlePlugins,
} from "./plugins-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});
afterEach(resetPluginsPageTestState);
const enableRequest = { pluginId: "workboard", enabled: true };
const communityPath = "/settings/plugins/community-thing";
const removalWarning = "Some plugin files could not be removed.";
const unavailable = (message: string) => new GatewayRequestError({ code: "UNAVAILABLE", message });
const acknowledgedEnable = (reviewToken: string) => ({
  ...enableRequest,
  acknowledgeCapabilities: { reviewToken },
});
const enabledPlugin = (plugin = createPlugin()) => ({
  ...plugin,
  enabled: true,
  state: "enabled" as const,
});
const mutationResult = (plugin: ReturnType<typeof createPlugin>, restartRequired = true) => ({
  ok: true as const,
  plugin,
  restartRequired,
});

function removablePlugin() {
  return createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    removable: true,
    featured: false,
  });
}

function consentError(reviewToken: string) {
  return new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "Capability consent required",
    details: buildCapabilityConsentErrorDetails({ pluginId: "workboard", reviewToken }),
  });
}

function consentAction(page: HTMLElement) {
  return page.querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] .btn.primary');
}

function methodCalls(request: ReturnType<typeof createClient>["request"], name: string) {
  return request.mock.calls.filter(([method]) => method === name);
}

function scriptedClient(handlers: Record<string, (params: unknown) => unknown>) {
  return createScriptedClient({ "plugins.inspect": () => createInspectResult(), ...handlers });
}

async function mountInventory(
  client: ReturnType<typeof createClient>["client"],
  result: PluginListResult | null = createResult(),
  path = "/settings/plugins/workboard",
  config?: ReturnType<typeof createRuntimeConfigHarness>,
) {
  const harness = createGateway(client);
  return {
    harness,
    ...(await mountPage(
      createContext(harness.gateway, undefined, undefined, config),
      createPluginsRouteData(harness.gateway, result, path),
    )),
  };
}

it("flushes a pending config draft before enabling and refreshes afterward", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let config: Record<string, unknown> = { pending: false };
  let hash = "hash-1";
  const enabled = enabledPlugin();
  const { client } = createClient(async (method, params) => {
    order.push(method);
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash,
        valid: true,
        issues: [],
      };
    }
    if (method === "config.set") {
      config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
      hash = "hash-2";
      return { config, hash };
    }
    if (method === "plugins.setEnabled") {
      config = { ...config, pluginMutation: "enable" };
      hash = "hash-3";
      return mutationResult(enabled);
    }
    if (method === "plugins.inspect") {
      return createInspectResult();
    }
    if (method === "config.schema") {
      return { schema: { type: "object", properties: {} }, uiHints: {} };
    }
    if (method === "plugins.list") {
      return createResult(enabled);
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const harness = createGateway(client);
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  try {
    await runtimeConfig.ensureLoaded();
    const { page } = await mountPage(
      { ...createContext(harness.gateway), runtimeConfig },
      createPluginsRouteData(harness.gateway, createResult(), "/settings/plugins/workboard"),
    );
    await settlePlugins();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    await clickPluginAction(page, "Enable Workboard");
    await waitForSolid(() => expect(order).toContain("plugins.list"));
    expect(order.slice(0, 4)).toEqual([
      "config.set",
      "plugins.setEnabled",
      "config.get",
      "plugins.list",
    ]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      pluginMutation: "enable",
    });
  } finally {
    runtimeConfig.dispose();
  }
});

it("waits for uninstall confirmation and sends nothing when cancelled", async () => {
  const { client, request } = scriptedClient({
    "plugins.inspect": () => createInspectResult({ plugin: removablePlugin() }),
    "plugins.uninstall": () => ({
      ok: true,
      pluginId: "community-thing",
      restartRequired: true,
      removed: ["config entry", "install record"],
      warnings: [removalWarning],
    }),
    "plugins.list": () => createResult(),
  });
  const calls = request.mock.calls;
  const { page, find } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    communityPath,
  );

  const confirmation = deferred<boolean>();
  vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
  await clickPluginAction(page, "Uninstall Community Thing");
  await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
  expect(showConfirmDialog).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Remove Community Thing?",
      danger: true,
    }),
  );
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  confirmation.resolve(false);
  await settlePlugins();
  expect(calls).not.toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);

  await clickPluginAction(page, "Uninstall Community Thing");

  await page.updateComplete;
  await waitForSolid(() => expect(find('[aria-label="Uninstall Community Thing"]')).toBeNull());
  expect(find(".plugins-row-message--success")).toBeNull();
  expect(find(".plugins-row-message--warning")?.textContent).toContain(removalWarning);
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(calls).toContainEqual(["plugins.uninstall", { pluginId: "community-thing" }]);
  expect(calls).toContainEqual(["plugins.list", {}]);
});

it("keeps newer notices when an older uninstall completes", async () => {
  const uninstallResult = deferred<unknown>();
  const enabled = enabledPlugin();
  const { client, request } = scriptedClient({
    "plugins.uninstall": () => uninstallResult.promise,
    "plugins.setEnabled": () => ({
      ok: true,
      plugin: enabled,
      restartRequired: false,
      warnings: ["Enable requires attention."],
    }),
    "plugins.list": () => createResult(enabled),
  });
  const { page, find, harness } = await mountInventory(
    client,
    createResult([createPlugin(), removablePlugin()]),
    communityPath,
  );

  await clickPluginAction(page, "Uninstall Community Thing");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: "community-thing" }),
  );
  page.routeData = createPluginsRouteData(
    harness.gateway,
    createResult([createPlugin(), removablePlugin()]),
    "/settings/plugins/workboard",
  );
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(page.textContent).toContain("Enable requires attention."));

  uninstallResult.resolve({
    ok: true,
    pluginId: "community-thing",
    restartRequired: true,
    removed: ["config entry", "install record", "directory"],
    warnings: ["Old uninstall warning must not replace the newer action."],
  });
  await settlePlugins();
  await page.updateComplete;

  expect(page.textContent).not.toContain(
    "Old uninstall warning must not replace the newer action.",
  );
  expect(page.textContent).not.toContain("Removed Community Thing");
  expect(find(".plugins-row-message--warning")?.textContent).toContain(
    "Enable requires attention.",
  );
});
it("reports rejected artifacts without another confirmation", async () => {
  const installRequest: PluginInstallRequest = {
    source: "official",
    pluginId: "calendar-runtime",
  };
  const available = createPlugin({
    id: "calendar-runtime",
    name: "Calendar Plus",
    origin: "official",
    installed: false,
    state: "not-installed",
    install: installRequest,
  });
  const catalog = createDiscoveryDetail(available);
  catalog.plugin.id = "catalog-calendar-runtime";
  const { client, request } = createScriptedClient({
    "plugins.catalog.get": () => catalog,
    "plugins.install": () => {
      const error = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "The staged plugin changed before installation. Try installing again.",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-runtime",
          reviewToken: "changed-artifact",
        }),
      });
      retainGatewayResponsePayload(error, undefined);
      throw error;
    },
  });
  const { page, find } = await mountInventory(
    client,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );
  await clickPluginAction(page, "Install");
  await waitForSolid(() =>
    expect(find('.plugins-row-message[role="alert"]')?.textContent).toContain(
      "The staged plugin changed before installation.",
    ),
  );
  expect(find("[data-plugin-consent]")).toBeNull();
  expect(find('.plugins-row-message[role="alert"]')?.textContent).toContain(
    "Resolve the reported issue, then select Retry install to try again.",
  );
  expect(methodCalls(request, "plugins.install")).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method === "plugins.inspect")).toBe(false);
});

it("requires fresh inspection and acknowledgement when a reviewed capability surface changes", async () => {
  const plugin = createPlugin({ origin: "global" });
  const updated = enabledPlugin(plugin);
  const inspection = createInspectResult({
    reviewToken: "fresh-inspected-token",
    plugin: { ...createInspectResult().plugin, name: "Authoritative Workboard" },
    declared: { ...createInspectResult().declared, tools: ["workboard_review"] },
  });
  const details = buildCapabilityConsentErrorDetails({
    pluginId: "workboard",
    reviewToken: "older-compact-token",
    widened: { tools: ["workboard_review"] },
    acceptedAt: "2026-08-20T14:03:00Z",
  });
  const changedInspection = createInspectResult({
    ...inspection,
    reviewToken: "changed-inspected-token",
    declared: { ...inspection.declared, tools: ["workboard_review", "workboard_manage"] },
  });
  const enableAttempt = deferred<never>();
  const reinspection = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  let acknowledgements = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspections += 1;
      return inspections === 1
        ? createInspectResult()
        : inspections === 2
          ? inspection
          : reinspection.promise;
    },
    "plugins.setEnabled": (params) => {
      if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
        return enableAttempt.promise;
      }
      if (++acknowledgements === 1) {
        throw consentError("changed-compact-token");
      }
      return mutationResult(updated);
    },
    "plugins.list": () => createResult(updated),
  });
  const { page, find } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", enableRequest),
  );
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(1);
  expect(find("[data-plugin-consent]")).toBeNull();
  enableAttempt.reject(
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "Capability consent required",
      details,
    }),
  );
  await waitForSolid(() => {
    const dialog = find('[data-plugin-consent="enable"]');
    expect(dialog?.textContent).toContain("Authoritative Workboard");
    expect(dialog?.textContent).toContain("workboard_review");
  });
  expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

  consentAction(page)?.click();

  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith(
      "plugins.setEnabled",
      acknowledgedEnable(inspection.reviewToken),
    ),
  );
  await waitForSolid(() => expect(inspections).toBe(3));
  await page.updateComplete;
  expect(consentAction(page)?.disabled).toBe(true);
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  reinspection.resolve(changedInspection);
  await waitForSolid(() => {
    const dialog = find('[data-plugin-consent="enable"]');
    expect(dialog?.textContent).toContain("workboard_manage");
    expect(consentAction(page)?.disabled).toBe(false);
  });
  expect(find('[aria-label="Disable Workboard"]')).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled")).toHaveLength(2);

  consentAction(page)?.click();

  await waitForSolid(() => expect(find('[aria-label="Disable Workboard"]')).not.toBeNull());
  expect(methodCalls(request, "plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
    acknowledgedEnable(inspection.reviewToken),
    acknowledgedEnable(changedInspection.reviewToken),
  ]);
  await page.updateComplete;
  expect(find('[data-plugin-consent="enable"]')).toBeNull();
});

it("blocks consent until inspection retry succeeds", async () => {
  const plugin = createPlugin({ origin: "global" });
  let attempts = 0;
  const { client, request } = scriptedClient({
    "plugins.setEnabled": () => {
      throw consentError("review-token-workboard");
    },
    "plugins.inspect": () => {
      attempts += 1;
      if (attempts === 2) {
        throw unavailable("Inspection unavailable");
      }
      return createInspectResult();
    },
  });
  const { page, find } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(find('[data-plugin-consent="enable"] [role="alert"]')?.textContent).toContain(
      "Inspection unavailable",
    ),
  );
  expect(consentAction(page)?.disabled).toBe(true);

  page
    .querySelector<HTMLButtonElement>('[data-plugin-consent="enable"] [role="alert"] .btn')
    ?.click();

  await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  expect(methodCalls(request, "plugins.inspect")).toHaveLength(3);
});

it("discards stale consent inspections after reconnect", async () => {
  const plugin = createPlugin({ origin: "global" });
  const pendingInspection = deferred<ReturnType<typeof createInspectResult>>();
  let inspections = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspections += 1;
      return inspections === 2
        ? pendingInspection.promise
        : createInspectResult({ reviewToken: "fresh-review" });
    },
    "plugins.setEnabled": (params) => {
      if (typeof params !== "object" || !params || !("acknowledgeCapabilities" in params)) {
        throw consentError("fresh-review");
      }
      return mutationResult(enabledPlugin(plugin));
    },
    "plugins.list": () => createResult(plugin),
  });
  const { page, find, harness } = await mountInventory(client, createResult(plugin));

  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() =>
    expect(find("openclaw-modal-dialog .plugins-consent__hint")).not.toBeNull(),
  );
  harness.emit(client, false);
  harness.emit(client, true);
  pendingInspection.resolve(createInspectResult({ reviewToken: "stale-review" }));
  await page.updateComplete;

  expect(find("openclaw-modal-dialog")).toBeNull();
  expect(methodCalls(request, "plugins.setEnabled").map(([, params]) => params)).toEqual([
    enableRequest,
  ]);
  await waitForSolid(() => expect(find('[aria-label="Enable Workboard"]')).not.toBeNull());
  await clickPluginAction(page, "Enable Workboard");
  await waitForSolid(() => expect(consentAction(page)?.disabled).toBe(false));
  consentAction(page)?.click();

  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.setEnabled", acknowledgedEnable("fresh-review")),
  );
});
function createQueuedRuntimeConfig(client: ReturnType<typeof createClient>["client"]) {
  const queued = deferred();
  const release = deferred();
  const harness = createRuntimeConfigHarness(
    vi.fn(async () => undefined),
    { configFormDirty: false, lastError: null },
    () => client,
  );
  harness.runtimeConfig.runExternalMutation = async (task, options) => {
    queued.resolve();
    await release.promise;
    if (options?.canDispatch && !options.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: options.dispatchError ?? "Mutation scope changed before dispatch.",
      };
    }
    return { ok: true, value: await task(client), refresh: { ok: true } };
  };
  return { harness, queued: queued.promise, release };
}

it("retains a failed uninstall, resumes inspection, and allows retry", async () => {
  const plugin = createPlugin({ id: "calendar", name: "Calendar", removable: true });
  const removing = deferred<never>();
  let inspectionReads = 0;
  let uninstallAttempts = 0;
  const { client, request } = scriptedClient({
    "plugins.inspect": () => {
      inspectionReads += 1;
      return createInspectResult({
        plugin,
        overview: { readme: inspectionReads === 1 ? "# Existing plugin" : "# Still installed" },
      });
    },
    "plugins.uninstall": () => {
      uninstallAttempts += 1;
      return uninstallAttempts === 1
        ? removing.promise
        : { ok: true, pluginId: plugin.id, removed: ["install record"] };
    },
    "plugins.list": () => createResult(uninstallAttempts < 2 ? plugin : []),
  });
  const { page, find } = await mountInventory(
    client,
    createResult(plugin),
    "/settings/plugins/calendar",
  );
  await waitForSolid(() => expect(page.textContent).toContain("Existing plugin"));
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("plugins.uninstall", { pluginId: plugin.id }),
  );
  expect(inspectionReads).toBe(1);
  removing.reject(unavailable("Plugin removal was refused."));
  await settlePlugins();
  await waitForSolid(() => expect(page.textContent).toContain("Still installed"));
  expect(find('.plugins-row-message[role="alert"]')?.textContent).toContain(
    "Plugin removal was refused.",
  );
  expect(find<HTMLButtonElement>('[aria-label="Uninstall Calendar"]')?.disabled).toBe(false);
  await clickPluginAction(page, "Uninstall Calendar");
  await waitForSolid(() => expect(uninstallAttempts).toBe(2));
  await waitForSolid(() => expect(find('[aria-label="Uninstall Calendar"]')).toBeNull());
  expect(find(".plugins-row-message")).toBeNull();
});

it.each(["removed", "available", "navigated", "failed"] as const)(
  "reconciles a local discovery uninstall with %s selection",
  async (outcome) => {
    const plugin = createPlugin({
      id: "calendar",
      name: "Calendar",
      origin: outcome === "available" ? "official" : "global",
      removable: true,
    });
    const other = createPlugin({ id: "other", name: "Other" });
    const catalog = createDiscoveryDetail(plugin);
    catalog.plugin.id = "local_Y2FsZW5kYXI";
    catalog.plugin.local.pluginId = plugin.id;
    catalog.plugin.local.action = "manage";
    catalog.detail.origin = "local";
    const otherCatalog = createDiscoveryDetail(other);
    otherCatalog.plugin.id = "local_b3RoZXI";
    otherCatalog.plugin.local.pluginId = other.id;
    otherCatalog.detail.origin = "local";
    const available = {
      ...plugin,
      installed: false,
      enabled: false,
      state: "not-installed" as const,
    };
    const removing = deferred<unknown>();
    let removed = false;
    let missingCatalogReads = 0;
    const { client } = scriptedClient({
      "plugins.catalog.get": (params) => {
        if ((params as { id: string }).id === otherCatalog.plugin.id) {
          return otherCatalog;
        }
        if (!removed) {
          return catalog;
        }
        if (outcome !== "available") {
          missingCatalogReads += 1;
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Local plugin not found",
          });
        }
        return {
          ...catalog,
          plugin: {
            ...catalog.plugin,
            local: {
              ...catalog.plugin.local,
              installed: false,
              enabled: false,
              state: "not-installed",
              action: "install",
              install: { source: "official", pluginId: plugin.id },
            },
          },
        };
      },
      "plugins.inspect": (params) =>
        createInspectResult({
          plugin: (params as { pluginId: string }).pluginId === other.id ? other : plugin,
        }),
      "plugins.uninstall": () => removing.promise,
      "plugins.list": () => createResult(outcome === "available" ? [available, other] : [other]),
    });
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const route = (id: string) =>
      createPluginsRouteData(harness.gateway, createResult([plugin, other]), `/plugins/${id}`);
    const { page, find } = await mountPage(context, route(catalog.plugin.id));
    await waitForSolid(() => expect(find("h1")?.textContent).toBe("Calendar"));
    await clickPluginAction(page, "Uninstall Calendar");
    await waitForSolid(() =>
      expect(find('[aria-label="Uninstall Calendar"]')?.getAttribute("aria-busy")).toBe("true"),
    );
    if (outcome === "navigated") {
      page.routeData = route(otherCatalog.plugin.id);
      await waitForSolid(() => expect(find("h1")?.textContent).toBe("Other"));
    }
    removed = true;
    if (outcome === "failed") {
      removing.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Plugin files were removed, but runtime activation failed.",
        }),
      );
    } else {
      removing.resolve({ ok: true, pluginId: plugin.id, removed: ["install record"] });
    }
    await settlePlugins();
    await page.updateComplete;
    expect(missingCatalogReads).toBe(0);
    if (outcome === "removed" || outcome === "failed") {
      await waitForSolid(() =>
        expect(context.replace).toHaveBeenCalledWith("plugins", { pathname: "/plugins" }),
      );
      if (outcome === "failed") {
        expect(find('.plugins-row-message[role="alert"]')?.textContent).toContain(
          "Plugin files were removed, but runtime activation failed.",
        );
      }
    } else {
      expect(context.replace).not.toHaveBeenCalled();
      if (outcome === "available") {
        await waitForSolid(() => expect(find("openclaw-plugin-install-action")).not.toBeNull());
      } else {
        expect(find("h1")?.textContent).toBe("Other");
      }
    }
  },
);

it.each(["confirmation", "queued"] as const)(
  "rejects %s uninstall after Gateway replacement",
  async (boundary) => {
    const result = createResult([createPlugin(), removablePlugin()]);
    const initial =
      boundary === "confirmation"
        ? createClient(async (method) => {
            if (method === "plugins.inspect") {
              return createInspectResult({ plugin: removablePlugin() });
            }
            throw new Error(
              "The initial Gateway must not receive a request while confirmation is open.",
            );
          })
        : scriptedClient({});
    const replacement = scriptedClient({ "plugins.list": () => result });
    const config = boundary === "queued" ? createQueuedRuntimeConfig(initial.client) : undefined;
    const { page, harness } = await mountInventory(
      initial.client,
      result,
      communityPath,
      config?.harness,
    );
    const confirmation = deferred<boolean>();
    if (!config) {
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    }
    await clickPluginAction(page, "Uninstall Community Thing");
    if (config) {
      await config.queued;
      harness.emit(replacement.client, true);
      await page.updateComplete;
      config.release.resolve();
    } else {
      await waitForSolid(() => expect(showConfirmDialog).toHaveBeenCalledOnce());
      harness.emit(replacement.client, true);
      confirmation.resolve(true);
    }
    await settlePlugins();
    expect(methodCalls(initial.request, "plugins.uninstall")).toHaveLength(0);
    expect(methodCalls(replacement.request, "plugins.uninstall")).toHaveLength(0);
  },
);

it("requires a fresh install-policy review after reconnect", async () => {
  const available = createPlugin({
    id: "community-thing",
    name: "Community Thing",
    origin: "global",
    installed: false,
    state: "not-installed",
    install: { source: "official", pluginId: "community-thing" },
  });
  const catalog = createDiscoveryDetail(available);
  catalog.plugin.id = "catalog-community-thing";
  let installCalls = 0;
  const { client } = createScriptedClient({
    "plugins.catalog.get": () => catalog,
    "plugins.list": () => createResult(available),
    "plugins.install": (params) => {
      installCalls += 1;
      if (!(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "install requires review",
          details: {
            installPolicyCode: "install_policy_warning_acknowledgement_required",
            targetName: "community-thing",
            targetType: "plugin",
            requestMode: "install",
            reason: "Review this plugin before installing it.",
          },
        });
      }
      return mutationResult({ ...available, installed: true }) satisfies PluginMutationResult;
    },
  });
  const { page, harness } = await mountInventory(
    client,
    createResult(available),
    pathForPluginCatalogEntry(catalog.plugin.id),
  );

  await clickPluginAction(page, "Install");
  await waitForSolid(() =>
    expect(page.textContent).toContain("Review this plugin before installing it."),
  );
  expect(installCalls).toBe(1);
  expect(showConfirmDialog).not.toHaveBeenCalled();
  harness.emit(client, false);
  harness.emit(client, true);
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(page.textContent).toContain("request a fresh review"));
  expect(installCalls).toBe(1);
  await clickPluginAction(page, "Install");
  await waitForSolid(() => expect(installCalls).toBe(2));
  await clickPluginAction(page, "Continue installation");
  await waitForSolid(() => expect(installCalls).toBe(3));
  expect(showConfirmDialog).not.toHaveBeenCalled();
});
