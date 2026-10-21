import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, it } from "vitest";
import { closeTrackedBrowserTabsForSessions } from "./browser-maintenance.js";
import { resolveCdpTabOwnership } from "./src/browser/cdp.helpers.js";
import { resolveBrowserConfig } from "./src/browser/config.js";
import * as registry from "./src/browser/session-tab-registry.js";
import {
  getBrowserSessionTabStore,
  initializeBrowserSessionTabStore,
} from "./src/browser/session-tab-store.js";

it("closes owned tabs over their transports and rechecks claims after runtime lookup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const requests: string[] = [];
    const closedTargets: string[] = [];
    const targets = new Set(["owned", "user"]);
    const server = createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      response.setHeader("content-type", "application/json");
      if (request.url === "/json/version") {
        response.end(
          JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }),
        );
      } else if (request.method === "DELETE") {
        requests.push(`${request.method} ${request.url}`);
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const ws = new WebSocketServer({ server });
    ws.on("connection", (socket) => {
      const reply = (id: number, result: unknown) => socket.send(JSON.stringify({ id, result }));
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToString(data)) as {
          id: number;
          method: string;
          params?: { targetId?: string };
        };
        if (message.method === "Target.getTargets") {
          reply(message.id, {
            targetInfos: [...targets].map((targetId) => ({ targetId, type: "page" })),
          });
        } else if (message.method === "Target.closeTarget") {
          const targetId = message.params?.targetId ?? "";
          closedTargets.push(targetId);
          reply(message.id, { success: targets.delete(targetId) });
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const cdpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = {
      browser: { profiles: { remote: { driver: "existing-session" as const, cdpUrl } } },
    };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    initializeBrowserSessionTabStore({
      state: {
        openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
      },
    });
    const sessionKey = "agent:main:transport-cleanup";
    const close = () => closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
    const forget = () =>
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab: async () => {},
      });
    const route = { kind: "browser-control" as const, baseUrl: cdpUrl };
    const tabDefaults = { sessionKey, profile: "remote" };
    try {
      await registry.trackSessionBrowserTab({ ...tabDefaults, targetId: "volatile", route });
      await expect(close()).resolves.toBe(1);
      expect(requests).toEqual(["DELETE /tabs/volatile?targetIdMode=raw&profile=remote"]);

      for (const firstKind of ["sweep", "lifecycle"] as const) {
        const joined = { ...tabDefaults, targetId: `joined-${firstKind}`, route };
        await registry.trackSessionBrowserTab({ ...joined, now: 1_000 });
        const lifecycle = () =>
          registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
        const sweep = () => registry.sweepTrackedBrowserTabs({ now: 20_000, idleMs: 1 });
        const before = requests.length;
        const first = firstKind === "sweep" ? sweep() : lifecycle();
        await Promise.resolve();
        expect(requests).toHaveLength(before);
        await registry.touchSessionBrowserTab({ ...joined, now: 11_000 });
        const second = firstKind === "sweep" ? lifecycle() : sweep();
        const results = await Promise.all([first, second]);
        expect.soft(results.reduce((total, closed) => total + closed, 0)).toBe(1);
        expect
          .soft(requests.slice(before))
          .toEqual([`DELETE /tabs/joined-${firstKind}?targetIdMode=raw&profile=remote`]);
        await forget();
      }

      const ownership = await resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "owned",
      });
      expect(ownership.status).toBe("durable");
      const tab = { ...tabDefaults, targetId: "owned", ownership };
      await registry.trackSessionBrowserTab({ ...tab, now: 1_000 });
      const resolved = resolveBrowserConfig(config.browser, config);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const sweep = registry.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        getResolvedBrowserConfig: async () => {
          entered.resolve();
          await release.promise;
          return resolved;
        },
      });
      try {
        await entered.promise;
        await registry.touchSessionBrowserTab({ ...tab, now: 11_000 });
      } finally {
        release.resolve();
      }
      await expect(sweep).resolves.toBe(0);
      expect(closedTargets).toEqual([]);
      const retained = await getBrowserSessionTabStore().entries();
      expect(retained).toHaveLength(1);
      expect(retained[0]?.value).not.toHaveProperty("cleanupAttemptToken");

      await expect(close()).resolves.toBe(1);
      expect(closedTargets).toEqual(["owned"]);
      expect([...targets]).toEqual(["user"]);
      expect(await getBrowserSessionTabStore().entries()).toEqual([]);
      await expect(close()).resolves.toBe(0);
      expect(requests).toHaveLength(3);
      expect(closedTargets).toHaveLength(1);
    } finally {
      await forget();
      resetPluginStateStoreForTests();
      for (const client of ws.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        ws.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
