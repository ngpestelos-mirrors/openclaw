import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  createPluginBlobStore,
  type OpenBlobStoreOptions,
} from "../plugin-state/plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  type OpenAsyncKeyedStoreOptions,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { PluginTrustRefusalError } from "./plugin-trust.js";
import {
  capturePluginLifecycleAuthority,
  getPluginRecordRegistry,
  getPluginRegistryResourceOwner,
  isPluginRecordActive,
  isPluginRegistryPreparing,
} from "./registry-lifecycle.js";
import { createRegisteredChannelRuntimeResolver } from "./registry-runtime-channel.js";
import {
  createManagedPluginAgentRuntime,
  createManagedPluginGatewayRuntime,
  createManagedPluginSubagentRuntime,
} from "./registry-runtime-session.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  ExpiredPluginRegistryScopeError,
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

// A completed reaction must retain only the emptied holder, not the caller's registry closure.
function createRuntimeRegistryRelease(held: PluginRegistry[]) {
  return () => {
    held.length = 0;
  };
}

/** One namespace projection belongs to its runtime source, not the invocation reading it. */
function createRuntimeFacade<T extends { [K in keyof T]: (...args: never[]) => unknown }>(
  invoke: <TResult>(run: () => TResult) => TResult,
  methods: readonly (keyof T)[],
) {
  let cached: { source: T; value: T } | undefined;
  return (source: T): T => {
    if (cached && cached.source === source) {
      return cached.value;
    }
    const value = { ...source };
    for (const method of methods) {
      Object.defineProperty(value, method, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (...args: unknown[]) => invoke(() => Reflect.apply(source[method], source, args)),
      });
    }
    cached = { source, value };
    return value;
  };
}

