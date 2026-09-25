import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelsListResult } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { startSerializedSnapshotBuildBatch } from "../../agents/prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import { retainPreparedPluginGeneration } from "../../agents/prepared-model-runtime.plugin-lifetime.js";
import { getRuntimeConfig } from "../../config/config.js";
import * as updateStartup from "../../infra/update-startup.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../../model-catalog/remote-overlay.test-support.js";
import { refreshRemoteModelCatalog } from "../../model-catalog/remote-refresh.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveModelCostConfig } from "../../utils/usage-format.js";
import { disconnectGatewayClient, startGatewayWithClient } from "../test-helpers.e2e.js";

afterEach(() => vi.restoreAllMocks());

it(
  "publishes one remote rows/pricing generation without blocking readers or repricing admitted runs",
  { timeout: 120_000 },
  async () => {
    const createUpdateCheck = updateStartup.createGatewayUpdateCheck;
    vi.spyOn(updateStartup, "createGatewayUpdateCheck").mockImplementation((params) => ({
      ...createUpdateCheck(params),
      start: () => {},
    }));
    const unexpectedRestart = vi.fn(() => {
      throw new Error("Remote catalog publication unexpectedly requested a Gateway restart");
    });
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
    const modelMetadata = {
      api: "anthropic-messages",
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
    };
    const first = {
      schemaVersion: 1,
      generatedAt,
      sourceCommit: "remote-catalog-fixture",
      providers: {
        kimi: {
          models: [
            {
              ...modelMetadata,
              id: "remote-first",
              name: "Remote First",
              cost: { input: 1, output: 2 },
            },
          ],
        },
      },
    };
    const next = {
      ...first,
      generatedAt: generatedAt + 1,
      providers: {
        kimi: {
          models: [
            {
              ...modelMetadata,
              id: "remote-first",
              name: "Remote First",
              cost: { input: 7, output: 14 },
            },
            {
              ...modelMetadata,
              id: "remote-next",
              name: "Remote Next",
              cost: { input: 9, output: 18 },
            },
          ],
        },
      },
    };
    let body = JSON.stringify(first);
    let hold: "none" | "all" | "next" = "none";
    let acquiring = createDeferred();
    let exitWorkerOnce = false;
    let providerThread = 0;
    const held: ServerResponse[] = [];
    const replyProvider = (response: ServerResponse) => {
      response.writeHead(200, { "content-type": "application/json" });
      const payload = exitWorkerOnce ? { exitWorker: true } : ["known-provider-model"];
      exitWorkerOnce = false;
      response.end(JSON.stringify(payload));
    };
    const releaseProvider = () => {
      hold = "none";
      for (const response of held.splice(0)) {
        if (!response.destroyed) {
          replyProvider(response);
        }
      }
    };
    const endpoint = createServer((request, response) => {
      if (request.url === "/catalog.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      } else {
        providerThread = Number(
          new URL(request.url ?? "/", "http://fixture.invalid").searchParams.get("thread"),
        );
        if (hold !== "none") {
          held.push(response);
          if (hold === "next") {
            hold = "none";
          }
          acquiring.resolve();
        } else {
          replyProvider(response);
        }
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
              endpoint: ${JSON.stringify(baseUrl + "/provider?thread=")} + require("node:worker_threads").threadId, ttlMs: 86_400_000,
              providerConfig: { baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions" }, models: [],
              fetchGuard: async ({ url, init }) => ({ response: await fetch(url, init), finalUrl: url, release: async () => {} }),
              readRows: body => {
                if (body.exitWorker) {
                  if (require("node:worker_threads").isMainThread) throw new Error("Expected catalog worker");
                  process.exit(42);
                }
                return body;
              },
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
              api: "anthropic-messages",
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
        hotReloadRecovery: unexpectedRestart,
      });
      try {
        await server.startupSettled;
        const list = (refresh = false) =>
          client.request<ModelsListResult>("models.list", { view: "all", refresh });
        const kimiIds = (catalog: ModelsListResult) =>
          catalog.models.filter((row) => row.provider === "kimi").map((row) => row.id);
        const currentPrice = (model = "remote-first") =>
          resolveModelCostConfig({
            config: getRuntimeConfig(),
            agentDir: state.agentDir(),
            provider: "kimi",
            model,
          })?.input;
        const settleInterrupted = async (pending: Promise<ModelsListResult>, phase: string) => {
          const outcome = await withTestTimeout(
            pending.then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            ),
            15_000,
            `Superseded catalog request did not settle: ${phase}`,
          );
          if ("error" in outcome) {
            expect(outcome.error).toMatchObject({ code: "UNAVAILABLE" });
          }
        };
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
        hold = "all";
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
        const firstThread = providerThread;
        exitWorkerOnce = true;
        releaseProvider();
        await settleInterrupted(refreshing, "candidate worker exit");
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(kimiIds(await list())).not.toContain("remote-next");
        expect(
          resolveModelCostConfig({
            config,
            agentDir: state.agentDir(),
            provider: "kimi",
            model: "remote-first",
          })?.input,
        ).toBe(1);
        acquiring = createDeferred();
        hold = "all";
        const retried = list(true);
        void retried.catch(acquiring.reject);
        await withTestTimeout(
          acquiring.promise,
          10_000,
          "Replacement worker did not acquire catalog",
        );
        expect(providerThread).not.toBe(firstThread);
        expect(
          kimiIds(await withTestTimeout(list(), 1_000, "Picker waited during retry")),
        ).not.toContain("remote-next");
        releaseProvider();
        const published = await retried;
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
        const retirement = new AbortController();
        const retainedBuild = startSerializedSnapshotBuildBatch(
          [
            {
              input: { ...input, allowGatewaySubagentBinding: true },
              pluginGeneration: oldRun.pluginGeneration,
              catalogOwner: oldRun.snapshot.catalogOwner,
              retirementSignal: retirement.signal,
              isGenerationCurrent: () => !retirement.signal.aborted,
            },
          ],
          new Map(),
          30_000,
          "static",
        );
        const retained = expectDefined((await retainedBuild.pending)[0], "retained generation");
        const releaseRetained = retainPreparedPluginGeneration(retained.pluginGeneration);
        try {
          const retainedCatalog = expectDefined(
            await retained.snapshot.loadFullModelCatalog?.({
              refresh: true,
              waitForCompletion: true,
            }),
            "retained catalog",
          );
          const retainedIds = retainedCatalog.entries
            .filter((row) => row.provider === "kimi")
            .map((row) => row.id);
          expect(retainedIds).toContain("remote-first");
          expect(retainedIds).not.toContain("remote-next");
        } finally {
          retirement.abort();
          await releaseRetained();
          await retainedBuild.completion;
        }
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

        const committedThread = providerThread;
        exitWorkerOnce = true;
        await settleInterrupted(list(true), "committed worker exit");
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(kimiIds(await list(true))).toContain("remote-next");
        expect(providerThread).not.toBe(committedThread);
        expect(currentPrice()).toBe(7);

        const finalCatalog = {
          ...next,
          generatedAt: generatedAt + 2,
          providers: {
            kimi: {
              models: [
                {
                  ...modelMetadata,
                  id: "remote-first",
                  name: "Remote First",
                  cost: { input: 11, output: 22 },
                },
                ...next.providers.kimi.models.slice(1),
                {
                  ...modelMetadata,
                  id: "remote-last",
                  name: "Remote Last",
                  cost: { input: 13, output: 26 },
                },
              ],
            },
          },
        };
        body = JSON.stringify(finalCatalog);
        expect((await refresh()).status).toBe("updated");
        for (const publication of ["config", "auth"] as const) {
          acquiring = createDeferred();
          hold = "next";
          const pending = list(true);
          void pending.catch(acquiring.reject);
          await withTestTimeout(acquiring.promise, 10_000, "Candidate did not reach held provider");
          if (publication === "config") {
            const snapshot = await client.request<{ hash: string }>("config.get", {});
            await client.request("config.patch", {
              baseHash: snapshot.hash,
              raw: JSON.stringify({ logging: { level: "debug" } }),
            });
            expect(getRuntimeConfig().logging?.level).toBe("debug");
          } else {
            await client.request("models.authSetApiKey", {
              provider,
              apiKey: "catalog-fixture-next-key",
              agentId: "main",
            });
          }
          const dispatch = await withTestTimeout(
            loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" }),
            15_000,
            "Concurrent publication did not finish",
          );
          expect(dispatch?.agentId).toBe("main");
          const current = await withTestTimeout(
            list(),
            1_000,
            "Supersession retired current readers",
          );
          expect(kimiIds(current)).toContain("remote-next");
          expect(kimiIds(current)).not.toContain("remote-last");
          expect(currentPrice()).toBe(7);
          releaseProvider();
          await settleInterrupted(pending, publication);
          expect(kimiIds(await list())).not.toContain("remote-last");
          expect(currentPrice()).toBe(7);
        }
        expect(kimiIds(await list(true))).toContain("remote-last");
        expect(currentPrice()).toBe(11);
        expect(currentPrice("remote-last")).toBe(13);
        expect(oldModel.cost.input).toBe(1);
        expect(
          newRun.snapshot.createStores().modelRegistry.find("kimi", "remote-first")?.cost.input,
        ).toBe(7);

        const beforeDisable = await client.request<{ hash: string }>("config.get", {});
        await client.request("config.patch", {
          baseHash: beforeDisable.hash,
          raw: JSON.stringify({ models: { catalogRefresh: { enabled: false } } }),
        });
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        const withoutRemote = await list(true);
        expect(kimiIds(withoutRemote)).not.toContain("remote-next");
        expect(kimiIds(withoutRemote)).not.toContain("remote-last");
        expect(currentPrice("remote-last")).toBeUndefined();
        const disabledThread = providerThread;
        exitWorkerOnce = true;
        await settleInterrupted(list(true), "worker exit with remote catalog disabled");
        await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(kimiIds(await list(true))).not.toContain("remote-last");
        expect(currentPrice("remote-last")).toBeUndefined();
        expect(providerThread).not.toBe(disabledThread);
        expect(
          [oldRun, newRun].map(({ pluginGeneration }) =>
            withPreparedModelRuntimePluginGenerationScope(
              pluginGeneration,
              () =>
                resolveModelCostConfig({
                  config,
                  agentDir: state.agentDir(),
                  provider: "kimi",
                  model: "remote-first",
                })?.input,
            ),
          ),
        ).toEqual([1, 7]);
        expect(unexpectedRestart).not.toHaveBeenCalled();
      } finally {
        releaseProvider();
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
