// Registered in the command suite to reuse its reset and setup fixtures.
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as fetchGuard from "../infra/net/fetch-guard.js";
import type { MockFn } from "../test-utils/vitest-mock-fn.js";
import * as nonInteractiveApiKeys from "./onboard-non-interactive/api-keys.js";
import { setupWizardCommand } from "./onboard.js";
import { createTestRuntime as makeRuntime } from "./test-runtime-config-helpers.js";

export type ConfigSnapshotStub = {
  exists: boolean;
  valid: boolean;
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  readError?: { code: string | null };
};

export function registerOnboardResetDiscoveryTests({
  mocks,
  expectAuthPreflightError,
}: {
  mocks: {
    readConfigFileSnapshot: MockFn<() => Promise<ConfigSnapshotStub>>;
    handleReset: MockFn<() => Promise<void>>;
    runNonInteractiveSetup: MockFn<() => Promise<void>>;
  };
  expectAuthPreflightError: (
    opts: Parameters<typeof setupWizardCommand>[0],
    getMessage: () => string,
  ) => Promise<void>;
}) {
  it("rejects empty discovery before reset", async () => {
    vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(null);
    vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json({ data: [] }),
      finalUrl: "https://example.com/v1/models",
      release: async () => {},
    });
    await expectAuthPreflightError(
      { customBaseUrl: "https://example.com/v1" },
      () =>
        "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
    );
  });

  it("carries discovered model ids through reset without another request", async () => {
    vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(null);
    const request = vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockResolvedValue({
      response: Response.json({ data: [{ id: "first" }, { id: "second" }] }),
      finalUrl: "https://example.com/v1/models",
      release: async () => {},
    });
    const runtime = makeRuntime();
    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        customBaseUrl: "https://example.com/v1",
      },
      runtime,
    );
    expect(mocks.handleReset).toHaveBeenCalledOnce();
    expect(mocks.runNonInteractiveSetup).toHaveBeenCalledWith(
      expect.objectContaining({ customModelIds: ["first", "second"] }),
      runtime,
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "configured inline key",
      apiKey: "fixture-configured-inline-key",
      expectedKey: "fixture-configured-inline-key",
    },
    {
      name: "configured env reference",
      apiKey: { source: "env" as const, provider: "default", id: "CUSTOM_DISCOVERY_TEST_KEY" },
      expectedKey: "fixture-configured-env-key",
    },
    {
      name: "explicit key instead of the configured key",
      apiKey: "fixture-unused-configured-key",
      expectedKey: "fixture-explicit-key",
      customApiKey: "fixture-explicit-key",
    },
  ])("authenticates discovery before reset with $name", async (testCase) => {
    const authProfileStore = await import("../agents/auth-profiles/store-runtime.js");
    vi.spyOn(
      authProfileStore,
      "loadAuthProfileStoreWithoutExternalProfilesAsync",
    ).mockResolvedValue({ version: 1, profiles: {} });
    vi.stubEnv("CUSTOM_DISCOVERY_TEST_KEY", "fixture-configured-env-key");
    const config: OpenClawConfig = {
      models: {
        providers: {
          local: {
            baseUrl: "https://models.example.com/v1",
            apiKey: testCase.apiKey,
            models: [],
          },
        },
      },
    };
    const authoredConfig = structuredClone(config);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(
      testCase.customApiKey ? { key: testCase.customApiKey, source: "flag" } : null,
    );
    const request = vi
      .spyOn(fetchGuard, "fetchWithSsrFGuard")
      .mockImplementation(async (params) => {
        const authorized =
          params.url === "https://models.example.com/v1/models" &&
          new Headers(params.init?.headers).get("authorization") ===
            `Bearer ${testCase.expectedKey}`;
        return {
          response: authorized
            ? Response.json({ data: [{ id: "secured-first" }, { id: "secured-second" }] })
            : new Response(null, { status: 401 }),
          finalUrl: params.url,
          release: async () => {},
        };
      });
    const runtime = makeRuntime();

    await setupWizardCommand(
      {
        reset: true,
        nonInteractive: true,
        acceptRisk: true,
        authChoice: "custom-api-key",
        customBaseUrl: "https://models.example.com/v1",
        customProviderId: "local",
        ...(testCase.customApiKey ? { customApiKey: testCase.customApiKey } : {}),
      },
      runtime,
    );

    expect(request).toHaveBeenCalledOnce();
    expect(mocks.handleReset).toHaveBeenCalledOnce();
    expect(mocks.runNonInteractiveSetup).toHaveBeenCalledWith(
      expect.objectContaining({ customModelIds: ["secured-first", "secured-second"] }),
      runtime,
    );
    const discoveryOrder = request.mock.invocationCallOrder[0];
    const resetOrder = mocks.handleReset.mock.invocationCallOrder[0];
    const setupOrder = mocks.runNonInteractiveSetup.mock.invocationCallOrder[0];
    if (discoveryOrder === undefined || resetOrder === undefined || setupOrder === undefined) {
      throw new Error("Expected authenticated discovery, reset, and setup");
    }
    expect(discoveryOrder).toBeLessThan(resetOrder);
    expect(resetOrder).toBeLessThan(setupOrder);
    expect(config).toEqual(authoredConfig);
    const output = JSON.stringify([runtime.log.mock.calls, runtime.error.mock.calls]);
    expect(output).not.toContain(testCase.expectedKey);
    if (typeof testCase.apiKey === "string") {
      expect(output).not.toContain(testCase.apiKey);
    }
  });

  it("does not send a different endpoint's configured credential during reset preflight", async () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          local: {
            baseUrl: "https://previous.example.com/v1",
            apiKey: "fixture-previous-endpoint-key",
            models: [],
          },
        },
      },
    };
    const authoredConfig = structuredClone(config);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config,
      sourceConfig: config,
    });
    vi.spyOn(nonInteractiveApiKeys, "resolveNonInteractiveApiKey").mockResolvedValue(null);
    const authorizationHeaders: Array<string | null> = [];
    vi.spyOn(fetchGuard, "fetchWithSsrFGuard").mockImplementation(async (params) => {
      authorizationHeaders.push(new Headers(params.init?.headers).get("authorization"));
      return {
        response: new Response(null, { status: 401 }),
        finalUrl: params.url,
        release: async () => {},
      };
    });

    await expectAuthPreflightError(
      {
        authChoice: "custom-api-key",
        customBaseUrl: "https://replacement.example.com/v1",
        customProviderId: "local",
      },
      () =>
        "No models could be discovered from the custom provider. Check the base URL and credentials, or pass --custom-model-id explicitly.",
    );

    expect(authorizationHeaders).toEqual([null]);
    expect(config).toEqual(authoredConfig);
  });
}
