// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import { createModelsListTestContext } from "../gateway/server-methods/models-list-result.openai-routes.test-support.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  AgentHarnessModelCatalogParams,
  AgentHarnessModelCatalogResult,
} from "./harness/types.js";
import { loadPreparedModelCatalogSnapshot } from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "native-demand" });
const { mocks } = fixture;

it("defers native discovery until agent catalog demand and reacquires retired observations", async () => {
  const agentIds = ["default", "pro", "unused"];
  mocks.configuredAgentIds = agentIds;
  const config: OpenClawConfig = {
    agents: {
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      defaults: {
        model: "demo/native-model",
        models: { "demo/native-model": { agentRuntime: { id: "native-test" } } },
      },
    },
  };
  const native = {
    provider: "demo",
    id: "native-model",
    name: "Native model",
    nativeRuntime: "native-test",
  };
  mocks.resolveNativeModelPrimary.mockReturnValue("demo/native-model");
  const observed = new Set<string>();
  const loadNative = vi.fn<
    (params: AgentHarnessModelCatalogParams) => Promise<AgentHarnessModelCatalogResult>
  >(async ({ agentDir }) => {
    observed.add(agentDir);
    return [native];
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation(() => {
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "native-test",
      source: "fixture",
      harness: {
        id: "native-test",
        label: "Native test",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        runAttempt: vi.fn(),
        loadModelCatalog: loadNative,
        readModelCatalogReadiness: ({ agentDir }) =>
          observed.has(agentDir) ? { accountType: "apiKey" } : undefined,
      },
    });
    return registry;
  });
  const providerRows = [{ provider: "builtin", id: "known", name: "Known" }];
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: providerRows,
    routeVariants: providerRows,
  });
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  for (const agentId of agentIds) {
    await getPreparedModelRuntimeSnapshot(fixture.agentInput(agentId, config))!
      .loadFullModelCatalog!({
      changedOnly: true,
    });
  }
  expect(loadNative).not.toHaveBeenCalled();
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(agentIds.length);
  const read = () =>
    loadPreparedModelCatalogSnapshot({
      agentId: "pro",
      config,
    });
  const context = createModelsListTestContext({ agentId: "pro", cfg: config, catalog: [] });
  registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
    loadDeferred: (params) =>
      loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config }),
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
  });
  context.readPreparedModelsList = (request) =>
    buildModelsListResult({ source: { kind: "gateway", context }, ...request });
  const pick = async () => {
    const respond = vi.fn();
    await modelsHandlers["models.list"]!({
      req: { type: "req", id: "native-demand", method: "models.list" },
      params: { agentId: "pro", view: "all", includeDefaultModels: false },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context,
    });
    const [ok, result, error] = respond.mock.calls[0] ?? [];
    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ provider: native.provider, id: native.id }),
      ]),
    });
  };
  await Promise.all([pick(), pick()]);
  expect(loadNative).toHaveBeenCalledOnce();
  const [first, concurrent] = await Promise.all([read(), read()]);
  expect(first.entries).toContainEqual(expect.objectContaining(native));
  expect(concurrent.entries).toEqual(first.entries);
  expect(loadNative).toHaveBeenCalledOnce();
  expect(loadNative.mock.calls[0]?.[0].agentDir).toBe(fixture.state.agentDir("pro"));
  await read();
  expect(loadNative).toHaveBeenCalledOnce();
  observed.clear();
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(2);
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(agentIds.length);
  observed.clear();
  loadNative.mockResolvedValueOnce({
    entries: [native],
    outcomes: [{ provider: "demo", status: "unavailable" }],
  });
  await read();
  await read();
  expect(loadNative).toHaveBeenCalledTimes(3);
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  expect(loadNative).toHaveBeenCalledTimes(3);
  expect((await read()).entries).toContainEqual(expect.objectContaining(native));
  expect(loadNative).toHaveBeenCalledTimes(4);
});
