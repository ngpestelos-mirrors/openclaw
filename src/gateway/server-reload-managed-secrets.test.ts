import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupContextTokens, resetContextWindowCacheForTest } from "../agents/context.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { createModelProviderRouteOverrideResolver } from "../config/model-provider-config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { diffConfigPaths } from "./config-diff.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

let finishPendingModelReload: (() => Promise<void>) | undefined;

afterEach(async () => {
  await finishPendingModelReload?.();
  finishPendingModelReload = undefined;
  clearSecretsRuntimeSnapshot();
  resetContextWindowCacheForTest();
  vi.restoreAllMocks();
});

function configPair(runtime: "openclaw" | "codex", contextWindow?: number) {
  const source = {
    agents: { defaults: { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: runtime } } } } },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          models: [
            {
              id: "gpt-5.6-luna",
              name: "Luna",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
              ...(contextWindow === undefined ? {} : { contextWindow }),
            },
          ],
        },
      },
    },
  } satisfies OpenClawConfig;
  const config: OpenClawConfig = structuredClone(source);
  // The loader may seed catalog compatibility; this is not authored request policy.
  config.models!.providers!.openai!.models[0]!.compat = { supportsStore: false };
  return { source, config };
}

const prepare = (config: OpenClawConfig) =>
  prepareSecretsRuntimeSnapshot({
    config,
    includeAuthStoreRefs: false,
    env: {},
  });

function expectAuthoredSource(source: OpenClawConfig) {
  const config = getRuntimeConfigSnapshot();
  expect(config).not.toBeNull();
  expect(getRuntimeConfigSourceSnapshot()).toEqual(source);
  expect(
    createModelProviderRouteOverrideResolver({
      provider: "openai",
      authoredConfig: projectConfigOntoRuntimeSourceSnapshot(config!),
    })("gpt-5.6-luna"),
  ).toBe("none");
}

async function createReload(
  commit: () => Promise<void>,
  beforePublication?: () => Promise<void>,
  { initial = configPair("openclaw"), next = configPair("codex") } = {},
) {
  activateSecretsRuntimeSnapshotWithSource(await prepare(initial.config), initial.source);
  expectAuthoredSource(initial.source);
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: ({ config }) => prepare(config),
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
  });
  // Only secret publication is exercised here; the service tail is injected at its existing seam.
  const params = {
    activateRuntimeSecrets,
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    sharedGatewaySessionGenerationState: new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    }),
    clients: [],
    commitRuntimePolicy: vi.fn(),
    reconcileRuntimePolicy: vi.fn(),
  };
  const { onHotReload } = createManagedReloadSecretHandlers({
    params,
    prepareRuntimeCandidate: (config) => config,
    tryPrepareRuntimeSecrets: async (config) => ({
      snapshot: await prepare(config),
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
    }),
    applyHotReload: async (_plan, _config, publication) => {
      await beforePublication?.();
      let committed = false;
      await publication!.publish(
        async () => {
          await commit();
          committed = true;
        },
        () => committed,
      );
      return "applied";
    },
  });
  const ownership: GatewayConfigReloadTransactionOwnership = {
    isCurrent: () => true,
    checkpoint: async () => {},
    withRestartPreparation: async () => {
      throw new Error("Unexpected restart preparation in secret publication fixture");
    },
    markRuntimeCommitted: vi.fn(),
    commitRuntimeEnv: vi.fn(),
    publishRuntimeEnv: vi.fn(),
    rollbackRuntimeEnv: vi.fn(),
    reapplyRuntimeOverlays: (config) => config,
  };
  const plan = buildGatewayReloadPlan(diffConfigPaths(initial.source, next.source), {
    candidateConfig: next.config,
  });
  return {
    initial,
    next,
    ownership,
    run: () => onHotReload(plan, next.config, ownership, next.source),
  };
}

describe("managed reload authored source", () => {
  it("rejects a closed plugin invoker before activating its prepared secrets", async () => {
    const failure = new Error("plugin invoker closed");
    const commit = vi.fn(async () => {});
    let invokerOpen = true;
    const { initial, ownership, run } = await createReload(commit, async () => {
      invokerOpen = false;
    });
    const revision = getActiveSecretsRuntimeSnapshotRevision();
    ownership.assertInvokerOwned = () => {
      if (!invokerOpen) {
        throw failure;
      }
    };
    await expect(run()).rejects.toBe(failure);
    expect(commit).not.toHaveBeenCalled();
    expect(getActiveSecretsRuntimeSnapshotRevision()).toBe(revision);
    expectAuthoredSource(initial.source);
  });

  it("preserves generated model metadata across a successful hot reload", async () => {
    const { next, run } = await createReload(async () => {});
    await expect(run()).resolves.toBe("applied");
    expect(
      getRuntimeConfigSnapshot()?.agents?.defaults?.models?.["openai/gpt-5.6-luna"]?.agentRuntime
        ?.id,
    ).toBe("codex");
    expectAuthoredSource(next.source);
  });

  it("restores source and cold context limits before model replacement settles after commit failure", async () => {
    const initial = configPair("openclaw", 32_768);
    const next = configPair("codex", 65_536);
    const candidateOnlyModel = "rollback-candidate-only";
    for (const config of [next.source, next.config]) {
      const provider: ModelProviderConfig = config.models!.providers!.openai!;
      provider.models.push({
        ...provider.models[0]!,
        id: candidateOnlyModel,
        contextWindow: 16_384,
      });
    }
    resetContextWindowCacheForTest();
    const failure = new Error("commit failed");
    const { ownership, run } = await createReload(
      async () => {
        // The candidate is visible before commit; a cold synchronous reader can cache its limits.
        expect(lookupContextTokens("gpt-5.6-luna", { allowAsyncLoad: false })).toBe(65_536);
        expect(lookupContextTokens(candidateOnlyModel, { allowAsyncLoad: false })).toBe(16_384);
        throw failure;
      },
      undefined,
      { initial, next },
    );
    const { markPreparedModelRuntimeSnapshotsStale, rejectPendingPreparedModelRuntimeReplacement } =
      await import("../agents/prepared-model-runtime.js");
    const replacement = markPreparedModelRuntimeSnapshotsStale("plugin reload is preparing", {
      waitForReplacement: true,
    });
    // Independent teardown also releases the gate if the original self-wait times out the test.
    finishPendingModelReload = async () => {
      rejectPendingPreparedModelRuntimeReplacement(replacement, failure);
      await verification.catch(() => {});
      await closePreparedModelRuntimeSnapshots();
    };

    const verification = (async () => {
      await expect(run()).rejects.toBe(failure);
      expect(ownership.markRuntimeCommitted).not.toHaveBeenCalled();
      expectAuthoredSource(initial.source);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
      expect(lookupContextTokens("gpt-5.6-luna", { allowAsyncLoad: false })).toBe(32_768);
      expect(lookupContextTokens(candidateOnlyModel, { allowAsyncLoad: false })).toBeUndefined();
    })();
    await verification;
  });

  it("does not roll back a newer publication's authored source", async () => {
    const newer = configPair("codex");
    newer.source.models.providers.openai.models[0]!.name = "Newer model";
    newer.config.models!.providers!.openai!.models[0]!.name = "Newer model";
    const { run } = await createReload(async () => {
      activateSecretsRuntimeSnapshotWithSource(await prepare(newer.config), newer.source);
      throw new Error("superseded commit failed");
    });
    await expect(run()).rejects.toThrow("superseded commit failed");
    expectAuthoredSource(newer.source);
  });
});
