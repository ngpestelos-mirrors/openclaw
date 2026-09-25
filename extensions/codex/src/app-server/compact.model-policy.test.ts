import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureCodexAppServerClientRuntime,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { maybeCompactCodexAppServerSession } from "./compact.js";
import {
  CodexInferenceAuthorizationError,
  createCodexInferenceModelBinding,
  type CodexInferenceModelExecution,
} from "./inference-dispatch.js";
import {
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  ownCodexInferenceClient,
  prepareCodexInferenceThreadConfig,
} from "./inference-routing.js";
import { buildCodexRuntimeModelParams } from "./model-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { createClientHarness, createCodexTestModel } from "./test-support.js";

beforeEach(() => {
  for (const key of ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "REQUEST_METHOD"]) {
    vi.stubEnv(key, undefined);
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
});

afterEach(() => vi.unstubAllEnvs());

describe("native compaction model policy", () => {
  it.each([
    {
      name: "rejects a same-name model from another provider despite a prepared selected model",
      selectedModel: "shared-model",
      nativeProvider: "other-provider",
      nativeModel: "shared-model",
      prepared: true,
      allowed: false,
    },
    {
      name: "rejects a same-name model from another provider without prepared model evidence",
      selectedModel: "shared-model",
      nativeProvider: "other-provider",
      nativeModel: "shared-model",
      prepared: false,
      allowed: false,
    },
    {
      name: "allows a prepared same-provider catalog alias for the actual wire model",
      selectedModel: "catalog-model",
      nativeProvider: "allowed-provider",
      nativeModel: "wire-model",
      prepared: true,
      allowed: true,
    },
  ])("$name", async ({ selectedModel, nativeProvider, nativeModel, prepared, allowed }) => {
    await withStateDirEnv("openclaw-compact-model-policy-", async ({ tempRoot }) => {
      const provider = "allowed-provider";
      const threadId = "compaction-policy-thread";
      const turnId = "compaction-policy-turn";
      const runId = randomUUID();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "compaction-policy-session",
        sessionKey: "agent:main:compaction-policy",
      };
      const controller = new AbortController();
      const host = await createAgentHarnessHostCapabilitiesForTest({
        pluginId: "codex",
        nativeModelPolicySupport: "exact",
        attempt: {
          runId,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          workspaceDir: tempRoot,
          agentDir: path.join(tempRoot, "agent"),
          provider,
          modelId: selectedModel,
          abortSignal: controller.signal,
        },
        operatorSource: {
          profileId: "compaction-policy-operator",
          scopes: ["operator.write"],
          assertCurrent: () => {},
          modelPolicy: {
            models: [{ provider, model: selectedModel }],
            allows: (model) => model.provider === provider && model.model === selectedModel,
          },
        },
      });
      const started = createDeferred<void>();
      const harness = createClientHarness({
        onWrite(line, send) {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method === "thread/compact/start") {
            send({
              method: "turn/started",
              params: { threadId, turn: { id: turnId, status: "inProgress" } },
            });
            send({
              method: "item/started",
              params: {
                threadId,
                turnId,
                item: { id: "policy-compaction-item", type: "contextCompaction" },
              },
            });
            send({ id: request.id, result: {} });
            started.resolve();
          } else if (request.method === "account/read") {
            send({ id: request.id, result: { account: { type: "apiKey" } } });
          } else if (
            request.method === "turn/interrupt" ||
            request.method === "thread/unsubscribe"
          ) {
            send({ id: request.id, result: {} });
          } else {
            send({
              id: request.id,
              error: { code: -32_601, message: `Unexpected policy fixture RPC: ${request.method}` },
            });
          }
        },
      });
      let pending: ReturnType<typeof maybeCompactCodexAppServerSession> | undefined;
      let execution: CodexInferenceModelExecution | undefined;
      try {
        ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempRoot });
        ownCodexInferenceClient(harness.client);
        const inference = await prepareCodexInferenceThreadConfig({
          client: harness.client,
          clientId: harness.client.getInstanceId(),
          binding: undefined,
          cwd: tempRoot,
          modelProvider: nativeProvider,
          operatorBacked: true,
          assertCurrent: host.capabilities.assertActive,
          effectiveConfig: {
            config: {
              model_provider: nativeProvider,
              model_providers: {
                [nativeProvider]: {
                  name: "Compaction policy fixture",
                  base_url: "https://compaction-policy.example/v1",
                  wire_api: "responses",
                },
              },
            },
            origins: {},
          },
        });
        if (!inference) {
          throw new Error("Expected a real owned inference qualification");
        }
        assertCodexInferenceRouteConfig(
          harness.client,
          inference.route,
          inference.config,
          nativeProvider,
          inference.providers,
        );
        bindCodexInferenceThread(harness.client, threadId, inference.route, inference.providers);
        if (!(await retainCodexAppServerLiveThread(harness.client, threadId))) {
          throw new Error("Expected a retained compaction subscription");
        }
        const bindingStore = createCodexTestBindingStore();
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: { threadId, cwd: tempRoot, model: nativeModel, modelProvider: nativeProvider },
        });
        const runtimeModel = prepared
          ? {
              ...createCodexTestModel(provider),
              id: selectedModel,
              params: buildCodexRuntimeModelParams(selectedModel, nativeModel),
            }
          : undefined;
        const retainSourceAuthority = host.capabilities.retainSourceAuthority;
        if (!retainSourceAuthority) {
          throw new Error("Expected the production operator source capability");
        }
        pending = maybeCompactCodexAppServerSession(
          {
            ...identity,
            runId,
            sessionFile: path.join(tempRoot, "session.jsonl"),
            workspaceDir: tempRoot,
            provider,
            model: selectedModel,
            runtimeModel,
            trigger: "manual",
            abortSignal: controller.signal,
            hostCapabilities: {
              kind: host.capabilities.kind,
              version: host.capabilities.version,
              assertActive: host.capabilities.assertActive,
              retainSourceAuthority,
            },
          },
          { bindingStore, clientFactory: async () => harness.client },
        );
        await Promise.race([
          started.promise,
          pending.then((result) => {
            throw new Error(`Native compaction did not start: ${JSON.stringify(result)}`);
          }),
        ]);
        const bind = createCodexInferenceModelBinding({
          client: harness.client,
          provider: nativeProvider,
          assertCurrent: inference.route.assertCurrent,
          memoryConfigured: () => false,
          captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
          resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
        });
        let authorizationError: unknown;
        try {
          execution = await bind({
            path: "/responses",
            body: { model: nativeModel },
            headers: {},
            metadata: { threadId, turnId, requestKind: "compaction" },
            transport: "http",
            signal: controller.signal,
          });
        } catch (error) {
          authorizationError = error;
        }
        expect(execution !== undefined, "native compaction model admission").toBe(allowed);
        if (!allowed) {
          expect(authorizationError).toBeInstanceOf(CodexInferenceAuthorizationError);
          expect(authorizationError).toMatchObject({
            message: expect.stringContaining("operator role cannot use this model"),
          });
        }
        execution?.assertCurrent();
        execution?.release();
        execution = undefined;
        harness.send({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: { id: "policy-compaction-item", type: "contextCompaction" },
          },
        });
        harness.send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: allowed ? "completed" : "interrupted", items: [] },
          },
        });
        await expect(pending).resolves.toMatchObject({ ok: allowed, compacted: allowed });
      } finally {
        execution?.release();
        harness.send({
          method: "turn/started",
          params: { threadId, turn: { id: turnId, status: "inProgress" } },
        });
        harness.send({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } },
        });
        controller.abort();
        await pending?.catch(() => undefined);
        await harness.client.closeAndWait();
        host.close();
      }
    });
  });
});
