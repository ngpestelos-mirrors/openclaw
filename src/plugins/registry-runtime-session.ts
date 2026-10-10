import { isPluginRecordActive } from "./registry-lifecycle.js";
import type { createPluginSessionOwnership } from "./registry-runtime-session-ownership.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import type { PluginRuntime } from "./runtime/types.js";

type RuntimeScope = {
  record: PluginRecord;
  registry: PluginRegistry;
  currentRegistry: () => PluginRegistry;
  assertRuntimeCurrent: () => void;
  runWithPluginScope: <T>(run: () => T, requireActive?: boolean) => T;
  runWithCurrentPluginScope: <T>(run: () => Promise<T>) => Promise<T>;
  invokeSelectedRuntime: <T>(run: () => T) => T;
  loadSessionOwnership: () => Promise<ReturnType<typeof createPluginSessionOwnership>>;
  resolveDelegatedRuntime: (ownerPluginId: string) => PluginRuntime;
};

export function createManagedPluginAgentRuntime(
  agent: PluginRuntime["agent"],
  scope: RuntimeScope,
): PluginRuntime["agent"] {
  const {
    record,
    registry,
    currentRegistry,
    assertRuntimeCurrent,
    runWithPluginScope,
    runWithCurrentPluginScope,
    invokeSelectedRuntime,
    loadSessionOwnership,
    resolveDelegatedRuntime,
  } = scope;
  const pluginId = record.id;
  const session = agent.session;
  const scopedSession = {
    resolveStorePath: session.resolveStorePath,
    getSessionEntry: session.getSessionEntry,
    getSessionEntryAsync: (params) =>
      runWithCurrentPluginScope(() => session.getSessionEntryAsync(params)),
    getSessionEntryByIdAsync: (params) =>
      runWithCurrentPluginScope(() => session.getSessionEntryByIdAsync(params)),
    listSessionEntries: session.listSessionEntries,
    createSessionEntryListReader: (params) =>
      runWithPluginScope(async () => {
        const read = await session.createSessionEntryListReader(params);
        assertRuntimeCurrent();
        return async () =>
          await runWithPluginScope(async () => {
            const result = await read();
            assertRuntimeCurrent();
            return {
              entries: result.entries,
              assertCurrent: () => {
                assertRuntimeCurrent();
                result.assertCurrent();
              },
            };
          });
      }),
    createSessionEntry: async (params) => {
      const { createSessionEntry } = await loadSessionOwnership();
      return await runWithPluginScope(() => createSessionEntry(session, params));
    },
    patchSessionEntry: async (params) => {
      const { withPreparedSessionOwnership, patchSessionEntry } = await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, () =>
          patchSessionEntry(session, params, assertRuntimeCurrent),
        ),
      );
    },
    upsertSessionEntry: async (params) => {
      const { withPreparedSessionOwnership, upsertSessionEntry } = await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, () => upsertSessionEntry(session, params)),
      );
    },
    runWithWorkAdmission: async (params, run) => {
      const { withPreparedSessionOwnership, resolveStoredSessionExecutionOwner } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          const resolveCurrentExecutionOwner = () =>
            resolveStoredSessionExecutionOwner({
              action: "admit work on",
              sessionKey: params.sessionKey,
              storePath: params.storePath,
            });
          const ownerPluginId = resolveCurrentExecutionOwner();
          const admissionSession = ownerPluginId
            ? resolveDelegatedRuntime(ownerPluginId).agent.session
            : session;
          return await admissionSession.runWithWorkAdmission(params, async (signal) => {
            // Admission can wait behind another run that changes ownership.
            // Recheck delegation inside the admitted callback before plugin work starts.
            if (resolveCurrentExecutionOwner() !== ownerPluginId) {
              throw new Error(
                `Session "${params.sessionKey}" changed execution ownership while starting work.`,
              );
            }
            // The owner supplies the admission primitive, but the caller's
            // callback must not inherit the owner's plugin identity.
            return await runWithPluginScope(() => run(signal));
          });
        }),
      );
    },
    updateSessionStoreEntry: async (params) => {
      const { withPreparedSessionOwnership, prepareSessionStoreUpdate } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          const update = prepareSessionStoreUpdate(params, assertRuntimeCurrent);
          return await session.updateSessionStoreEntry({ ...params, update });
        }),
      );
    },
  } satisfies PluginRuntime["agent"]["session"];
  const runEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (params) => {
    const runParams = { ...params };
    const { withPreparedSessionOwnership, prepareRunSessionExecution } =
      await loadSessionOwnership();
    return await runWithPluginScope(() =>
      withPreparedSessionOwnership({ ...runParams, ...runParams.sessionTarget }, async () => {
        const { ownerPluginId, agentHarnessRuntimeOverride } =
          prepareRunSessionExecution(runParams);
        if (agentHarnessRuntimeOverride !== undefined) {
          runParams.agentHarnessRuntimeOverride = agentHarnessRuntimeOverride;
        }
        if (ownerPluginId) {
          return await resolveDelegatedRuntime(ownerPluginId).agent.runEmbeddedAgent(runParams);
        }
        // The public runtime adapter owns admission preparation. Passing
        // host authority through this plugin wrapper is rejected by design.
        return await agent.runEmbeddedAgent(runParams);
      }),
    );
  };
  const runCommandFromIngress: PluginRuntime["agent"]["runCommandFromIngress"] = async (
    params,
    commandRuntime,
  ) => {
    const { senderIsOwner: claimedOwner, messageChannel, ...remainingParams } = params;
    const senderIsOwner = claimedOwner === true;
    // Validate and dispatch the same host-owned values; never re-read plugin-owned authority.
    const ingressParams = { ...remainingParams, senderIsOwner, messageChannel };
    if (
      // Community channels may admit guests; trusted provenance is required only for owner elevation.
      (senderIsOwner && record.origin !== "bundled" && record.trustedOfficialInstall !== true) ||
      currentRegistry().plugins.find((entry) => entry.id === pluginId) !== record ||
      !isPluginRecordActive(registry, record) ||
      !currentRegistry().channels.some(
        (channel) => channel.pluginId === pluginId && channel.plugin.id === messageChannel,
      )
    ) {
      throw new Error(
        `Plugin "${pluginId}" cannot admit authenticated owner authority for channel "${messageChannel ?? "unknown"}".`,
      );
    }
    return await runWithPluginScope(() =>
      agent.runCommandFromIngress(ingressParams, commandRuntime),
    );
  };
  const scopedAgent = Object.create(
    Object.getPrototypeOf(agent),
    Object.getOwnPropertyDescriptors(agent),
    // SAFETY: cloning the prototype and every own descriptor preserves the complete agent surface.
  ) as PluginRuntime["agent"];
  const overrides = {
    resolveThinkingDefault: (params: Parameters<typeof agent.resolveThinkingDefault>[0]) =>
      invokeSelectedRuntime(() => agent.resolveThinkingDefault(params)),
    resolveCliBackendDispatchEligibility: (
      params: Parameters<typeof agent.resolveCliBackendDispatchEligibility>[0],
    ) => invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibility(params)),
    resolveSessionCatalogCreateTarget: (
      params: Parameters<typeof agent.resolveSessionCatalogCreateTarget>[0],
    ) => invokeSelectedRuntime(() => agent.resolveSessionCatalogCreateTarget(params)),
    resolveThinkingPolicy: (params: Parameters<typeof agent.resolveThinkingPolicy>[0]) =>
      invokeSelectedRuntime(() => agent.resolveThinkingPolicy(params)),
    runCommandFromIngress,
    runEmbeddedAgent,
    session: scopedSession,
  } satisfies Partial<PluginRuntime["agent"]>;
  Object.defineProperties(
    scopedAgent,
    Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        { configurable: true, enumerable: true, value },
      ]),
    ),
  );
  return scopedAgent;
}

