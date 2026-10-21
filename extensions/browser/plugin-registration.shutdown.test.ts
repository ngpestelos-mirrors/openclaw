import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { LazyPluginServiceHandle } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const mocks = vi.hoisted(() => ({
  hasBrowserNodeHostWork: vi.fn(() => false),
  handleGatewayExtensionUpgrade: vi.fn(async () => true),
  handleBrowserScreencastUpgrade: vi.fn(async () => true),
  stopBrowserControlService: vi.fn(async () => undefined),
  startLazyPluginServiceModule: vi.fn(
    async (_params: {
      validateOverrideSpecifier?: (specifier: string) => string;
    }): Promise<LazyPluginServiceHandle | null> => null,
  ),
  startTabCleanup: vi.fn(() => async () => {}),
}));

vi.mock("./register.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register.runtime.js")>()),
  hasBrowserNodeHostWork: mocks.hasBrowserNodeHostWork,
  stopBrowserControlService: mocks.stopBrowserControlService,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  startLazyPluginServiceModule: mocks.startLazyPluginServiceModule,
}));

vi.mock("./src/browser/session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: mocks.startTabCleanup,
}));

vi.mock("./src/browser/extension-relay/gateway-relay-route.js", () => ({
  handleGatewayExtensionUpgrade: mocks.handleGatewayExtensionUpgrade,
}));

vi.mock("./src/browser/screencast/upgrade.js", () => ({
  handleBrowserScreencastUpgrade: mocks.handleBrowserScreencastUpgrade,
}));

vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
  drainBrowserSessionTabStore: vi.fn(async () => undefined),
}));

vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));

function registerLifecycle(path = "/browser/screencast", eager = false) {
  if (eager) {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
  }
  const api = createTestPluginApi({
    runtime: { state: { openKeyedStore: vi.fn() } } as never,
    registerHttpRoute: vi.fn(),
    registerService: vi.fn(),
  });
  registerBrowserPlugin(api);
  const route = vi
    .mocked(api.registerHttpRoute)
    .mock.calls.findLast(([registered]) => registered.path === path)?.[0];
  const service = vi.mocked(api.registerService).mock.calls.at(-1)?.[0];
  if (!route?.handleUpgrade || !service?.stop) {
    throw new Error("expected browser relay route and service lifecycle");
  }
  const scheduler = createTestPluginServiceScheduler();
  onTestFinished(() => scheduler.stop());
  const context = { config: {}, stateDir: "/tmp/browser-startup", logger: console, scheduler };
  return {
    handleUpgrade: route.handleUpgrade,
    start: () => service.start(context),
    stop: () => service.stop?.(context),
  };
}

describe("browser websocket shutdown registration", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("keeps shutdown lazy until direct websocket activity prepares teardown", async () => {
    await registerLifecycle().stop();
    expect(mocks.stopBrowserControlService).not.toHaveBeenCalled();

    const req = {} as IncomingMessage;
    const socket = {} as Duplex;
    const head = Buffer.alloc(0);

    for (const path of ["/browser/screencast", "/browser/extension"]) {
      const { handleUpgrade, stop } = registerLifecycle(path);
      await expect(handleUpgrade(req, socket, head)).resolves.toBe(true);
      await stop();
    }

    expect(mocks.handleBrowserScreencastUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(mocks.handleGatewayExtensionUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(mocks.stopBrowserControlService).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "admits periodic cleanup only after successful eager startup: %s",
    async (outcome) => {
      const entered = createDeferred<void>();
      const ready = createDeferred<void>();
      mocks.startLazyPluginServiceModule.mockImplementationOnce(async () => {
        entered.resolve();
        await ready.promise;
        return null;
      });
      const lifecycle = registerLifecycle(undefined, true);
      const settled = Promise.resolve(lifecycle.start()).then(
        () => undefined,
        (error: unknown) => error,
      );
      const failure = new Error("eager startup failed");
      try {
        await entered.promise;
        expect(mocks.startTabCleanup).not.toHaveBeenCalled();
      } finally {
        if (outcome === "success") {
          ready.resolve();
        } else {
          ready.reject(failure);
        }
        await settled;
        await lifecycle.stop();
      }
      expect(await settled).toBe(outcome === "success" ? undefined : failure);
      expect(mocks.startTabCleanup).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    },
  );

  it("validates eager browser override specifiers", async () => {
    const lifecycle = registerLifecycle(undefined, true);
    try {
      await lifecycle.start();
      const validate =
        mocks.startLazyPluginServiceModule.mock.lastCall?.[0].validateOverrideSpecifier;
      expect(validate?.(" ./server.js ")).toBe("./server.js");
      for (const specifier of [
        "data:text/javascript,boom",
        "HTTPS://example.invalid/mod.mjs",
        "node:fs",
      ]) {
        expect(() => validate?.(specifier)).toThrow(
          "Refusing unsafe browser control override specifier",
        );
      }
    } finally {
      await lifecycle.stop();
    }
  });

  it("retains eager cleanup until a failed stop can be retried", async () => {
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error("loaded cleanup failed"))
      .mockResolvedValue(undefined);
    mocks.startLazyPluginServiceModule.mockResolvedValueOnce({ stop });
    const lifecycle = registerLifecycle(undefined, true);
    await lifecycle.start();

    await expect(lifecycle.stop()).rejects.toThrow("loaded cleanup failed");
    await expect(lifecycle.stop()).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(mocks.stopBrowserControlService).not.toHaveBeenCalled();
  });

  it("propagates on-demand cleanup failures", async () => {
    const lifecycle = registerLifecycle();
    await lifecycle.handleUpgrade({} as IncomingMessage, {} as Duplex, Buffer.alloc(0));
    mocks.stopBrowserControlService.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(lifecycle.stop()).rejects.toThrow("cleanup failed");
  });
});