export function createPluginRuntimeResolver(state: PluginRegistryState) {
  const { registry, registryParams } = state;
  const pluginRuntimes = new WeakMap<PluginRecord, PluginRuntime>();

  const readRuntimeProperty = (record: PluginRecord, prop: PropertyKey, receiver: unknown) => {
    try {
      return Reflect.get(registryParams.runtime, prop, receiver);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve plugin runtime module") &&
        !error.message.includes("pluginRuntimeContext=")
      ) {
        const propName =
          typeof prop === "symbol" ? (prop.description ?? prop.toString()) : String(prop);
        error.message = [
          error.message,
          `pluginRuntimeContext=pluginId:${record.id}`,
          `property:${propName}`,
          ...(record.source ? [`source:${record.source}`] : []),
        ].join("; ");
      }
      throw error;
    }
  };
  const channelRuntime = createRegisteredChannelRuntimeResolver(state, (record) =>
    readRuntimeProperty(record, "channel", registryParams.runtime),
  );

  const resolvePluginRuntime = (record: PluginRecord): PluginRuntime => {
    const pluginId = record.id;
    const cached = pluginRuntimes.get(record);
    if (cached) {
      return cached;
    }
    const currentRegistry = () => getPluginRecordRegistry(registry, record);
    const currentInvocationRegistry = (selectedRegistry?: PluginRegistry) => {
      let invocationView = selectedRegistry;
      if (invocationView === undefined) {
        try {
          invocationView = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
        } catch (error) {
          if (!(error instanceof ExpiredPluginRegistryScopeError)) {
            throw error;
          }
        }
      }
      return invocationView ?? currentRegistry();
    };
    const currentDecisionRegistry = (candidate?: PluginRegistry) => {
      const owner = currentRegistry();
      const invocationView = currentInvocationRegistry(candidate);
      // An admitted prepared view may borrow a Gateway provider. Keep that exact
      // composition without accepting an unrelated ambient registry or global owner.
      return invocationView.plugins.includes(record) &&
        getPluginRegistryResourceOwner(invocationView) === owner
        ? invocationView
        : owner;
    };
    const resolveDelegatedRuntime = (ownerPluginId: string) => {
      const owner = currentRegistry().plugins.find((entry) => entry.id === ownerPluginId);
      if (!owner) {
        throw new Error(`Plugin "${ownerPluginId}" runtime is no longer active.`);
      }
      return resolvePluginRuntime(owner);
    };
    const assertRuntimeCurrent = () => {
      if (
        !capturePluginLifecycleAuthority(currentRegistry(), record, {
          scopedRuntime: registryParams.activateGlobalSideEffects === false,
          registration: true,
          admittedRuntime: true,
        })?.()
      ) {
        throw new Error(`Plugin "${pluginId}" runtime is no longer active.`);
      }
    };
    // Cache checks, not config or row facts; actions resolve ownership after the import settles.
    const loadSessionOwnership = createLazyRuntimeSurface(
      () => import("./registry-runtime-session-ownership.js"),
      (module) =>
        module.createPluginSessionOwnership(state, pluginId, currentRegistry, assertRuntimeCurrent),
    );
    const runWithPluginScope = <T>(
      run: () => T,
      requireActive = true,
      selectedRegistry?: PluginRegistry,
    ): T => {
      if (requireActive) {
        assertRuntimeCurrent();
      }
      const scopedRegistry = selectedRegistry ?? currentRegistry();
      return withPluginRuntimePluginScope(
        {
          pluginId,
          pluginSource: record.source,
          pluginOrigin: record.origin,
          pluginTrustedOfficialInstall: record.trustedOfficialInstall,
        },
        () => {
          const result = run();
          if (!isPromiseLike(result)) {
            return result;
          }
          // Lazy runtime imports can suspend before the operation acquires its own custody.
          return Promise.resolve(result).finally(
            createRuntimeRegistryRelease([scopedRegistry]),
          ) as T; // SAFETY: Preserve the host operation's resolved value and rejection reason.
        },
        scopedRegistry,
      );
    };
    const invokeSelectedRuntime = <T>(run: () => T): T => {
      assertRuntimeCurrent();
      return runWithPluginScope(run, false, currentInvocationRegistry());
    };
    const runWithCurrentPluginScope = <T>(run: () => Promise<T>): Promise<T> =>
      runWithPluginScope(async () => {
        const result = await run();
        assertRuntimeCurrent();
        return result;
      });
    const facades = {
      media: createRuntimeFacade<PluginRuntime["media"]>(invokeSelectedRuntime, ["loadWebMedia"]),
      imageGeneration: createRuntimeFacade<PluginRuntime["imageGeneration"]>(
        invokeSelectedRuntime,
        ["generate", "listProviders"],
      ),
      videoGeneration: createRuntimeFacade<PluginRuntime["videoGeneration"]>(
        invokeSelectedRuntime,
        ["generate", "listProviders"],
      ),
      musicGeneration: createRuntimeFacade<PluginRuntime["musicGeneration"]>(
        invokeSelectedRuntime,
        ["generate", "listProviders"],
      ),
      webSearch: createRuntimeFacade<PluginRuntime["webSearch"]>(invokeSelectedRuntime, [
        "listProviders",
        "search",
      ]),
      tts: createRuntimeFacade<PluginRuntime["tts"]>(invokeSelectedRuntime, [
        "prepareTtsRequest",
        "textToSpeech",
        "textToSpeechStream",
        "textToSpeechTelephony",
        "listVoices",
      ]),
      mediaUnderstanding: createRuntimeFacade<PluginRuntime["mediaUnderstanding"]>(
        invokeSelectedRuntime,
        [
          "resolveAudioInputBudget",
          "runFile",
          "describeImageFile",
          "describeImageFileWithModel",
          "extractStructuredWithModel",
          "describeVideoFile",
          "transcribeAudioFile",
        ],
      ),
      modelAuth: createRuntimeFacade<PluginRuntime["modelAuth"]>(invokeSelectedRuntime, [
        "ensureAuthProfileStore",
        "isProviderApiKeyConfigured",
        "getApiKeyForModel",
        "getRuntimeAuthForModel",
        "resolveApiKeyForProvider",
      ]),
      modelConfig: createRuntimeFacade<PluginRuntime["modelConfig"]>(invokeSelectedRuntime, [
        "resolveDefaultModelForAgent",
        "resolveAllowedModelRef",
      ]),
      sandbox: createRuntimeFacade<PluginRuntime["sandbox"]>(invokeSelectedRuntime, [
        "resolveWorkspaceAuthority",
        "prepareWorkspaceAuthority",
      ]),
    };
    let scopedAgentRuntime:
      | { source: PluginRuntime["agent"]; value: PluginRuntime["agent"] }
      | undefined;
    let scopedChannelRuntime:
      | { source: PluginRuntime["channel"]; value: PluginRuntime["channel"] }
      | undefined;
    const runtime = new Proxy(registryParams.runtime, {
      get(_target, prop, receiver) {
        const getRuntimeProperty = () => readRuntimeProperty(record, prop, receiver);
        if (prop === "state") {
          const baseState = getRuntimeProperty();
          return {
            ...baseState,
            openBlobStore: <TMetadata>(options: OpenBlobStoreOptions) => {
              return createPluginBlobStore<TMetadata>(pluginId, options);
            },
            openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
              if (options.retention === "retained") {
                assertRuntimeCurrent();
              }
              return createPluginStateKeyedStore<T>(pluginId, options, assertRuntimeCurrent);
            },
            openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
              return createPluginStateSyncKeyedStore<T>(pluginId, options);
            },
            openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
            ) => {
              const stateDir = options?.stateDir ?? baseState.resolveStateDir();
              return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>(
                { ...options, channelId: pluginId, stateDir },
                assertRuntimeCurrent,
              );
            },
            openChannelIngressDrain: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
              options: Omit<
                Parameters<
                  typeof createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>
                >[0],
                "queue"
              > & {
                queue?: ReturnType<
                  typeof createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>
                >;
                accountId?: string;
                stateDir?: string;
              },
            ) => {
              const stateDir = options.stateDir ?? baseState.resolveStateDir();
              const queue =
                options.queue ??
                createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>(
                  { channelId: pluginId, accountId: options.accountId, stateDir },
                  assertRuntimeCurrent,
                );
              const {
                queue: _queue,
                accountId: _accountId,
                stateDir: _stateDir,
                ...drainOptions
              } = options;
              return createChannelIngressDrain<TPayload, TMetadata, TCompletedMetadata>({
                ...drainOptions,
                queue,
              });
            },
          } satisfies PluginRuntime["state"];
        }
        if (prop === "config") {
          const config: PluginRuntime["config"] = getRuntimeProperty();
          return {
            ...config,
            current: () => runWithPluginScope(() => config.current(), false),
            mutateConfigFile: (params) => runWithPluginScope(() => config.mutateConfigFile(params)),
            replaceConfigFile: (params) =>
              runWithPluginScope(() => config.replaceConfigFile(params)),
          } satisfies PluginRuntime["config"];
        }
        if (prop === "system") {
          const system: PluginRuntime["system"] = getRuntimeProperty();
          const route = <T>(run: () => T): T => {
            assertRuntimeCurrent();
            if (isPluginRegistryPreparing(registry) && !isPluginRecordActive(registry, record)) {
              throw new Error(
                `Plugin "${pluginId}" cannot route system events during replacement preparation.`,
              );
            }
            return runWithPluginScope(run);
          };
          return {
            ...system,
            enqueueSystemEvent: (...args) => route(() => system.enqueueSystemEvent(...args)),
            requestHeartbeat: (...args) => route(() => system.requestHeartbeat(...args)),
            requestHeartbeatNow: (...args) => route(() => system.requestHeartbeatNow(...args)),
            runHeartbeatOnce: (...args) => route(() => system.runHeartbeatOnce(...args)),
            runCommandWithTimeout: (...args) =>
              runWithPluginScope(() => system.runCommandWithTimeout(...args)),
          } satisfies PluginRuntime["system"];
        }
        if (prop === "channel") {
          const channel = channelRuntime.resolve(record);
          if (scopedChannelRuntime?.source === channel) {
            return scopedChannelRuntime.value;
          }
          const inbound = {
            ...channel.inbound,
            run: ((...args: Parameters<typeof channel.inbound.run>) =>
              invokeSelectedRuntime(() =>
                channel.inbound.run(...args),
              )) as typeof channel.inbound.run, // SAFETY: Forward unchanged arguments/results for both generic run overloads.
            runPreparedReply: (...args) =>
              invokeSelectedRuntime(() => channel.inbound.runPreparedReply(...args)),
            dispatch: ((...args: Parameters<typeof channel.inbound.dispatch>) =>
              invokeSelectedRuntime(() =>
                channel.inbound.dispatch(...args),
              )) as typeof channel.inbound.dispatch, // SAFETY: Preserve each routed-turn overload and its result.
            dispatchReply: (...args) =>
              invokeSelectedRuntime(() => channel.inbound.dispatchReply(...args)),
          } satisfies PluginRuntime["channel"]["inbound"];
          const value = {
            ...channel,
            inbound,
            turn: inbound,
            outbound: {
              ...channel.outbound,
              loadAdapter: (...args) =>
                invokeSelectedRuntime(() => channel.outbound.loadAdapter(...args)),
            },
            threadBindings: {
              setIdleTimeoutBySessionKey: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setIdleTimeoutBySessionKey(...args),
                ),
              setMaxAgeBySessionKey: (...args) =>
                invokeSelectedRuntime(() => channel.threadBindings.setMaxAgeBySessionKey(...args)),
              setIdleTimeoutBySessionKeyAsync: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setIdleTimeoutBySessionKeyAsync(...args),
                ),
              setMaxAgeBySessionKeyAsync: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.threadBindings.setMaxAgeBySessionKeyAsync(...args),
                ),
            },
            reply: {
              ...channel.reply,
              dispatchReplyFromConfig: (...args) =>
                invokeSelectedRuntime(() => channel.reply.dispatchReplyFromConfig(...args)),
              dispatchReplyWithBufferedBlockDispatcher: (...args) =>
                invokeSelectedRuntime(() =>
                  channel.reply.dispatchReplyWithBufferedBlockDispatcher(...args),
                ),
            },
          } satisfies PluginRuntime["channel"];
          scopedChannelRuntime = { source: channel, value };
          return value;
        }
        if (prop === "decisions") {
          return {
            evaluate: async (batch, options) => {
              assertRuntimeCurrent();
              const capturedRegistry = currentDecisionRegistry();
              const { evaluateDecisionInRegistry } = await import("../decisions/runtime.js");
              assertRuntimeCurrent();
              const selectedRegistry = currentDecisionRegistry(capturedRegistry);
              const result = await withPluginRuntimeRegistryScope(selectedRegistry, () =>
                evaluateDecisionInRegistry(
                  batch,
                  options,
                  selectedRegistry,
                  getRuntimeConfig(),
                  record.id,
                ),
              );
              assertRuntimeCurrent();
              options.signal.throwIfAborted();
              return result;
            },
          } satisfies PluginRuntime["decisions"];
        }
        if (prop === "llm") {
          const llm = getRuntimeProperty();
          return {
            acquireLocalService: (...args) =>
              runWithPluginScope(() => llm.acquireLocalService(...args)),
            complete: (params) => runWithPluginScope(() => llm.complete(params)),
          } satisfies PluginRuntime["llm"];
        }
        if (
          prop === "media" ||
          prop === "imageGeneration" ||
          prop === "videoGeneration" ||
          prop === "musicGeneration" ||
          prop === "webSearch" ||
          prop === "tts" ||
          prop === "mediaUnderstanding" ||
          prop === "modelAuth" ||
          prop === "modelConfig" ||
          prop === "sandbox"
        ) {
          return facades[prop](getRuntimeProperty());
        }
        if (prop === "gateway") {
          const gateway: PluginRuntime["gateway"] = getRuntimeProperty();
          return createManagedPluginGatewayRuntime(gateway, {
            runWithPluginScope,
            runWithCurrentPluginScope,
            loadSessionOwnership,
            assertRuntimeCurrent,
          });
        }
        if (prop === "hooks") {
          const hooks: PluginRuntime["hooks"] = getRuntimeProperty();
          return {
            dispatchHookAgentTurn: async (params) => {
              if (record.origin !== "bundled" && record.trustedOfficialInstall !== true) {
                throw new PluginTrustRefusalError({
                  pluginId,
                  source: record.source,
                  origin: record.origin,
                  trust: record.trust,
                });
              }
              return await runWithPluginScope(() => hooks.dispatchHookAgentTurn(params));
            },
          } satisfies PluginRuntime["hooks"];
        }
        if (prop === "nodes") {
          const nodes = getRuntimeProperty();
          return {
            list: (params) => runWithPluginScope(() => nodes.list(params)),
            invoke: (params) => runWithPluginScope(() => nodes.invoke(params)),
            openDuplex: (params) => runWithPluginScope(() => nodes.openDuplex(params)),
          } satisfies PluginRuntime["nodes"];
        }
        if (prop === "agent") {
          const agent: PluginRuntime["agent"] = getRuntimeProperty();
          if (scopedAgentRuntime?.source === agent) {
            return scopedAgentRuntime.value;
          }
          const scopedAgent = createManagedPluginAgentRuntime(agent, {
            record,
            registry,
            currentRegistry,
            assertRuntimeCurrent,
            runWithPluginScope,
            runWithCurrentPluginScope,
            invokeSelectedRuntime,
            loadSessionOwnership,
            resolveDelegatedRuntime,
          });
          scopedAgentRuntime = { source: agent, value: scopedAgent };
          return scopedAgent;
        }
        if (prop !== "subagent") {
          return getRuntimeProperty();
        }
        return createManagedPluginSubagentRuntime(getRuntimeProperty(), {
          runWithPluginScope,
          loadSessionOwnership,
        });
      },
    });
    pluginRuntimes.set(record, runtime);
    return runtime;
  };

  return {
    resolvePluginRuntime,
    resolveRegisteredChannelRuntime: channelRuntime.resolve,
    revokePluginRuntimeRecord: channelRuntime.revoke,
  };
}

export type PluginRuntimeResolver = ReturnType<typeof createPluginRuntimeResolver>;
