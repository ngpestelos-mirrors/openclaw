import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";

const catalogModel = {
  id: "codex-latest",
  displayName: "Codex (Latest)",
  upstream: "codex-latest",
  capabilities: ["llm.responses"],
  supportedReasoningEfforts: ["high"],
};
const catalogProvider = {
  id: "private",
  openaiCompatible: true,
  nativeBaseUrl: "/v1/native/private",
  models: [catalogModel],
};
const apiKey = { source: "env", provider: "default", id: "CLAWROUTER_API_KEY" } as const;
const primaryModel = (openai: boolean) => ({
  primary: openai ? "openai/codex-latest" : "clawrouter/codex-latest",
});

describe("ClawRouter cold prepared catalog", () => {
  let state: OpenClawTestState;
  let server: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
  let pool: WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult> | undefined;

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
    if (server) {
      server.listener.closeAllConnections();
      await server.releaseListener();
      await server.claim.release();
      server = undefined;
    }
    await state.cleanup();
  });

  it.each([
    ["publishes without a sibling catalog", false, false],
    ["publishes with a sibling catalog", true, false],
    ["discovers a provider introduced by refreshed auth", true, true],
  ] as const)("%s", async (_label, sibling, refreshedAuth) => {
    state = await createOpenClawTestState({
      label: "clawrouter-catalog",
      env: {
        CLAWROUTER_API_KEY: refreshedAuth ? undefined : "catalog-test-key",
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        CODEX_HOME: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    server = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          requests.push({ url: request.url, authorization: request.headers.authorization });
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ providers: [catalogProvider] }));
        }),
    });
    const baseUrl = `http://127.0.0.1:${server.claim.port}/private`;
    const agentId = "private-openclaw";
    const plugins = ["clawrouter", ...(sibling ? ["openai"] : [])];
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none" },
        allow: plugins,
        entries: Object.fromEntries(plugins.map((id) => [id, { enabled: true }])),
      },
      models: {
        providers: {
          clawrouter: {
            baseUrl,
            ...(refreshedAuth ? {} : { apiKey }),
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: primaryModel(sibling),
          models: Object.fromEntries(
            plugins
              .filter((id) => !refreshedAuth || id !== "clawrouter")
              .map((id) => [`${id}/codex-latest`, { agentRuntime: { id: "openclaw" } }]),
          ),
          modelPolicy: { allow: ["clawrouter/codex-latest"] },
        },
        entries: { [agentId]: { model: primaryModel(refreshedAuth) } },
      },
    };
    const input = {
      agentId,
      agentDir: state.agentDir(agentId),
      workspaceDir: state.workspaceDir,
      config,
      env: state.env,
      skipCredentials: true,
    };
    // The E2E owner builds the real plugin artifacts before the catalog deadline starts.
    const prepared = await prepareWorkspaceBuildGroup([input], "static", {
      preferBuiltPluginArtifacts: true,
    });
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    if (refreshedAuth) {
      // The new credential must enter through the worker's durable auth refresh,
      // without a configured model preloading its provider into the startup scope.
      expect(value.providerIds).not.toContain("clawrouter");
      await state.writeAuthProfiles(
        createAuthProfileStoreFixture({
          "clawrouter:default": createApiKeyCredential("clawrouter", "catalog-test-key"),
        }),
        agentId,
      );
    }
    const sourceCaptureDirectory = state.path("worker-captures");
    fs.mkdirSync(sourceCaptureDirectory);
    pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      workerOptions: { env: state.env, workerData: { sourceCaptureDirectory } },
    });
    const result = await pool.run(
      {
        value,
        request: {
          kind: "catalog",
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: state.env }),
        },
      },
      { timeoutMs: 30_000 },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "catalog") {
      throw new Error("catalog worker did not publish a catalog");
    }
    expect(result.runtimeModels.get("clawrouter")).toContainEqual(
      expect.objectContaining({
        provider: "clawrouter",
        id: "codex-latest",
        api: "openai-responses",
        baseUrl: `${baseUrl}/v1`,
      }),
    );
    const projector = createModelCatalogDecisions({
      cfg: config,
      agentId,
      snapshot: result.snapshot,
      metadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      preparedAuthStore: result.authStore,
      preparedRuntimeAuthModes: result.authModes,
    });
    const catalog = await buildModelsListResult({
      source: {
        kind: "gateway",
        context: { getRuntimeConfig: () => config } as GatewayRequestContext,
      },
      agentId,
      params: { view: refreshedAuth ? "all" : "configured", preparedOnly: true },
      preloadedCatalog: { agentId, config, snapshot: result.snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });
    expect(catalog.models).toContainEqual(
      expect.objectContaining({
        provider: "clawrouter",
        id: "codex-latest",
        name: "Codex (Latest)",
        reasoning: true,
        available: true,
      }),
    );
    expect(requests).toEqual([
      { url: "/private/v1/catalog", authorization: "Bearer catalog-test-key" },
    ]);
  });
});
