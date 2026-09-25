import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createModelProviderRouteOverrideResolver } from "../config/model-provider-config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  activateSecretsRuntimeSnapshotStateIfCurrent,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
} from "../secrets/runtime-state.js";
import {
  activateSecretsRuntimeSnapshot,
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshotRevision,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayConfigReloadTransactionOwnership } from "./config-reload.js";
import { GatewayHotReloadStaleSecretsError } from "./server-reload-contracts.js";
import { createManagedReloadSecretHandlers } from "./server-reload-managed-secrets.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";

vi.mock("../agents/context.js", () => ({ refreshContextWindowCache: vi.fn() }));

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  vi.restoreAllMocks();
});

function configPair(runtime: "openclaw" | "codex") {
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

function activatorOptions() {
  return {
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
    prepareRuntimeSecretsSnapshot: ({ config }: { config: OpenClawConfig }) => prepare(config),
    activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
  };
}

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
  plugin?: { afterCommit?: () => void; cleanupFailure?: Error },
) {
  const initial = configPair("openclaw");
  activateSecretsRuntimeSnapshotWithSource(await prepare(initial.config), initial.source);
  expectAuthoredSource(initial.source);
  const activateRuntimeSecrets = createRuntimeSecretsActivator(activatorOptions());
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
  const applyHotReload = vi.fn<
    Parameters<typeof createManagedReloadSecretHandlers>[0]["applyHotReload"]
  >(async (_plan, _config, publication) => {
    await beforePublication?.();
    let committed = false;
    try {
      await publication!.publish(
        async () => {
          await commit();
          committed = true;
          plugin?.afterCommit?.();
        },
        () => committed,
      );
    } catch (cause) {
      if (!plugin) {
        throw cause;
      }
      throw new PluginRuntimeApplicationError(
        "Plugin operation failed during activate",
        {
          operationId: "secrets-publication",
          generation: 1,
          pluginIds: ["fixture"],
          phase: "activate",
          committed,
        },
        {
          cause: plugin.cleanupFailure
            ? new AggregateError([cause, plugin.cleanupFailure], "Plugin rollback failed")
            : cause,
        },
      );
    }
    return "applied";
  });
  const { onHotReload } = createManagedReloadSecretHandlers({
    params,
    prepareRuntimeCandidate: (config) => config,
    tryPrepareRuntimeSecrets: async (config) => ({
      snapshot: await prepare(config),
      expectedRevision: getActiveSecretsRuntimeSnapshotRevision(),
    }),
    applyHotReload,
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
  const next = configPair("codex");
  const plan = buildGatewayReloadPlan(
    ["agents.defaults.models.openai/gpt-5.6-luna.agentRuntime.id"],
    { candidateConfig: next.config },
  );
  return {
    initial,
    next,
    ownership,
    applyHotReload,
    run: () => onHotReload(plan, next.config, ownership, next.source),
  };
}

describe("managed reload authored source", () => {
  it.each(["rollback", "cleanup failure", "committed"] as const)(
    "retries stale plugin secrets only after an uncommitted clean rollback (%s)",
    async (outcome) => {
      const commit = vi.fn(async () => {});
      const cleanupFailure = new Error("candidate cleanup failed");
      const beforePublication = vi.fn(async () => {
        if (outcome !== "committed" && beforePublication.mock.calls.length === 1) {
          const current = getActiveSecretsRuntimeSnapshotState();
          const source = getRuntimeConfigSourceSnapshot();
          assert(current && source);
          // A concurrent refresh advances ownership after this candidate was prepared.
          activateSecretsRuntimeSnapshotWithSource(current, source);
        }
      });
      const afterCommit = vi.fn(() => {
        if (outcome === "committed" && afterCommit.mock.calls.length === 1) {
          throw new GatewayHotReloadStaleSecretsError();
        }
      });
      const { initial, next, ownership, applyHotReload, run } = await createReload(
        commit,
        beforePublication,
        { afterCommit, ...(outcome === "cleanup failure" ? { cleanupFailure } : {}) },
      );
      const result = await run().catch((error: unknown) => error);
      if (outcome === "rollback") {
        expect(result).toBe("applied");
      } else {
        assert(result instanceof PluginRuntimeApplicationError);
        expect(result.details.committed).toBe(outcome === "committed");
        if (outcome === "cleanup failure") {
          assert(result.cause instanceof AggregateError);
          expect(result.cause.errors).toEqual([
            expect.any(GatewayHotReloadStaleSecretsError),
            cleanupFailure,
          ]);
        } else {
          expect(result.cause).toBeInstanceOf(GatewayHotReloadStaleSecretsError);
        }
      }
      expect(applyHotReload).toHaveBeenCalledTimes(outcome === "rollback" ? 2 : 1);
      expect(commit).toHaveBeenCalledTimes(outcome === "cleanup failure" ? 0 : 1);
      expect(ownership.markRuntimeCommitted).toHaveBeenCalledTimes(
        outcome === "cleanup failure" ? 0 : 1,
      );
      expectAuthoredSource(outcome === "cleanup failure" ? initial.source : next.source);
    },
  );

  it.each([false, true])(
    "commits the exact target before publication (hook fails: %s)",
    async (fails) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      activateSecretsRuntimeSnapshot(initial);
      const failure = new Error("durable publication failed");
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
        if (fails && config === candidate.config) {
          throw failure;
        }
      });
      const options = {
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      };
      const activate = createRuntimeSecretsActivator(options);
      const publication = activate.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
      );
      if (fails) {
        await expect(publication).rejects.toBe(failure);
        expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
          candidate.config,
          initial.config,
        ]);
      } else {
        await expect(publication).resolves.toBe(candidate);
        expect(beforeSnapshotPublication).toHaveBeenCalledExactlyOnceWith(candidate.config);
      }
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
        fails ? initial.config : candidate.config,
      );
    },
  );

  it.each(["snapshot", "admission"] as const)(
    "reconciles the survivor when %s ownership changes during the durable hook",
    async (supersession) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      const successor = await prepare({ gateway: { port: 18791 } });
      activateSecretsRuntimeSnapshot(initial);
      const entered = createDeferred();
      const release = createDeferred();
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        if (config === candidate.config) {
          entered.resolve();
          await release.promise;
        }
      });
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      });
      let current = true;
      const published = vi.fn();
      const pending = activator.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
        published,
        () => current,
      );
      await entered.promise;
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(initial.config);
      if (supersession === "snapshot") {
        activateSecretsRuntimeSnapshot(successor);
      } else {
        current = false;
      }
      release.resolve();
      await expect(pending).resolves.toBeNull();
      expect(published).not.toHaveBeenCalled();
      const survivor = supersession === "snapshot" ? successor : initial;
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        survivor.config,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(survivor.config);
    },
  );

  it.each([false, true])(
    "reconciles a throwing publisher (snapshot replaced: %s)",
    async (replaced) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      activateSecretsRuntimeSnapshot(initial);
      const beforeSnapshotPublication = vi.fn(async (_config: OpenClawConfig | null) => {});
      const failure = new Error("snapshot publication failed");
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        beforeSnapshotPublication,
        activateRuntimeSecretsSnapshot: (snapshot) => {
          if (replaced) {
            activateSecretsRuntimeSnapshot(snapshot);
          }
          throw failure;
        },
      });
      await expect(
        activator.activatePreparedSnapshot(candidate, {
          reason: "reload",
          activate: true,
        }),
      ).rejects.toBe(failure);
      const survivor = replaced ? candidate : initial;
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        survivor.config,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(survivor.config);
    },
  );

  it.each([false, true])(
    "durably publishes the exact three-way rollback (inside callback: %s)",
    async (insideCallback) => {
      const initial = await prepare({ gateway: { port: 18789 } });
      const candidate = await prepare({ gateway: { port: 18790 } });
      const descendant = await prepare({ gateway: { port: 18790, bind: "lan" } });
      const merged = { gateway: { port: 18789, bind: "lan" } };
      activateSecretsRuntimeSnapshot(initial);
      const beforeSnapshotPublication = vi.fn(async (config: OpenClawConfig | null) => {
        expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(
          config === candidate.config ? initial.config : descendant.config,
        );
      });
      const activator = createRuntimeSecretsActivator({
        ...activatorOptions(),
        activateRuntimeSecretsSnapshot: activateSecretsRuntimeSnapshot,
        beforeSnapshotPublication,
      });
      let publishedRevision = 0;
      const restoreMerged = async (restore: typeof activator.restoreSnapshotIfCurrent) => {
        expect(
          activateSecretsRuntimeSnapshotStateIfCurrent({
            snapshot: descendant,
            expectedRevision: publishedRevision,
            preserveActivationLineage: true,
            refreshContext: null,
            refreshHandler: null,
          }),
        ).toBe(true);
        await expect(restore(initial, publishedRevision, candidate)).resolves.toBe(true);
      };
      await activator.activatePreparedSnapshotIfCurrent(
        candidate,
        getActiveSecretsRuntimeSnapshotRevisionState(),
        { reason: "reload", activate: true },
        async (restore) => {
          publishedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
          if (insideCallback) {
            await restoreMerged(restore);
          }
        },
      );
      if (!insideCallback) {
        await restoreMerged(activator.restoreSnapshotIfCurrent);
      }
      expect(beforeSnapshotPublication.mock.calls.map(([config]) => config)).toEqual([
        candidate.config,
        merged,
      ]);
      expect(getActiveSecretsRuntimeSnapshotState()?.config).toEqual(merged);
    },
  );

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

  it("restores the predecessor's authored source when runtime commit fails", async () => {
    const { initial, ownership, run } = await createReload(async () => {
      throw new Error("commit failed");
    });
    await expect(run()).rejects.toThrow("commit failed");
    expect(ownership.markRuntimeCommitted).not.toHaveBeenCalled();
    expectAuthoredSource(initial.source);
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
