import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayMethodOwner } from "../gateway/methods/descriptor.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import { authorizeGatewayRequestPreDispatch } from "../gateway/server-methods/request-authorization.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "../gateway/session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../gateway/session-row-projection.test-support.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createEmptyPluginMetadataSnapshot } from "../plugins/plugin-metadata-empty.test-support.js";
import { buildPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { createRuntimeTestRegistry } from "../plugins/registry-runtime.test-helpers.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import * as profileAuthority from "../state/user-channel-identity-operations.js";
import * as profileReader from "../state/user-profile-list.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createModelRoutingTestAdmission } from "./test-helpers/model-routing-decision-e2e-fixtures.js";
import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

const browserRuntime = { execute: vi.fn<AnyAgentTool["execute"]>() };
const readPublicItem = vi.fn<AnyAgentTool["execute"]>();

let registerBrowserPlugin: NonNullable<OpenClawPluginDefinition["register"]>;
const sessionKey = "agent:main:policy-regression";
const registries: PluginRegistry[] = [];
const releases: Array<() => void> = [];
const pluginOnlyPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: true,
};

function requireTool(tools: AnyAgentTool[], name: string) {
  return expectDefined(
    tools.find((tool) => tool.name === name),
    name,
  );
}

function assertCapturedPolicy(name: string) {
  expectDefined(getGatewayToolCallerIdentity()?.assertToolAllowed, "captured policy")(name);
  return jsonResult({ allowed: name });
}

