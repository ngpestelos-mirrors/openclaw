import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn<(options: GatewayRequestOptions) => void>());
vi.mock("./server-methods.js", () => ({ handleGatewayRequest }));

afterEach(() => vi.resetAllMocks());

describe("plugin panel runtime", () => {
  it.each(["operator.read", "operator.write"])(
    "binds the plugin ID, preserves %s, and rejects retirement before dispatch",
    async (scope) => {
      const registry = createEmptyPluginRegistry();
      const plugin = createPluginRecord({
        id: "review",
        source: "/synthetic/review/index.js",
        origin: "workspace",
        enabled: true,
        configSchema: false,
      });
      registry.plugins.push(plugin);
      markPluginRegistryActive(registry);
      const context = {
        trackExecution: trackAsyncWork,
        getRuntimeConfig: () => ({}),
      } as unknown as GatewayRequestContext;
      const client = createSyntheticPluginRuntimeClient({ scopes: [scope] });
      const runtime = createPluginRuntime();
      const open = () =>
        withPluginRuntimeGatewayRequestScope(
          { context, client, isWebchatConnect: () => false },
          () =>
            withPluginRuntimePluginScope(
              { pluginId: plugin.id, pluginOrigin: plugin.origin },
              () =>
                runtime.gateway.openPluginPanel({
                  panelId: "document",
                  sessionKey: "agent:main:main",
                }),
              registry,
            ),
        );
      try {
        handleGatewayRequest.mockImplementationOnce((options) => {
          options.sessionMutationCommitGuard?.();
          expect(options.client?.connect.scopes).toEqual([scope]);
          expect(options.req).toMatchObject({
            method: "ui.command",
            params: {
              sessionKey: "agent:main:main",
              command: {
                kind: "panel",
                panel: "plugin",
                pluginId: "review",
                panelId: "document",
                open: true,
              },
            },
          });
          options.respond(true, { ok: true });
        });
        await expect(open()).resolves.toEqual({ ok: true });
        handleGatewayRequest.mockImplementationOnce((options) => {
          plugin.enabled = false;
          options.sessionMutationCommitGuard?.();
          options.respond(true, { ok: true });
        });
        await expect(open()).rejects.toThrow("current plugin runtime");
        await expect(open()).rejects.toThrow("current plugin runtime");
        expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
      } finally {
        markPluginRegistryRetired(registry);
      }
    },
  );
});
