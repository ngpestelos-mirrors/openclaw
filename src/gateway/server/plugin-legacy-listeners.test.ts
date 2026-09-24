import { once } from "node:events";
import { request, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getWebhookLegacyListener } from "../../plugin-sdk/webhook-ingress.js";
import { readRequestBodyWithLimit } from "../../plugin-sdk/webhook-request-guards.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import {
  adoptPluginHttpRouteHandoffs,
  createPluginHttpRouteHandoff,
  registerPluginHttpRoute,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import { notifyPluginHttpRoutesChanged } from "../../plugins/http-route-owner.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { createGatewayHttpServer } from "../server-http.js";
import { startPluginLegacyListeners } from "./plugin-legacy-listeners.js";
import { createGatewayPluginRequestHandler } from "./plugins-http.js";

describe("legacy channel webhook ports", () => {
  let claim: TestPortClaim;
  let gatewayServer: Server;
  let stop: () => void;
  let registry = createEmptyPluginRegistry();
  const httpServers: Server[] = [];
  const cleanups: Array<() => void> = [];
  const warn = vi.fn();
  const url = (offset: number, path = "/webhook") =>
    `http://127.0.0.1:${claim.port + offset}${path}`;
  const endpoint = (offset: number) => ({ port: claim.port + offset, host: "127.0.0.1" });

  beforeAll(async () => {
    claim = await acquireTestPortBlock({ offsets: [0, 1, 2] });
    gatewayServer = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "/",
      handleHooksRequest: async () => false,
      resolvedAuth: { mode: "token", token: "synthetic-gateway-token", allowTailscale: false },
      getRuntimeConfig: () => ({ gateway: { trustedProxies: [] } }),
      handlePluginRequest: createGatewayPluginRequestHandler({
        registry,
        getRouteRegistry: () => registry,
        log: createSubsystemLogger("legacy-webhook-test"),
      }),
      shouldEnforcePluginGatewayAuth: () => false,
    });
    gatewayServer.listen(claim.port, "127.0.0.1");
    await once(gatewayServer, "listening");
    httpServers.push(gatewayServer);
    stop = startPluginLegacyListeners({
      gatewayServer,
      httpServers,
      getRegistry: () => registry,
      warn,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    registry = createEmptyPluginRegistry();
    const closed = httpServers.slice(1).map((server) => once(server, "close"));
    notifyPluginHttpRoutesChanged();
    await Promise.all(closed);
    resetGatewayWorkAdmission();
    warn.mockClear();
  });

  afterAll(async () => {
    stop();
    gatewayServer.closeAllConnections();
    await new Promise<void>((resolve) => gatewayServer.close(() => resolve()));
    await claim.release();
  });

  const register = (params: Partial<Parameters<typeof registerPluginHttpRoute>[0]> = {}) => {
    const unregister = registerPluginHttpRoute({
      registry,
      path: "/webhook",
      pluginId: "demo",
      source: "webhook",
      auth: "plugin",
      reuseExistingSameOwner: true,
      handler: (_req, res) => {
        res.end("accepted");
      },
      ...params,
    });
    cleanups.push(unregister);
    return unregister;
  };

  const listening = async () => {
    // Registration publications coalesce in one microtask; socket readiness is event-driven.
    await Promise.resolve();
    await Promise.all(
      httpServers
        .slice(1)
        .map((server) => (server.listening ? undefined : once(server, "listening"))),
    );
  };

  it("preserves raw bytes, peer identity, runtime scope, and Gateway admission without exposing other endpoints", async () => {
    const body = '{ "event": "synthetic", "spacing":  true }';
    register({
      legacyListener: endpoint(1),
      handler: async (req, res) => {
        if (req.headers["x-webhook-secret"] !== "synthetic-secret") {
          res.writeHead(401).end();
          return;
        }
        expect(await readRequestBodyWithLimit(req, { maxBytes: 1024, timeoutMs: 1000 })).toBe(body);
        res.setHeader("x-peer", req.socket.remoteAddress ?? "missing");
        const legacyListener = getWebhookLegacyListener(req);
        if (legacyListener) {
          expect(Reflect.set(legacyListener, "port", claim.port + 2)).toBe(false);
        }
        res.setHeader("x-legacy-listener", JSON.stringify(legacyListener ?? null));
        res.setHeader(
          "x-runtime-plugin",
          getPluginRuntimeGatewayRequestScope()?.pluginId ?? "missing",
        );
        res.end("accepted");
      },
    });
    register({ path: "/healthz", legacyListener: endpoint(1), handler: () => false });
    register({
      path: "/other",
      handler: (_req, res) => {
        res.end("other");
      },
    });
    await listening();
    for (const offset of [0, 1]) {
      const accepted = await fetch(url(offset), {
        method: "POST",
        body,
        headers: {
          "x-webhook-secret": "synthetic-secret",
          "x-openclaw-legacy-listener": JSON.stringify(endpoint(2)),
        },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toBe("accepted");
      expect(accepted.headers.get("x-peer")).toBe("127.0.0.1");
      expect(JSON.parse(accepted.headers.get("x-legacy-listener")!)).toEqual(
        offset === 0 ? null : endpoint(1),
      );
      expect(accepted.headers.get("x-runtime-plugin")).toBe("demo");
      expect((await fetch(url(offset), { method: "POST", body })).status).toBe(401);
    }
    expect((await fetch(url(0, "/other"))).status).toBe(200);
    for (const path of ["/other", "/healthz", "/tools/invoke", "/"]) {
      expect((await fetch(url(1, path))).status, path).toBe(404);
    }
    expect(tryBeginGatewaySuspendAdmission(() => {})?.commit()).toBe(true);
    expect(
      (
        await fetch(url(1), {
          method: "POST",
          body,
          headers: { "x-webhook-secret": "synthetic-secret" },
        })
      ).status,
    ).toBe(503);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retains only the restarting account's port across route handoff and registry replacement", async () => {
    const lease = createPluginRuntimeCapabilityLease("old-account");
    const first = withPluginHttpRouteRegistry(
      registry,
      () =>
        register({
          legacyListener: endpoint(1),
          handler: (req, res) => {
            res.end(String(getWebhookLegacyListener(req)?.port));
          },
        }),
      lease,
    );
    const second = register({ legacyListener: endpoint(2) });
    await listening();
    for (const offset of [1, 2]) {
      expect(await (await fetch(url(offset))).text()).toBe(String(claim.port + offset));
    }
    const originalListeners = httpServers.slice(1);
    const handoff = createPluginHttpRouteHandoff();
    cleanups.push(handoff.release);
    handoff.park(lease);
    lease.revoke();
    const oldPortClosed = once(originalListeners[1]!, "close");
    second();
    await oldPortClosed;
    expect((await fetch(url(1))).status).toBe(503);
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    const next = createEmptyPluginRegistry();
    adoptPluginHttpRouteHandoffs(registry, next);
    registry = next;
    const successor = register({
      legacyListener: endpoint(1),
      handler: (_req, res) => {
        register({ path: "/registered-by-request", throwOnFailure: true });
        res.end("replacement");
      },
    });
    first();
    expect(await (await fetch(url(1))).text()).toBe("replacement");
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    handoff.release();
    expect(httpServers.slice(1)).toEqual([originalListeners[0]]);
    expect(await (await fetch(url(1))).text()).toBe("replacement");
    const finalPortClosed = once(originalListeners[0]!, "close");
    successor();
    await finalPortClosed;
    expect(httpServers).toEqual([gatewayServer]);
  });

  it.each([true, false])(
    "settles real HTTP expectations (Gateway event handlers: %s)",
    async (gatewayEvents) => {
      const body = "synthetic webhook body";
      let handled = 0;
      register({
        legacyListener: endpoint(1),
        handler: async (req, res) => {
          expect(getWebhookLegacyListener(req)).toEqual(endpoint(1));
          expect(await readRequestBodyWithLimit(req, { maxBytes: 1024 })).toBe(body);
          handled += 1;
          res.end("accepted");
        },
      });
      await listening();
      const eventListeners = (["checkContinue", "checkExpectation"] as const).map((event) => ({
        event,
        listeners: gatewayServer.listeners(event),
      }));
      if (!gatewayEvents) {
        for (const { event } of eventListeners) {
          gatewayServer.removeAllListeners(event);
        }
      }
      const sendExpectation = (expectation: string) =>
        new Promise<{ status: number | undefined; continues: number }>((resolve, reject) => {
          let continues = 0;
          const req = request(
            url(1),
            {
              method: "POST",
              headers: {
                Expect: expectation,
                "Content-Length": Buffer.byteLength(body),
                Connection: "close",
              },
            },
            (res) => {
              res.on("error", reject);
              res.on("end", () => {
                req.destroy();
                resolve({ status: res.statusCode, continues });
              });
              res.resume();
            },
          );
          req.on("error", reject);
          req.on("continue", () => {
            continues += 1;
            req.end(body);
          });
          req.flushHeaders();
        });
      try {
        expect(await sendExpectation("100-continue")).toEqual({ status: 200, continues: 1 });
        expect(await sendExpectation("unsupported-expectation")).toEqual({
          status: 417,
          continues: 0,
        });
        expect(handled).toBe(1);
      } finally {
        if (!gatewayEvents) {
          for (const { event, listeners } of eventListeners) {
            for (const listener of listeners) {
              gatewayServer.on(event, listener);
            }
          }
        }
      }
    },
  );

  it("reports an occupied compatibility port while keeping the Gateway route operational", async () => {
    register({ legacyListener: endpoint(0) });
    await Promise.resolve();
    const listener = httpServers[1]!;
    await once(listener, "error");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Legacy webhook listener 127.0.0.1:${claim.port} failed`),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("update the external callback or reverse proxy to the Gateway port"),
    );
    expect(await (await fetch(url(0))).text()).toBe("accepted");
  });
});
