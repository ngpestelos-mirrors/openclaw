import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../model-catalog/remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "../../model-catalog/remote-refresh.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveModelCostConfig } from "../../utils/usage-format.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

it(
  "publishes one remote rows/pricing generation without blocking readers or repricing admitted runs",
  { timeout: 120_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "remote-catalog-publication",
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      },
    });
    const generatedAt = Date.now() + 86_400_000;
    const first = {
      schemaVersion: 1,
      generatedAt,
      sourceCommit: "remote-catalog-fixture",
      providers: {
        kimi: {
          models: [{ id: "remote-first", name: "Remote First", cost: { input: 1, output: 2 } }],
        },
      },
    };
    const next = {
      ...first,
      generatedAt: generatedAt + 1,
      providers: {
        kimi: {
          models: [
            { id: "remote-first", name: "Remote First", cost: { input: 7, output: 14 } },
            { id: "remote-next", name: "Remote Next", cost: { input: 9, output: 18 } },
          ],
        },
      },
    };
    let body = JSON.stringify(first);
    let hold = false;
    const acquiring = createDeferred();
    const held: ServerResponse[] = [];
    const replyProvider = (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(["known-provider-model"]));
    };
    const endpoint = createServer((request, response) => {
      if (request.url === "/catalog.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      } else if (hold) {
        held.push(response);
        acquiring.resolve();
      } else {
        replyProvider(response);
      }
    });
    try {
      endpoint.listen(0, "127.0.0.1");
      await once(endpoint, "listening");
      const address = endpoint.address();
      if (!address || typeof address === "string") {
        throw new Error("Remote catalog fixture did not bind a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const provider = "remote-catalog-fixture";
      await state.writeJson("catalog-plugin/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        configSchema: { type: "object", additionalProperties: false },
      });
      const pluginPath = await state.writeText(
        "catalog-plugin/index.cjs",
        `module.exports = {
      id: ${JSON.stringify(provider)}, register(api) {
        api.registerProvider({ id: ${JSON.stringify(provider)}, label: "Catalog fixture", auth: [],
          catalog: { order: "profile", async run(ctx) {
            const auth = ctx.resolveProviderAuth(${JSON.stringify(provider)});
            if (!auth.discoveryApiKey) return null;
            const { buildLiveModelProviderConfig, clearLiveCatalogCacheForTests } = await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
            clearLiveCatalogCacheForTests();
            return { provider: await buildLiveModelProviderConfig({
              providerId: ${JSON.stringify(provider)}, discoveryMode: "strict", discoveryApiKey: auth.discoveryApiKey,
              endpoint: ${JSON.stringify(baseUrl + "/provider")}, ttlMs: 86_400_000,
              providerConfig: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions" }, models: [],
              fetchGuard: async ({ url, init }) => ({ response: await fetch(url, init), finalUrl: url, release: async () => {} }),
              readRows: body => body,
              projectRows: rows => rows.map(id => ({ id, name: id, reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 })),
            }) };
          } },
        });
      },
    };`,
      );
      const token = "remote-catalog-gateway-fixture-token";
      const catalogConfig = { models: { catalogRefresh: { url: `${baseUrl}/catalog.json` } } };
      const bundledGeneratedAt = () => generatedAt - 1;
      const refresh = () =>
        refreshRemoteModelCatalog({ config: catalogConfig, force: true, bundledGeneratedAt });
      const cfg = {
        ...catalogConfig,
        agents: {
          defaults: { model: { primary: "kimi/remote-first" } },
          entries: { main: { workspace: state.workspaceDir } },
        },
        models: {
          ...catalogConfig.models,
          providers: {
            kimi: {
              baseUrl: "https://api.kimi.com/coding/",
              models: [{ id: "remote-first", name: "Remote First" }],
            },
          },
        },
        plugins: {
          allow: ["kimi", provider],
          load: { paths: [pluginPath] },
          slots: { memory: "none" },
        },
        update: { checkOnStart: false },
        gateway: { mode: "local", auth: { mode: "token", token } },
      };
      await state.writeConfig(cfg);
      state.applyEnv();
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`${provider}:default`]: { type: "api_key", provider, key: "catalog-fixture-key" },
        },
      });
      setRemoteModelCatalogOverlaySourcesForTest({ bundledGeneratedAt });
      expect((await refresh()).status).toBe("updated");
      const { client, server } = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin"],
      });
      try {
        await server.startupSettled;
        const list = (refresh = false) =>
          client.request<ModelsListResult>("models.list", { view: "all", refresh });
        const kimiIds = (catalog: ModelsListResult) =>
          catalog.models.filter((row) => row.provider === "kimi").map((row) => row.id);
        expect(kimiIds(await list(true))).toContain("remote-first");
        const config = getRuntimeConfig();
        const input = {
          config,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
        };
        await using oldRun = await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
        });
        const oldModel = expectDefined(
          oldRun.snapshot.createStores().modelRegistry.find("kimi", "remote-first"),
          "old run model",
        );
        expect(oldModel.cost.input).toBe(1);
        hold = true;
        body = JSON.stringify(next);
        expect((await refresh()).status).toBe("updated");
        const refreshing = list(true);
        void refreshing.catch(acquiring.reject);
        await withTestTimeout(
          acquiring.promise,
          10_000,
          "Candidate catalog acquisition did not reach the provider",
        );
        const saved = await withTestTimeout(
          Promise.all([list(), list(), list()]),
          1_000,
          "Picker waited for a candidate provider",
        );
        for (const catalog of saved) {
          expect(kimiIds(catalog)).toContain("remote-first");
          expect(kimiIds(catalog)).not.toContain("remote-next");
          expect(
            catalog.models.some(
              (row) => row.provider === provider && row.id === "known-provider-model",
            ),
          ).toBe(true);
        }
        expect(
          resolveModelCostConfig({
            config,
            agentDir: state.agentDir(),
            provider: "kimi",
            model: "remote-first",
          })?.input,
        ).toBe(1);
        hold = false;
        for (const response of held.splice(0)) {
          replyProvider(response);
        }
        const published = await refreshing;
        expect(kimiIds(published)).toContain("remote-next");
        expect(
          resolveModelCostConfig({
            config,
            agentDir: state.agentDir(),
            provider: "kimi",
            model: "remote-next",
          })?.input,
        ).toBe(9);
        expect(
          withPreparedModelRuntimePluginGenerationScope(
            oldRun.pluginGeneration,
            () =>
              resolveModelCostConfig({
                config,
                agentDir: state.agentDir(),
                provider: "kimi",
                model: "remote-first",
              })?.input,
          ),
        ).toBe(1);
        expect(oldModel.cost.input).toBe(1);
        await using newRun = await acquireAgentRunPreparedModelRuntime(input, {
          catalogMode: "static",
        });
        expect(
          newRun.snapshot.createStores().modelRegistry.find("kimi", "remote-first")?.cost.input,
        ).toBe(7);
        for (const rejected of [
          "{",
          JSON.stringify({ ...next, generatedAt: generatedAt + 2, minVersion: "9999.1.1" }),
        ]) {
          body = rejected;
          expect((await refresh()).status).toBe("error");
          expect(kimiIds(await list())).toContain("remote-next");
          expect(
            resolveModelCostConfig({
              config,
              agentDir: state.agentDir(),
              provider: "kimi",
              model: "remote-first",
            })?.input,
          ).toBe(7);
        }
        body = JSON.stringify(first);
        const stale = await refresh();
        expect(stale).toMatchObject({ status: "unchanged", generatedAt: generatedAt + 1 });
        expect(kimiIds(await list())).toContain("remote-next");
        expect(
          resolveModelCostConfig({
            config,
            agentDir: state.agentDir(),
            provider: "kimi",
            model: "remote-first",
          })?.input,
        ).toBe(7);
      } finally {
        hold = false;
        for (const response of held.splice(0)) {
          replyProvider(response);
        }
        await disconnectGatewayClient(client);
        await server.close();
      }
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      setRemoteModelCatalogOverlaySourcesForTest();
      await state.cleanup();
    }
  },
);