function assemble(allow: string[], deny: string[] = []) {
  const config: OpenClawConfig = {
    plugins: { allow: ["browser", "fixture-reader"], slots: { memory: "none" } },
    tools: { allow, deny, toolSearch: true },
  };
  const registry = createRuntimeTestRegistry(createPluginRuntime());
  registries.push(registry.registry);
  const manifests = [
    { id: "browser", toolName: "browser" },
    { id: "fixture-reader", toolName: "Read_Public_Item" },
  ].map(({ id, toolName }) =>
    createPluginManifestRecordFixture({
      id,
      enabledByDefault: true,
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}/index.js`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
      contracts: { tools: id === "fixture-reader" ? ["select_public_item", toolName] : [toolName] },
    }),
  );
  for (const manifest of manifests) {
    const { id, source, rootDir, origin, contracts } = manifest;
    const record = createPluginRecord({ id, source, rootDir, origin, contracts });
    bindPluginRuntimeArtifactSelection(record, {
      runtimeEntry: { source: manifest.source, rootDir: manifest.rootDir },
      preferBuiltPluginArtifacts: false,
    });
    const api = registry.createApi(record, { config });
    if (manifest.id === "browser") {
      const registerTool = api.registerTool;
      // Exercise the plugin's real registration and tool metadata while isolating
      // browser I/O at the public registration boundary, not its private modules.
      api.registerTool = (factory, options) => {
        if (typeof factory !== "function") {
          throw new Error("Expected browser tool factory");
        }
        registerTool((context) => {
          const tool = factory(context);
          if (!tool || Array.isArray(tool)) {
            throw new Error("Expected one registered browser tool");
          }
          return { ...tool, execute: browserRuntime.execute };
        }, options);
      };
    }
    runPluginRegisterSyncInRegistry(
      manifest.id === "browser"
        ? registerBrowserPlugin
        : (pluginApi) => {
            pluginApi.registerTool(
              () => ({
                name: "Read_Public_Item",
                label: "Read public item",
                description: "Read a public fixture item",
                parameters: { type: "object", properties: {} },
                execute: readPublicItem,
              }),
              { names: ["select_public_item"], workspaceAccess: "execute" },
            );
            pluginApi.registerGatewayMethod("fixture-reader.read", () => {}, {
              scope: "operator.write",
              sessionAccess: {
                mode: "write",
                allowOwnSessionScope: true,
                requiredTool: " Read_Public_Item ",
              },
            });
          },
      api,
      registry.registry,
      manifest.id,
    );
  }
  const emptySnapshot = createEmptyPluginMetadataSnapshot("/tmp");
  const index = { ...emptySnapshot.index, policyHash: "test" };
  const snapshot = buildPluginMetadataSnapshot(
    {
      ...emptySnapshot,
      policyHash: resolveInstalledPluginIndexPolicyHash(config),
      index,
      registryIndex: { ...index },
      manifestRegistry: { plugins: manifests, diagnostics: [] },
      metrics: { ...emptySnapshot.metrics, manifestPluginCount: 2 },
    },
    { config, env: process.env },
  );
  setGatewayPluginMetadataSnapshot(snapshot, { config, workspaceDir: "/tmp", env: process.env });
  setPluginRuntimeLoadContext(registry.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: "/tmp",
    env: process.env,
    logger: { info() {}, warn() {}, error() {} },
    manifestRegistry: snapshot.manifestRegistry,
    metadataSnapshot: snapshot,
  });
  const catalogRef = createToolSearchCatalogRef();
  const callerOptions = { config, agentId: "main", sessionKey, workspaceDir: "/tmp" };
  const tools = withPluginRuntimeRegistryScope(registry.registry, () =>
    createOpenClawCodingTools({
      ...callerOptions,
      includeCoreTools: false,
      includeToolSearchControls: true,
      toolSearchCatalogRef: catalogRef,
      toolConstructionPlan: pluginOnlyPlan,
      wrapBeforeToolCallHook: false,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        ...callerOptions,
        pluginMetadataSnapshot: snapshot,
      }),
    }),
  );
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return { tools, config, registry: registry.registry };
}

async function prepareResourceFixture(
  options: {
    methodOwner?: GatewayMethodOwner;
    toolName?: "browser" | "Read_Public_Item";
    allow?: string[];
    unrelatedAmbientRegistry?: boolean;
    missingSelectedRegistration?: boolean;
  } = {},
) {
  const toolName = options.toolName ?? "browser";
  const { tools, registry, config: initialConfig } = assemble(options.allow ?? ["group:plugins"]);
  let config = initialConfig;
  const projection = createSessionRowProjectionFixture({
    cfg: config,
    storePath: "/test/sessions",
    store: {
      [sessionKey]: {
        sessionId: "plugin-policy-session",
        lifecycleRevision: "plugin-policy-incarnation",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "alice" },
        visibility: "shared",
      },
    },
  });
  releases.push(projection.dispose);
  const context = bindSessionRowProjection(createContext(), () => projection);
  context.getRuntimeConfig = () => config;
  const emptyRegistry = createRuntimeTestRegistry(createPluginRuntime()).registry;
  registries.push(emptyRegistry);
  const methodRegistry = createGatewayMethodRegistry(
    registry.gatewayMethodDescriptors.map((descriptor) =>
      options.methodOwner ? { ...descriptor, owner: options.methodOwner } : descriptor,
    ),
    options.missingSelectedRegistration ? emptyRegistry : registry,
  );
  context.getGatewayMethodRegistry = () => methodRegistry;
  const client = createOperatorClient({ profileId: "alice", scopes: ["operator.sessions.write"] });
  client.internal = { syntheticClient: true };
  const admission = createModelRoutingTestAdmission({
    cfg: config,
    runId: "plugin-policy-run",
    agentId: "main",
    boundary: "plugin-policy-test",
  });
  releases.push(admission.close);
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: await admission.admit("plugin-harness", "plugin-policy-harness"),
      agentId: "main",
      sessionKey,
    }),
    "admitted resource caller",
  );
  const methodName = toolName === "browser" ? "browser.dashboard.request" : "fixture-reader.read";
  expectDefined(
    methodRegistry.descriptors().find((method) => method.name === methodName)?.sessionAccess,
    "registered session-access policy",
  );
  let beforeEffect = () => {};
  const effect = vi.fn();
  const execute = toolName === "browser" ? browserRuntime.execute : readPublicItem;
  execute.mockImplementation(async () => {
    const authorization = await withPluginRuntimeRegistryScope(
      options.unrelatedAmbientRegistry ? emptyRegistry : registry,
      () =>
        authorizeGatewayRequestPreDispatch({
          method: methodName,
          methodRegistry,
          requestParams: { agentId: "main", sessionKey },
          client,
          context,
        }),
    );
    if (authorization.error) {
      throw new Error(authorization.error.message);
    }
    const authority = expectDefined(
      authorization.sessionAccessAuthority,
      "session access authority",
    );
    try {
      beforeEffect();
      authority.assertCurrent();
      effect();
      return jsonResult({ allowed: toolName });
    } finally {
      authority.release();
    }
  });
  return {
    tools,
    effect,
    beforeEffect(callback: () => void) {
      beforeEffect = callback;
    },
    denyTool(deny: string) {
      config = { ...config, tools: { ...config.tools, deny: [deny] } };
    },
    execute(route: "direct" | "dispatch_action", assertToolAllowed?: (name: string) => void) {
      const args = toolName === "browser" ? { action: "status" } : {};
      return withPluginRuntimeRegistryScope(registry, () =>
        withGatewayToolCallerIdentity({ ...caller, assertToolAllowed }, () =>
          requireTool(tools, route === "direct" ? toolName : route).execute(
            "browser-policy",
            route === "direct" ? args : { id: toolName, args },
          ),
        ),
      );
    },
  };
}

describe("captured registered plugin tool policy", () => {
  beforeAll(async () => {
    const surface = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
      pluginId: "browser",
      artifactBasename: "index.js",
    });
    registerBrowserPlugin = expectDefined(surface.default.register, "browser plugin registration");
  });

  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(
      registries.splice(0).map((registry) => disposePluginRegistryInstances(registry)),
    );
    clearCurrentPluginMetadataSnapshot();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    readPublicItem.mockReset();
    readPublicItem.mockImplementation(async () => assertCapturedPolicy("Read_Public_Item"));
    browserRuntime.execute.mockReset();
    browserRuntime.execute.mockImplementation(async () => assertCapturedPolicy("browser"));
    vi.spyOn(profileReader, "prepareUserProfileIdentity").mockImplementation(async (profileId) => ({
      readCurrentProfile: () => ({ profileId, assignedRole: null }),
      emailBindingIds: [],
      readCurrentFacts: () => ({
        profile: { profileId, assignedRole: null, emails: [] },
        aliases: new Set([profileId]),
      }),
      release() {},
    }));
    vi.spyOn(profileAuthority, "prepareUserProfileRoleAuthority").mockImplementation(
      async (profileId) => ({
        profileId,
        role: null,
        display: { id: profileId, displayName: "Alice", hasAvatar: false, avatarRevision: "test" },
        readSource: () => ({ path: "/test/profiles.sqlite", env: { OPENCLAW_STATE_DIR: "/test" } }),
        aliases: [profileId],
        isCurrent: () => true,
      }),
    );
  });

  it.each([
    ["direct", "browser", "group:plugins", false],
    ["dispatch_action", "browser", "group:plugins", false],
    ["direct", "Read_Public_Item", "fixture-reader", false],
    ["direct", "browser", "group:plugins", true],
  ] as const)(
    "retains %s %s allowance via %s (ambient=%s)",
    async (route, toolName, allow, ambient) => {
      const fixture = await prepareResourceFixture({
        toolName,
        allow: [allow],
        unrelatedAmbientRegistry: ambient,
      });
      if (toolName === "browser" && !ambient) {
        expect(getPluginToolMeta(requireTool(fixture.tools, "browser"))?.pluginId).toBe("browser");
      }
      await expect(fixture.execute(route)).resolves.toMatchObject({
        details: { allowed: toolName },
      });
      expect(fixture.effect).toHaveBeenCalledOnce();
    },
  );

  it.each(["Read_Public_Item", "fixture-reader", "group:plugins"])(
    "keeps %s denied in the assembled surface",
    (deny) => {
      const { tools } = assemble(["group:plugins"], [deny]);
      expect(tools.map((tool) => tool.name)).not.toContain("Read_Public_Item");
    },
  );

  it("does not treat unregistered names or caller-supplied plugin IDs as ownership", async () => {
    const { tools } = assemble(["group:plugins"], ["Read_Public_Item"]);
    browserRuntime.execute.mockImplementation(async () => {
      const assertToolAllowed = getGatewayToolCallerIdentity()?.assertToolAllowed;
      expect(assertToolAllowed).toBeTypeOf("function");
      for (const name of ["unregistered_action", "Read_Public_Item", "exec"]) {
        expect(() => assertToolAllowed?.(name)).toThrow("is not allowed by this conversation");
      }
      return assertCapturedPolicy("browser");
    });
    await expect(
      requireTool(tools, "browser").execute("spoofed-owner", {
        action: "status",
        pluginId: "browser",
        toolName: "unregistered_action",
      }),
    ).resolves.toMatchObject({ details: { allowed: "browser" } });
  });

  it("preserves a narrower outer caller restriction through dispatch", async () => {
    const fixture = await prepareResourceFixture();
    const assertToolAllowed = vi.fn((name: string) => {
      if (name === "browser") {
        throw new Error("outer caller denies browser");
      }
    });
    await expect(fixture.execute("dispatch_action", assertToolAllowed)).rejects.toThrow(
      "outer caller denies browser",
    );
    expect(assertToolAllowed).toHaveBeenCalledWith("browser");
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it.each([
    ["browser", "browser"],
    ["browser", "group:plugins"],
    ["Read_Public_Item", "fixture-reader"],
    ["Read_Public_Item", "group:plugins"],
  ] as const)("rechecks %s current %s denial before effects", async (toolName, deny) => {
    const fixture = await prepareResourceFixture({
      toolName,
      allow: toolName === "browser" ? [toolName] : [toolName, "select_public_item"],
      unrelatedAmbientRegistry: true,
    });
    fixture.beforeEffect(() => fixture.denyTool(deny));
    await expect(fixture.execute("direct")).rejects.toThrow("current tool policy does not allow");
    expect(fixture.effect).not.toHaveBeenCalled();
  });

  it.each<NonNullable<Parameters<typeof prepareResourceFixture>[0]>>([
    { missingSelectedRegistration: true },
    { methodOwner: { kind: "core", area: "fixture" } },
    { methodOwner: { kind: "plugin", pluginId: "fixture-reader" } },
    { methodOwner: { kind: "plugin", pluginId: "unregistered" } },
  ])("does not borrow browser ownership from another registry or method: %j", async (options) => {
    const fixture = await prepareResourceFixture(options);
    await expect(fixture.execute("direct")).rejects.toThrow("current tool policy does not allow");
    expect(fixture.effect).not.toHaveBeenCalled();
  });
});
