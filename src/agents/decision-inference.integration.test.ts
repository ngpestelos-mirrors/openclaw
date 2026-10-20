import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { DecisionBatchResultV2, DecisionRuntimeV2 } from "../decisions/types-v2.js";
import type { DecisionRuntimeV1 } from "../decisions/types.js";
import {
  createContext,
  createOperatorClient,
} from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  assertProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import * as modelRoutes from "../plugins/provider-model-routes.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as profileReader from "../state/user-profile-list.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import { executePreparedDecision } from "./decision-inference.js";
import {
  decisionOptions,
  readDecisionRequest,
  trackDecisionUsage,
  unavailable,
} from "./decision-inference.test-support.js";
import * as modelAuth from "./model-auth-provider.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-prepared-path");
let profileState: OpenClawTestState | undefined;
const textBatch = (text = "synthetic evidence") => ({
  state: { type: "text" as const, text },
  questions: { q: { type: "boolean" as const } },
});
const decision: ModelDecisionCapabilities = {
  protocol: "fixture",
  input: ["text"],
  questions: { boolean: { probabilities: "none", abstention: true } },
};
const catalogTransport = {
  api: "openai-completions" as const,
  baseUrl: "https://catalog.fixture.invalid/v1",
};
const nativeModel = { id: "native", name: "Native fixture" };
function fixtureConfig(
  root: string,
  decisionModel: string,
  plugins: NonNullable<OpenClawConfig["plugins"]>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "unrelated/not-configured",
        decisionModel,
        workspace: path.join(root, "workspace"),
      },
    },
    plugins: { slots: { memory: "none" }, ...plugins },
  };
}
type Trace = {
  calls: number;
  context?: DecisionProviderContextV2;
  onDispatch?: () => void;
  prepare?: () => Promise<void>;
  beforeRequest?: (context: DecisionProviderContextV2) => void;
  fetch?: typeof fetch;
  work?: Promise<void>;
  authenticated: boolean;
  usage?: DecisionBatchResultV2["usage"];
  modelKeys?: string[];
  profileId?: string;
  agentId?: string;
  modelContextWindow?: number;
  resultReads?: number;
  resultOverride?: { value: unknown };
  modelBilling?: unknown;
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
  modelRequest?: unknown;
  modelApi?: string;
  preparedApi?: string;
  evaluate?: DecisionRuntimeV2["evaluateV2"];
  evaluateV1?: DecisionRuntimeV1["evaluate"];
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  resetDiagnosticEventsForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  await profileState?.cleanup();
  profileState = undefined;
});

