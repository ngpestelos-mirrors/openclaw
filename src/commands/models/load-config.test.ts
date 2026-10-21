import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  setRuntimeConfigSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getModelsCommandSecretTargetIds: vi.fn(),
}));

// mock-isolation: Model-command fixtures control source and runtime snapshots without loading operator state.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  loadConfig: mocks.getRuntimeConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.getRuntimeConfig>) =>
    async () =>
      mocks.getRuntimeConfig(...args),
  getRuntimeConfigSourceSnapshot: mocks.getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot: mocks.setRuntimeConfigSnapshot,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getModelsCommandSecretTargetIds: mocks.getModelsCommandSecretTargetIds,
}));

import { loadModelsConfig, loadModelsConfigWithSource } from "./load-config.js";

describe("models load-config", () => {
  const configWithKey = (apiKey: unknown) => ({ models: { providers: { openai: { apiKey } } } });
  const runtimeConfig = configWithKey("sk-runtime"); // pragma: allowlist secret
  const resolvedConfig = configWithKey("sk-resolved"); // pragma: allowlist secret
  const targetIds = new Set(["models.providers.*.apiKey"]);

  const emptySourceConfig = { models: { providers: {} } };
  function mockResolvedConfigFlow(source: unknown = emptySourceConfig, diagnostics: string[] = []) {
    mocks.getRuntimeConfig.mockReturnValue(runtimeConfig);
    mocks.getRuntimeConfigSourceSnapshot.mockReturnValue(source);
    mocks.getModelsCommandSecretTargetIds.mockReturnValue(targetIds);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig,
      diagnostics,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedConfigFlow();
  });

  it("returns source+resolved configs and sets runtime snapshot", async () => {
    const sourceConfig = configWithKey({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    const runtime = createTestRuntime();

    mockResolvedConfigFlow(sourceConfig, ["diag-one", "diag-two"]);

    const result = await loadModelsConfigWithSource({ commandName: "models list", runtime });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: runtimeConfig,
      commandName: "models list",
      targetIds,
    });
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, sourceConfig);
    expect(runtime.error).toHaveBeenNthCalledWith(1, "[secrets] diag-one");
    expect(runtime.error).toHaveBeenNthCalledWith(2, "[secrets] diag-two");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(result).toEqual({
      sourceConfig,
      resolvedConfig,
      diagnostics: ["diag-one", "diag-two"],
    });
  });

  it("loadModelsConfig returns resolved config while preserving runtime snapshot behavior", async () => {
    await expect(loadModelsConfig({ commandName: "models list" })).resolves.toBe(resolvedConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, emptySourceConfig);
  });

  it("can read core model config without loading plugin schemas", async () => {
    await loadModelsConfig({ commandName: "models status", skipPluginValidation: true });

    expect(mocks.getRuntimeConfig).toHaveBeenCalledWith({ skipPluginValidation: true });
  });

  it("does not reread config when no source snapshot is pinned", async () => {
    mockResolvedConfigFlow(null);

    const result = await loadModelsConfigWithSource({ commandName: "models list" });

    expect(result.sourceConfig).toBe(runtimeConfig);
    expect(mocks.setRuntimeConfigSnapshot).toHaveBeenCalledWith(resolvedConfig, runtimeConfig);
  });
});