export function createManagedPluginSubagentRuntime(
  subagent: PluginRuntime["subagent"],
  {
    runWithPluginScope,
    loadSessionOwnership,
  }: Pick<RuntimeScope, "runWithPluginScope" | "loadSessionOwnership">,
): PluginRuntime["subagent"] {
  return {
    complete: (params) => runWithPluginScope(() => subagent.complete(params)),
    run: async (params) => {
      const { withPreparedSessionOwnership, assertSessionIdentitiesOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          assertSessionIdentitiesOwned({
            action: "run",
            sessionKeys: [params.sessionKey],
          });
          return await subagent.run(params);
        }),
      );
    },
    waitForRun: (params) => runWithPluginScope(() => subagent.waitForRun(params)),
    getSessionMessages: (params) => runWithPluginScope(() => subagent.getSessionMessages(params)),
    deleteSession: async (params) => {
      const { withPreparedSessionOwnership, assertStoredSessionEntryOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          assertStoredSessionEntryOwned({ action: "delete", sessionKey: params.sessionKey });
          await subagent.deleteSession(params);
        }),
      );
    },
  } satisfies PluginRuntime["subagent"];
}

export function createManagedPluginGatewayRuntime(
  gateway: PluginRuntime["gateway"],
  {
    runWithPluginScope,
    runWithCurrentPluginScope,
    loadSessionOwnership,
    assertRuntimeCurrent,
  }: Pick<
    RuntimeScope,
    | "runWithPluginScope"
    | "runWithCurrentPluginScope"
    | "loadSessionOwnership"
    | "assertRuntimeCurrent"
  >,
): PluginRuntime["gateway"] {
  const withIdentity = gateway.withUserProfileIdentity;
  const resolveGitHubAccount = gateway.resolveGitHubAccount;
  return {
    isAvailable: () => runWithPluginScope(() => gateway.isAvailable(), false),
    request: async (method, params, options) => {
      const { withPreparedSessionOwnership, assertGatewaySessionRequestOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(
          {
            sessionKey:
              typeof params?.sessionKey === "string"
                ? params.sessionKey
                : typeof params?.key === "string"
                  ? params.key
                  : undefined,
          },
          async () => {
            assertGatewaySessionRequestOwned(method, params);
            return await gateway.request(method, params, options);
          },
        ),
      );
    },
    openPluginPanel: (params) => runWithCurrentPluginScope(() => gateway.openPluginPanel(params)),
    readSessionFacts: (params) => runWithCurrentPluginScope(() => gateway.readSessionFacts(params)),
    withSessionFacts: (select, run) =>
      runWithCurrentPluginScope(() =>
        gateway.withSessionFacts(select, (snapshot) => {
          assertRuntimeCurrent();
          return run(snapshot);
        }),
      ),
    subscribeSessionChanges: (listener) =>
      runWithPluginScope(() =>
        gateway.subscribeSessionChanges((event) => runWithPluginScope(() => listener(event))),
      ),
    withUserProfileIdentity: withIdentity
      ? async (params, run) =>
          await runWithCurrentPluginScope(() =>
            withIdentity(params, async (assertIdentityCurrent) => {
              const assertCurrent = () => {
                assertRuntimeCurrent();
                assertIdentityCurrent();
              };
              assertCurrent();
              return await run(assertCurrent);
            }),
          )
      : undefined,
    resolveGitHubAccount: resolveGitHubAccount
      ? (params) => runWithCurrentPluginScope(() => resolveGitHubAccount(params))
      : undefined,
  } satisfies PluginRuntime["gateway"];
}
