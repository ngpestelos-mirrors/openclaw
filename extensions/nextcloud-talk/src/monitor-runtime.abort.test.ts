import {
  createPluginRuntimeMock,
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { monitorNextcloudTalkProvider } from "./monitor-runtime.js";
import { setNextcloudTalkRuntime } from "./runtime.js";

const config = {
  channels: {
    "nextcloud-talk": {
      baseUrl: "https://cloud.example.com",
      botSecret: "test-bot-secret",
    },
  },
};

describe("Nextcloud Talk monitor abort", () => {
  it.each(["/health", "/healthz", "/ready", "/readyz", "/startup", "/startupz"])(
    "blocks Gateway probe path %s without a legacy endpoint and preserves its legacy endpoint",
    async (probePath) => {
      const core = createPluginRuntimeMock();
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      vi.mocked(core.logging.getChildLogger).mockReturnValue(logger);
      setNextcloudTalkRuntime(core);
      const registry = createTestRegistry();
      setActivePluginRegistry(registry);
      const statusSink = vi.fn();
      const createSpool = vi.fn(() => ({
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
      }));
      for (const webhookPath of [probePath, `${probePath}?tenant=a`]) {
        const options = {
          config: {
            gateway: { port: 19001 },
            channels: { "nextcloud-talk": { ...config.channels["nextcloud-talk"], webhookPath } },
          },
          runtime: createRuntimeSpies(),
          statusSink,
          createSpool,
        };
        await expect(monitorNextcloudTalkProvider(options)).rejects.toThrow(
          /reserved for Gateway probes.*Set webhookPath to "\/nextcloud-talk-webhook".*Gateway port 19001\/nextcloud-talk-webhook/,
        );
        expect(createSpool).not.toHaveBeenCalled();
        expect(registry.httpRoutes).toHaveLength(0);
        expect(statusSink).not.toHaveBeenCalled();
      }
      const monitor = await monitorNextcloudTalkProvider({
        config: {
          gateway: { port: 19001 },
          channels: {
            "nextcloud-talk": {
              ...config.channels["nextcloud-talk"],
              webhookPath: `${probePath}?tenant=a`,
              legacyWebhook: { port: 8788 },
            },
          },
        },
        runtime: createRuntimeSpies(),
        statusSink,
        createSpool,
      });
      try {
        expect(registry.httpRoutes).toHaveLength(1);
        expect(statusSink).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("The configured legacy webhook listener remains available"),
        );
        expect(logger.info).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it("unregisters the Gateway route before stopping its durable spool", async () => {
    setNextcloudTalkRuntime(createPluginRuntimeMock());
    const registry = createTestRegistry();
    setActivePluginRegistry(registry);
    const abortController = new AbortController();
    const spoolStop = vi.fn(async () => {
      expect(registry.httpRoutes).toHaveLength(0);
    });
    const statusSink = vi.fn();
    const monitor = await monitorNextcloudTalkProvider({
      config,
      runtime: createRuntimeSpies(),
      abortSignal: abortController.signal,
      statusSink,
      createSpool: () => ({
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => {
          expect(registry.httpRoutes).toHaveLength(0);
        }),
        stop: spoolStop,
        waitForIdle: vi.fn(async () => {}),
      }),
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(statusSink).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lifecycle: "ready" }),
    );
    abortController.abort();
    await monitor.stop();
    expect(spoolStop).toHaveBeenCalledOnce();
  });

  it("does not register ingress or publish ready when aborted during spool startup", async () => {
    setNextcloudTalkRuntime(createPluginRuntimeMock());
    const registry = createTestRegistry();
    setActivePluginRegistry(registry);
    const abortController = new AbortController();
    const statusSink = vi.fn();
    const spoolStop = vi.fn(async () => {});

    await monitorNextcloudTalkProvider({
      config,
      runtime: createRuntimeSpies(),
      abortSignal: abortController.signal,
      statusSink,
      createSpool: () => ({
        receive: vi.fn(async () => "accepted" as const),
        ready: vi.fn(async () => abortController.abort()),
        stop: spoolStop,
        waitForIdle: vi.fn(async () => {}),
      }),
    });

    expect(registry.httpRoutes).toHaveLength(0);
    expect(statusSink).not.toHaveBeenCalled();
    expect(spoolStop).toHaveBeenCalledOnce();
  });
});
