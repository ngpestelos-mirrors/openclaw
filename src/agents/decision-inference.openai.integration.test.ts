import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateDecisionInRegistry, evaluateDecisionV2InRegistry } from "../decisions/runtime.js";
import { DecisionContractError } from "../decisions/validation.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginHermeticEnv } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
} from "../secrets/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveAgentDir, resolveDefaultAgentId } from "./agent-scope.js";
import * as authProfiles from "./auth-profiles.js";
import {
  decisionOptions,
  readDecisionRequest,
  trackDecisionUsage,
  unavailable,
} from "./decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await closeProviderTransportDispatcherPool();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  resetDiagnosticEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each([
  "platform",
  "configured model",
  "mixed profiles",
  "locked subscription",
  "unresolved header",
  "private allowed",
  "private denied",
  "private retired",
])(
  "prepares the registered OpenAI image Decision route before auth and enforces request authority (%s)",
  async (route) => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const response = {
      model: "gpt-6-luna",
      answers: [{ name: "visible", type: "predicate", probability: 0.9 }],
      usage: { input_tokens: 12, output_tokens: 0 },
    };
    await withServer(
      (request, reply) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") {
            headers.set(name, value);
          }
        }
        const received: (typeof requests)[number] = {
          url: `http://${request.headers.host}${request.url}`,
          headers,
          body: undefined,
        };
        // Count dispatch at headers, including a request aborted before its body ends.
        requests.push(received);
        readDecisionRequest(request, (body) => {
          received.body = body;
          reply.writeHead(200, { "content-type": "application/json" });
          reply.end(JSON.stringify(response));
        });
      },
      async (origin) => {
        const privateRoute = route.startsWith("private ");
        const configured = route === "configured model";
        const profiles = route === "mixed profiles" || route === "locked subscription";
        const baseUrl = privateRoute
          ? `${origin}/v1`
          : configured
            ? "https://decision.fixture.invalid/v1"
            : "https://api.openai.com/v1";
        const state = await createOpenClawTestState({ applyEnv: false });
        const pluginRoot = fileURLToPath(new URL("../../extensions/openai", import.meta.url));
        const workspaceDir = path.join(state.root, "workspace");
        const provider: ModelProviderConfig = {
          baseUrl,
          apiKey: "synthetic-openai-key",
          models: [],
          headers: { "X-Provider": "provider", "X-Precedence": "provider" },
          request: { headers: { "X-Precedence": "request" } },
        };
        const request = provider.request!;
        if (profiles) {
          delete provider.apiKey;
        }
        if (privateRoute && route !== "private denied") {
          request.allowPrivateNetwork = true;
        }
        if (route === "unresolved header") {
          request.headers!["X-Unresolved"] = {
            source: "env",
            provider: "default",
            id: "OPENAI_FIXTURE_ABSENT",
          };
        }
        if (configured) {
          provider.baseUrl = "https://provider.fixture.invalid/v1";
          request.auth = {
            mode: "header",
            headerName: "X-Credential",
            value: "synthetic-custom-auth",
          };
        }
        if (configured || privateRoute) {
          provider.models = [
            {
              id: "gpt-6-luna",
              name: "GPT-6 Luna",
              baseUrl,
              reasoning: false,
              input: ["text", "image"],
              maxTokens: 128000,
              headers: { "X-Model": "model", "X-Precedence": "model" },
              cost: { input: 42, output: 42, cacheRead: 0, cacheWrite: 0 },
            },
          ];
        }
        const config: OpenClawConfig = {
          diagnostics: { enabled: true },
          agents: {
            defaults: {
              workspace: workspaceDir,
              decisionModel:
                "openai/gpt-6-luna" +
                (route === "locked subscription" ? "@openai:subscription-fixture" : ""),
            },
          },
          models: { providers: { openai: provider } },
          plugins: {
            allow: ["openai"],
            slots: { memory: "none" },
            entries: { openai: { enabled: true } },
          },
        };
        const env = {
          ...createColdPluginHermeticEnv(state.root, {
            bundledPluginsDir: path.dirname(pluginRoot),
          }),
          ...state.envVars,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
          OPENAI_FIXTURE_ABSENT: undefined,
          CODEX_HOME: path.join(state.root, "empty-codex"),
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
        };
        // Private routes retain real sockets and guarded fetch; only public HTTP is synthetic.
        if (!privateRoute) {
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
              if (!url.endsWith("/decisions")) {
                throw new Error("Unexpected OpenAI fixture request");
              }
              if (typeof init?.body !== "string") {
                throw new Error("Expected a serialized Decision request");
              }
              requests.push({
                url,
                headers: new Headers(init?.headers),
                body: JSON.parse(init.body),
              });
              return Response.json(response);
            }),
          );
        }
        try {
          await withEnvAsync(env, async () => {
            if (profiles) {
              await state.writeAuthProfiles({
                version: 1,
                profiles: {
                  "openai:subscription-fixture": {
                    type: "oauth",
                    provider: "openai",
                    access: "synthetic-subscription",
                    refresh: "synthetic-refresh",
                    expires: 1,
                  },
                  "openai:key-fixture": {
                    type: "api_key",
                    provider: "openai",
                    key: "synthetic-openai-key",
                  },
                },
                order: { openai: ["openai:subscription-fixture", "openai:key-fixture"] },
              });
            }
            setRuntimeConfigSnapshot(config);
            const registry = await loadAndActivateRootPluginRegistry({
              config,
              env,
              workspaceDir,
              onlyPluginIds: ["openai"],
              preferBuiltPluginArtifacts: false,
              pluginSdkResolution: "src",
            });
            expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
            const agentId = resolveDefaultAgentId(config);
            // Unresolved config must fail through the public host, including preparation.
            await using prepared =
              route === "unresolved header"
                ? undefined
                : await acquireAgentRunPreparedModelRuntime(
                    {
                      config,
                      agentId,
                      agentDir: resolveAgentDir(config, agentId),
                      workspaceDir,
                      loadRuntimePlugins: true,
                      runtimePluginSelections: [
                        { provider: "openai", modelId: "gpt-6-luna", agentId },
                      ],
                    },
                    { catalogMode: "static" },
                  );
            expect(registry.providers.find((entry) => entry.provider.id === "openai")?.source).toBe(
              path.join(pluginRoot, "index.ts"),
            );
            if (prepared) {
              expect(
                prepared.snapshot.pluginRegistry?.providers.find(
                  (entry) => entry.provider.id === "openai",
                )?.pluginId,
              ).toBe("openai");
              expect(
                prepared.snapshot.modelCatalog.entries.some(
                  (entry) => entry.provider === "openai" && entry.id === "gpt-6-luna",
                ),
              ).toBe(true);
            }
            const events = trackDecisionUsage();
            const expectNoEffects = () => {
              expect({
                requests,
                events,
                active: registry.decisionProviders[0]?.host.inspect(config).activeRequests,
              }).toEqual({ requests: [], events: [], active: 0 });
            };
            const credentialRead = vi.spyOn(authProfiles, "resolveApiKeyForProfile");
            const dataUri = "data:image/png;base64,AA==";
            const entered = createDeferredCore();
            const release = createDeferredCore();
            let finalAdmission = false;
            let dnsLookups = 0;
            let restoreDns: (() => void) | undefined;
            if (route === "private retired") {
              const lookup = dns.lookup;
              const hostname = new URL(baseUrl).hostname;
              const spy = vi.spyOn(dns, "lookup").mockImplementation(async (...args) => {
                if (args[0] === hostname) {
                  dnsLookups++;
                  entered.resolve();
                  await release.promise;
                }
                return lookup(...args);
              });
              // The loaded SDK uses native modules, outside Vitest's facade.
              syncBuiltinESMExports();
              restoreDns = () => {
                spy.mockRestore();
                syncBuiltinESMExports();
              };
            }
            const signal = new AbortController().signal;
            const options = decisionOptions({
              agentId,
              signal,
              purpose: "openai-route-fixture",
              rubricVersion: "1",
            });
            const pending = withGuardedFetchRequestAuthority(
              undefined,
              () =>
                evaluateDecisionV2InRegistry(
                  {
                    state: { type: "image", dataUri, text: "Synthetic image evidence" },
                    questions: {
                      visible: { type: "boolean", instructions: "Is the object visible?" },
                    },
                  },
                  { ...options, reasoning: "auto" },
                  registry,
                  config,
                ),
              () => {
                finalAdmission = true;
              },
            );
            if (route === "private retired") {
              const settled = pending.then(
                (outcome) => ({ outcome }),
                (error: unknown) => ({ error }),
              );
              try {
                const first = await Promise.race([
                  entered.promise.then(() => ({ phase: "dns" })),
                  settled.then(() => ({ phase: "settled" })),
                ]);
                expect(first).toEqual({ phase: "dns" });
                expect(dnsLookups).toBe(1);
                expect(requests).toEqual([]);
                const revision = getActiveSecretsRuntimeSnapshotRevision();
                clearSecretsRuntimeSnapshot();
                setRuntimeConfigSnapshot(config);
                expect(getActiveSecretsRuntimeSnapshotRevision()).toBeGreaterThan(revision);
                release.resolve();
                expect({ settled: await settled, aborted: signal.aborted, finalAdmission }).toEqual(
                  {
                    settled: { outcome: unavailable("retiring") },
                    aborted: false,
                    finalAdmission: false,
                  },
                );
                expectNoEffects();
              } finally {
                release.resolve();
                await settled;
                restoreDns?.();
              }
              return;
            }
            if (route === "unresolved header") {
              await expect(pending).rejects.toBeInstanceOf(DecisionContractError);
              expect(credentialRead).not.toHaveBeenCalled();
              expectNoEffects();
              return;
            }
            const outcome = await pending;
            if (route === "private denied" || route === "locked subscription") {
              expect(outcome).toEqual(
                unavailable(route === "private denied" ? "transport" : "credentials-unavailable"),
              );
              if (route === "locked subscription") {
                expect(credentialRead).not.toHaveBeenCalled();
              }
              expectNoEffects();
              return;
            }
            if (route === "mixed profiles") {
              expect(credentialRead).toHaveBeenCalledTimes(1);
              expect(credentialRead).toHaveBeenCalledWith(
                expect.objectContaining({ profileId: "openai:key-fixture" }),
              );
            }
            expect(outcome).toMatchObject({
              status: "ok",
              result: {
                answers: { visible: { type: "boolean", probabilityTrue: 0.9 } },
                usage: { inputTokens: 12, outputTokens: 0 },
              },
            });
            expect(requests).toHaveLength(1);
            expect(finalAdmission).toBe(true);
            const sent = requests[0]!;
            expect(sent.url).toBe(baseUrl + "/decisions");
            expect(
              ["authorization", "x-provider", "x-precedence"].map((key) => sent.headers.get(key)),
            ).toEqual([configured ? null : "Bearer synthetic-openai-key", "provider", "request"]);
            if (configured) {
              expect(["x-model", "x-credential"].map((key) => sent.headers.get(key))).toEqual([
                "model",
                "synthetic-custom-auth",
              ]);
            }
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
              provider: "openai",
              model: "gpt-6-luna",
              usage: { input: 12, output: 0 },
            });
            expect(events[0]).not.toHaveProperty("costUsd");
            expect(requests[0]?.body).toMatchObject({
              model: "gpt-6-luna",
              input: [
                {
                  role: "user",
                  content: [
                    { type: "input_text", text: "Synthetic image evidence" },
                    { type: "input_image", image_url: dataUri },
                  ],
                },
              ],
            });
            const legacy = await evaluateDecisionInRegistry(
              { state: "legacy text", questions: { visible: { type: "boolean" } } },
              options,
              registry,
              config,
            );
            expect(legacy.status).toBe("ok");
            expect(requests).toHaveLength(2);
            expect(requests[1]?.body).toMatchObject({ input: "legacy text" });
            expect(registry.decisionProviders[0]?.host.inspect(config).activeRequests).toBe(0);
          });
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          await state.cleanup();
        }
      },
    );
  },
);
