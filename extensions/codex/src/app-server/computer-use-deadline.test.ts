import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installCodexComputerUse } from "./computer-use.js";
import { createClientHarness } from "./test-support.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([0, -120_000, 120_000])(
  "keeps the request budget with wall-clock offset %i",
  async (offset) => {
    vi.setSystemTime(1_700_000_000_000);
    let reads = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => 1_700_000_000_000 + (reads++ === 0 ? 0 : offset),
    );
    const harness = createClientHarness();
    const timeouts: Array<number | undefined> = [];
    const requestSettled = vi.fn<(result: unknown) => void>();
    const originalRequest = harness.client.request.bind(harness.client);
    vi.spyOn(harness.client, "request").mockImplementation((method, params, options) => {
      timeouts.push(options?.timeoutMs);
      const pending = originalRequest(method, params, options);
      void pending.then(requestSettled, requestSettled);
      return pending;
    });
    // A written config mutation can keep install retirement waiting for process exit.
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true } },
      timeoutMs: 1_000,
    }).catch(() => undefined);
    try {
      const firstWrite = await harness.waitForWrite(0);
      expect(JSON.parse(firstWrite).method).toBe("experimentalFeature/enablement/set");
      expect(timeouts).toEqual([1_000]);
      await vi.advanceTimersByTimeAsync(999);
      expect(requestSettled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(requestSettled).toHaveBeenCalledOnce();
      const requestError = requestSettled.mock.calls[0]?.[0];
      expect(requestError).toBeInstanceOf(Error);
      expect(requestError).toHaveProperty("message", expect.stringContaining("timed out"));
    } finally {
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
  },
);
it.each([-120_000, 120_000])(
  "keeps the marketplace discovery budget after a %i ms wall-clock step",
  async (offset) => {
    const controller = new AbortController();
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as { id?: unknown; method?: string };
        if (message.id === undefined) {
          return;
        }
        send({
          id: message.id,
          result:
            message.method === "experimentalFeature/list"
              ? { data: [{ name: "plugins", enabled: true }] }
              : message.method === "plugin/list"
                ? { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
                : {},
        });
      },
    });
    const settled = vi.fn((result: unknown) => result);
    const operation = installCodexComputerUse({
      client: harness.client,
      pluginConfig: { computerUse: { autoInstall: true, marketplaceDiscoveryTimeoutMs: 4_000 } },
      timeoutMs: 30_000,
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .then(settled);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(
        harness.writes.some(
          (line) => (JSON.parse(line) as { method?: string }).method === "plugin/list",
        ),
      ).toBe(true);
      vi.setSystemTime(Date.now() + offset);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      expect(await operation).toMatchObject({
        name: "CodexComputerUseSetupError",
        status: { reason: "marketplace_missing" },
      });
    } finally {
      controller.abort();
      harness.client.close();
      harness.process.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(0);
      await operation;
    }
  },
);