it.each([
  "plugin",
  "plugin-route-fresh",
  "plugin-route-missing",
  "plugin-route-multiple",
  "plugin-route-cleared",
  "agent",
  "profile",
  "missing",
  "exchange",
  "plugin-revoked-context",
  "plugin-revoked-model",
  "plugin-revoked-disabled",
  "plugin-preparation-deadline",
  "plugin-physical-deadline",
] as const)(
  "runs the retained decision SDK through real preparation without primary fallback or fabricated chat fields (%s)",
  async (authScope) => {
    const pluginAuth = authScope.startsWith("plugin");
    const deadlinePhase =
      authScope === "plugin-preparation-deadline"
        ? "preparation"
        : authScope === "plugin-physical-deadline"
          ? "provider"
          : undefined;
    const root = roots.make("decision-prepared-integration-");
    const pluginRoot = path.join(root, "plugin");
    const emptyBundled = path.join(root, "bundled");
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(emptyBundled);
    const id = "decision-prepared-fixture";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: id,
      providerId: id,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { decisionProviders: [id] },
        modelCatalog: {
          providers: {
            [id]: {
              authScope: pluginAuth ? "plugin" : "agent",
              ...(pluginAuth ? {} : catalogTransport),
              models: [
                {
                  ...nativeModel,
                  ...(authScope === "exchange"
                    ? {
                        ...catalogTransport,
                        contextWindow: 4096,
                        maxTokens: 256,
                      }
                    : {}),
                  inference: {
                    chat: authScope === "exchange",
                    decision: {
                      ...decision,
                      billing: {
                        unit: "tokens",
                        source: "provider-catalog",
                        usdPerMillion: { input: 2, output: 0 },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      [
        'const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];',
        "module.exports = { id: " + JSON.stringify(id) + ", register(api) {",
        "api.registerDecisionProvider({ id: " + JSON.stringify(id) + ", contractVersion: 2,",
        'provider: { label: "Synthetic", auth: [], authScope: ' +
          JSON.stringify(pluginAuth ? "plugin" : "agent") +
          ", " +
          "async augmentModelCatalog({ entries }) { await trace.prepare?.(); return entries; }," +
          (authScope === "profile" || authScope === "missing"
            ? ""
            : 'resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },') +
          (authScope === "agent" || authScope === "profile" || authScope === "missing"
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
            : "") +
          (authScope === "exchange"
            ? 'normalizeResolvedModel(context) { return { ...context.model, api: "openai-responses" }; }, prepareRuntimeAuth(context) { trace.preparedApi=context.model.api; return { apiKey: context.apiKey, baseUrl: "https://entitlement.fixture.invalid/v1", request: { headers: { "x-fixture-entitlement": "synthetic-entitlement" }, auth: { mode: "header", headerName: "x-fixture-auth", value: "synthetic-exchanged-header" } } }; },'
            : "") +
          "} ,",
        'async evaluate(batch, context) { trace.calls++; trace.context=context; trace.profileId=context.auth.profileId; trace.agentId=context.agentId; trace.onDispatch?.(); await trace.work; trace.beforeRequest?.(context); if (!context.isAdmissible()) return { status: "unavailable", reason: "unsupported-input" }; await trace.fetch?.("https://dispatch.fixture.invalid/v1/decisions", { method: "POST" }); trace.authenticated = context.auth.apiKey === "synthetic-prepared-token"; trace.modelKeys = Object.keys(context.model); trace.modelContextWindow = context.model.contextWindow; trace.modelBilling=context.model.inference?.decision?.billing; trace.modelBaseUrl=context.model.baseUrl; trace.modelHeaders=context.model.headers; trace.modelRequest=context.model[Symbol.for("openclaw.modelProviderRequestTransport")]; trace.modelApi=context.model.api; let reads = 0; return { status: "ok", get result() { trace.resultReads = ++reads; if (trace.resultOverride) return trace.resultOverride.value; return { model: context.model.id, answers: { q: reads === 1 ? { type: "boolean", answer: null } : { type: "boolean", probabilityTrue: 0.75 } }, usage: trace.usage }; } }; }',
        "}); trace.evaluate = api.runtime.decisions.evaluateV2; } };",
      ].join("\n"),
    );
    const trace: Trace = {
      calls: 0,
      authenticated: false,
      usage: { inputTokens: 100, costUsd: 0 },
    };
    Reflect.set(globalThis, traceKey, trace);
    if (authScope === "profile" || deadlinePhase) {
      profileState = await createOpenClawTestState({
        label: "decision-agent-profile",
        applyEnv: false,
      });
    }
    if (authScope === "profile") {
      // A synthetic key exists only in the operation agent store: no config/env credential.
      await profileState!.writeAuthProfiles({
        version: 1,
        profiles: {
          [id + ":agent"]: { type: "api_key", provider: id, key: "synthetic-prepared-token" },
        },
      });
    }
    const cfg = fixtureConfig(
      root,
      id + "/native" + (authScope === "profile" ? "@" + id + ":agent" : ""),
      {
        load: { paths: [pluginRoot] },
        entries: {
          [id]: { enabled: true, llm: { allowedCompletionModels: [id + "/native"] } },
        },
      },
    );
    if (!pluginAuth) {
      cfg.models = {
        providers: {
          [id]: {
            ...catalogTransport,
            headers: { "x-provider": "provider", "X-Precedence": "provider" },
            request: { headers: { "x-precedence": "request", "x-request": "request" } },
            models: [
              {
                ...nativeModel,
                headers: { "x-model": "model", "X-PRECEDENCE": "model" },
                ...(authScope === "exchange" ? { contextWindow: 4096 } : {}),
                maxTokens: 256,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
            ...(authScope === "profile" || authScope === "missing"
              ? {}
              : { apiKey: "synthetic-prepared-token" }),
          },
        },
      };
    }
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      ...profileState?.envVars,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: profileState?.stateDir ?? path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      setRuntimeConfigSnapshot(cfg);
      const registry = await loadAndActivateRootPluginRegistry({
        config: cfg,
        env,
        workspaceDir: path.join(root, "workspace"),
      });
      expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
      const evaluate = trace.evaluate;
      if (!evaluate) {
        throw new Error("Decision registration omitted its runtime capability");
      }
      const usageEvents = trackDecisionUsage();
      if (deadlinePhase) {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        if (deadlinePhase === "preparation") {
          trace.prepare = async () => {
            entered.resolve();
            await release.promise;
          };
        } else {
          trace.onDispatch = () => entered.resolve();
          trace.work = release.promise;
        }
        const context = createContext();
        context.getRuntimeConfig = () => cfg;
        const client = createOperatorClient({
          profileName: "decision-native-deadline",
          scopes: ["operator.write"],
        });
        let now = 1_000;
        const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
        const originalPrepare = profileReader.prepareUserProfileIdentity;
        const preparation = vi
          .spyOn(profileReader, "prepareUserProfileIdentity")
          .mockImplementationOnce(async (...args) => {
            const prepared = await originalPrepare(...args);
            now += 200;
            // Real authority I/O completes before the host's remaining-budget timer starts.
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            return prepared;
          });
        const controller = new AbortController();
        const pending = withPluginRuntimeGatewayRequestScope(
          { client, context, hasCurrentClientAuthority: () => true, isWebchatConnect: () => false },
          () =>
            evaluate(
              textBatch("synthetic deadline"),
              decisionOptions({ timeoutMs: 500, signal: controller.signal }),
            ),
        );
        let settled = false;
        const settlement = pending.then(
          (outcome) => {
            settled = true;
            return { outcome };
          },
          (error: unknown) => {
            settled = true;
            return { error };
          },
        );
        const providerHost = registry.decisionProviders[0]!.host;
        try {
          await Promise.race([entered.promise, settlement]);
          expect(preparation).toHaveBeenCalledOnce();
          expect(settled).toBe(false);
          expect(trace.calls).toBe(deadlinePhase === "provider" ? 1 : 0);
          now += 299;
          await vi.advanceTimersByTimeAsync(299);
          if (deadlinePhase === "provider") {
            expect(trace.context).toMatchObject({
              deadlineMonotonicMs: 1_500,
              signal: { aborted: false },
            });
          }
          now += 1;
          await vi.advanceTimersByTimeAsync(1);
          if (deadlinePhase === "provider") {
            expect(trace.context?.signal.aborted).toBe(true);
          }
          // Deadline cancellation retains the slot until catalog/provider work really settles.
          expect(settled).toBe(false);
          expect(providerHost.inspect(cfg).activeRequests).toBe(1);
          release.resolve();
          expect(await settlement).toEqual({ outcome: unavailable("deadline") });
          expect(trace.calls).toBe(deadlinePhase === "provider" ? 1 : 0);
          expect(providerHost.inspect(cfg).activeRequests).toBe(0);
          expect(usageEvents).toEqual([]);
        } finally {
          release.resolve();
          controller.abort();
          await settlement;
          vi.useRealTimers();
          preparation.mockRestore();
          clock.mockRestore();
        }
        return;
      }
      const credentialPreparation = vi.spyOn(modelAuth, "resolveApiKeyForProviderCore");
      if (authScope.startsWith("plugin-route-")) {
        const candidate = {
          api: "openai-responses" as const,
          baseUrl: "https://selected.fixture.invalid/v1",
          authRequirement: "api-key" as const,
          requestTransportOverrides: "none" as const,
        };
        const original = modelRoutes.resolveProviderModelRoutes;
        const selected = {
          ...candidate,
          ...(authScope === "plugin-route-fresh"
            ? { inference: { chat: false, decision } }
            : authScope === "plugin-route-cleared"
              ? { inference: { chat: false } }
              : {}),
        };
        vi.spyOn(modelRoutes, "resolveProviderModelRoutes").mockImplementation((params) => {
          if (params.provider !== id || params.capability !== "decision") {
            return original(params);
          }
          return {
            kind: "routes",
            routes:
              authScope === "plugin-route-multiple"
                ? [candidate, { ...candidate, baseUrl: "https://other.fixture.invalid/v1" }]
                : [selected],
          };
        });
      }
      const http = vi.fn<typeof fetch>(async () => new Response("{}"));
      let admitted = true;
      if (authScope.startsWith("plugin-revoked")) {
        trace.fetch = http;
        trace.beforeRequest = (context) => {
          expect(context.auth.apiKey).toBe("synthetic-prepared-token");
          expect(getProviderAuthAuthority(context.model)).toBeTypeOf("function");
          // Revoke the captured prepared owner; a replaced root registry cannot revoke retained work.
          const prepared = getPluginRuntimeGenerationRegistry();
          expect(prepared).toBeDefined();
          const provider = prepared!.providers.find((entry) => entry.provider.id === id)!.provider;
          provider.resolveSyntheticAuth = undefined;
          if (authScope === "plugin-revoked-disabled") {
            admitted = false;
          }
          if (authScope !== "plugin-revoked-context") {
            assertProviderAuthAuthority(context.model);
          }
        };
      }
      const invoke: DecisionRuntimeV2["evaluateV2"] =
        authScope === "plugin-revoked-disabled"
          ? async (batch, options) => {
              const provider = registry.decisionProviders[0]!.host.provider;
              if (provider.contractVersion !== 2) {
                throw new Error("Fixture requires prepared Decision execution");
              }
              const outcome = await executePreparedDecision({
                provider,
                batch,
                modelId: "native",
                registration: registry.providers.find((entry) => entry.provider.id === id)!,
                config: cfg,
                options,
                signal: options.signal,
                deadlineMonotonicMs: performance.now() + options.timeoutMs,
                isAdmissible: () => admitted,
              });
              if (outcome.status === "ok") {
                throw new Error("Revoked prepared admission unexpectedly returned a result");
              }
              return outcome;
            }
          : evaluate;
      const evaluateFixture = () =>
        invoke(textBatch(), decisionOptions(authScope === "profile" ? { agentId: "main" } : {}));
      const outcome = await evaluateFixture();
      if (authScope.startsWith("plugin-route-") && authScope !== "plugin-route-fresh") {
        expect(outcome).toEqual(unavailable("unsupported-input"));
        expect(trace.calls).toBe(0);
        expect(
          credentialPreparation.mock.calls.filter(([params]) => params.capability === "decision"),
        ).toEqual([]);
        expect(usageEvents).toEqual([]);
        return;
      }
      if (authScope === "plugin-route-fresh") {
        expect(trace).toMatchObject({
          modelBaseUrl: "https://selected.fixture.invalid/v1",
          modelApi: "openai-responses",
          modelBilling: undefined,
        });
      }
      if (authScope.startsWith("plugin-revoked")) {
        expect(outcome).toEqual(
          unavailable(
            authScope === "plugin-revoked-disabled"
              ? "unsupported-input"
              : "credentials-unavailable",
          ),
        );
        expect(trace.calls).toBe(1);
        expect(http).not.toHaveBeenCalled();
        expect(usageEvents).toEqual([]);
        expect(registry.decisionProviders[0]!.host.inspect(cfg).callable).toBe(true);
        return;
      }
      if (authScope === "missing") {
        expect(outcome).toEqual(unavailable("credentials-unavailable"));
        expect(trace.calls).toBe(0);
        expect(usageEvents).toEqual([]);
        return;
      }
      expect(outcome).toMatchObject({
        status: "ok",
        result: { answers: { q: { answer: null } }, usage: { costUsd: 0 } },
      });
      expect(trace).toMatchObject({ calls: 1, resultReads: 1, authenticated: true });
      if (authScope === "profile") {
        expect(trace).toMatchObject({ profileId: id + ":agent", agentId: "main" });
      }
      expect(usageEvents).toMatchObject([
        {
          provider: id,
          model: "native",
          usage: { input: 100 },
          costUsd: 0,
        },
      ]);
      trace.usage = { inputTokens: 100 };
      const unpriced = await evaluateFixture();
      expect(unpriced).toMatchObject({ status: "ok" });
      expect(unpriced.status === "ok" && unpriced.result.usage).toEqual({ inputTokens: 100 });
      expect(usageEvents).toHaveLength(2);
      if (authScope === "plugin") {
        expect(usageEvents[1]?.costUsd).toBe(0.0002);
      } else {
        // API normalization and exchanged endpoints both invalidate catalog-route prices.
        expect(usageEvents[1]).not.toHaveProperty("costUsd");
      }
      if (authScope === "exchange") {
        expect(trace).toMatchObject({
          modelBaseUrl: "https://entitlement.fixture.invalid/v1",
          preparedApi: "openai-responses",
          modelBilling: undefined,
          modelApi: "openai-responses",
          modelRequest: {
            headers: { "x-fixture-entitlement": "synthetic-entitlement" },
            auth: {
              mode: "header",
              headerName: "x-fixture-auth",
              value: "synthetic-exchanged-header",
            },
          },
          modelHeaders: {
            "x-fixture-entitlement": "synthetic-entitlement",
            "x-fixture-auth": "synthetic-exchanged-header",
          },
        });
      } else {
        expect(trace.modelKeys).not.toContain("cost");
        expect(trace.modelKeys).not.toContain("maxTokens");
        expect(trace.modelContextWindow).toBeUndefined();
      }
      if (authScope === "agent" || authScope === "profile") {
        expect(trace.modelHeaders).toEqual({
          "x-provider": "provider",
          "x-model": "model",
          "x-precedence": "request",
          "x-request": "request",
        });
        expect(trace.modelRequest).toMatchObject({
          headers: { "x-precedence": "request", "x-request": "request" },
        });
        expect(trace.modelApi).toBe("openai-responses");
        setRuntimeConfigSnapshot({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              decisionModel: id + "/native@missing-fixture-profile",
            },
          },
        });
        await expect(
          evaluate(textBatch("explicit profile"), decisionOptions()),
        ).resolves.toMatchObject(unavailable("credentials-unavailable"));
        expect(trace.calls).toBe(2);
        setRuntimeConfigSnapshot(cfg);
      }

      if (authScope === "plugin") {
        for (const invalid of [
          { model: "native", answers: { q: { type: "boolean", probabilityTrue: 0.75 } } },
          { model: "native", answers: {} },
        ]) {
          trace.resultOverride = { value: invalid };
          expect(await evaluateFixture()).toEqual(unavailable("invalid-response"));
          expect(trace.resultReads).toBe(1);
          expect(usageEvents).toHaveLength(2);
        }
        delete trace.resultOverride;
      }

      const dispatched = createDeferredCore();
      const work = createDeferredCore();
      trace.work = work.promise;
      trace.onDispatch = () => dispatched.resolve();
      const controller = new AbortController();
      const pending = evaluate(
        textBatch("synthetic cancellation"),
        decisionOptions({ signal: controller.signal }),
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await dispatched.promise;
      controller.abort(new Error("fixture cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(1);
      work.resolve();
      await expect(pending).rejects.toThrow("fixture cancelled");
      expect(usageEvents).toHaveLength(2);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(0);
      await resetPreparedModelRuntimeSnapshotsForTest();
    });
  },
);

it("runs both SDK versions through the source TypeSafe plugin, prepared auth, and loopback transport", async () => {
  const root = roots.make("decision-typesafe-host-");
  const consumerRoot = path.join(root, "consumer");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(consumerRoot);
  fs.mkdirSync(emptyBundled);
  const consumerId = "decision-consumer-fixture";
  const consumer = createColdPluginFixture({ rootDir: consumerRoot, pluginId: consumerId });
  fs.writeFileSync(
    consumer.runtimeSource,
    'const trace=globalThis[Symbol.for("openclaw.test.decision-prepared-path")]; module.exports={id:"decision-consumer-fixture",register(api){trace.evaluate=api.runtime.decisions.evaluateV2;trace.evaluateV1=api.runtime.decisions.evaluate;}};',
  );
  const trace: Trace = { calls: 0, authenticated: false };
  Reflect.set(globalThis, traceKey, trace);
  let status = 200;
  const received: Array<{ url?: string; authorization?: string; body: unknown }> = [];
  await withServer(
    (request, response) => {
      readDecisionRequest(request, (body) => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          status === 200
            ? JSON.stringify({
                model: "kev-latest",
                answers: { q: { type: "noul", noul: 0.37 } },
                usage: { input_tokens: 3, output_tokens: 1 },
              })
            : "synthetic-private-provider-body",
        );
      });
    },
    async (baseUrl) => {
      const cfg = fixtureConfig(root, "typesafe/kev-latest", {
        load: {
          paths: [
            fileURLToPath(new URL("../../extensions/typesafe", import.meta.url)),
            consumerRoot,
          ],
        },
        entries: {
          typesafe: { enabled: true, config: { baseUrl } },
          [consumerId]: { enabled: true },
        },
      });
      await withEnvAsync(
        {
          ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
          OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        async () => {
          setRuntimeConfigSnapshot(cfg);
          const registry = await loadAndActivateRootPluginRegistry({
            config: cfg,
            workspaceDir: path.join(root, "workspace"),
          });
          expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
          const agentId = resolveDefaultAgentId(cfg);
          // Retain the prepared caller across SDK assertions: releasing a warm-up
          // lease retires the owner and charges each call for cold catalog setup.
          await using prepared = await acquireAgentRunPreparedModelRuntime(
            {
              config: cfg,
              agentId,
              agentDir: resolveAgentDir(cfg, agentId),
              workspaceDir: path.join(root, "workspace"),
              loadRuntimePlugins: true,
              runtimePluginSelections: [{ provider: "typesafe", modelId: "kev-latest", agentId }],
            },
            { catalogMode: "static" },
          );
          expect(prepared.snapshot.modelCatalog.entries).toContainEqual(
            expect.objectContaining({ provider: "typesafe", id: "kev-latest" }),
          );
          const evaluate = trace.evaluate,
            legacy = trace.evaluateV1;
          if (!evaluate || !legacy) {
            throw new Error("Missing registered decision SDK");
          }
          const typesafeOptions = () =>
            decisionOptions({ purpose: "actual-engine-fixture", rubricVersion: "1" });
          const batch = textBatch();
          const outcome = await evaluate(batch, { ...typesafeOptions(), reasoning: "auto" });
          expect(outcome).toMatchObject({
            status: "ok",
            result: {
              answers: { q: { type: "boolean", probabilityTrue: 0.37 } },
              usage: { inputTokens: 3, outputTokens: 1 },
            },
          });
          expect(
            await legacy(
              { state: "synthetic evidence", questions: batch.questions },
              typesafeOptions(),
            ),
          ).toMatchObject({ status: "ok", result: { answers: { q: { probabilityTrue: 0.37 } } } });
          for (const reasoning of ["off", "on"] as const) {
            await expect(
              evaluate(batch, { ...typesafeOptions(), reasoning }),
            ).resolves.toMatchObject(unavailable("unsupported-input"));
          }
          for (const rejection of [413, 422]) {
            status = rejection;
            expect(await evaluate(batch, typesafeOptions())).toMatchObject(
              unavailable("unsupported-input"),
            );
          }
          expect(received).toHaveLength(4);
          for (const request of received) {
            expect(request.authorization).toBeUndefined();
            expect(request.url).toBe("/v1/systemone");
            expect(request.body).toMatchObject({
              model: "kev-latest",
              questions: { q: { type: "noul" } },
            });
          }
        },
      );
    },
  );
});
