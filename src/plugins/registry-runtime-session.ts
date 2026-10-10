import type { SessionEntry } from "../config/sessions/types.js";
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
      runWithPluginScope(async () => {
        const entry = await session.getSessionEntryAsync(params);
        assertRuntimeCurrent();
        return entry;
      }),
    getSessionEntryByIdAsync: (params) =>
      runWithPluginScope(async () => {
        const entry = await session.getSessionEntryByIdAsync(params);
        assertRuntimeCurrent();
        return entry;
      }),
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
      const { assertOwnedHarness, assertReservedSessionKeyOwned } = await loadSessionOwnership();
      return await runWithPluginScope(async () => {
        const runtimeOwnerCount = [
          "agentHarnessId" in params.initialEntry,
          "cliBackendId" in params.initialEntry,
          "acpSessionBinding" in params.initialEntry,
        ].filter(Boolean).length;
        if (runtimeOwnerCount !== 1) {
          throw new Error(
            `Plugin "${pluginId}" session creation requires exactly one runtime owner.`,
          );
        }
        if ("agentHarnessId" in params.initialEntry) {
          // Session ownership follows the registered harness capability,
          // independently of whether the caller chooses its reserved namespace.
          assertOwnedHarness(params.initialEntry.agentHarnessId, "create its sessions");
          assertReservedSessionKeyOwned(params.key, "create");
          return await session.createSessionEntry(params);
        }
        const initialEntry = params.initialEntry;
        if (!("acpSessionBinding" in initialEntry)) {
          const backend = currentRegistry().cliBackends.find(
            (entry) => entry.backend.id === initialEntry.cliBackendId,
          );
          if (!backend || backend.pluginId !== pluginId) {
            throw new Error(
              `Plugin "${pluginId}" must own CLI backend "${initialEntry.cliBackendId}" to create its sessions.`,
            );
          }
        }
        // Plugin-owned sessions stay inside a namespace that no other plugin can claim.
        if (!params.key.startsWith(`plugin:${pluginId}:`)) {
          throw new Error(
            `Plugin "${pluginId}" session keys must start with "plugin:${pluginId}:".`,
          );
        }
        return await session.createSessionEntry({
          ...params,
          initialEntry: { ...initialEntry, pluginOwnerId: pluginId },
        });
      });
    },
    patchSessionEntry: async (params) => {
      const { withPreparedSessionOwnership, assertStoredSessionEntryOwned, assertStoreEntryOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          assertStoredSessionEntryOwned({
            action: "patch",
            sessionKey: params.sessionKey,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
          });
          return await session.patchSessionEntry({
            ...params,
            update: async (entry, context) => {
              const patch = await params.update(entry, context);
              assertRuntimeCurrent();
              if (!patch) {
                return patch;
              }
              const next = params.replaceEntry
                ? (patch as SessionEntry)
                : ({ ...entry, ...patch } satisfies SessionEntry);
              assertStoreEntryOwned({
                action: "patch",
                before: context.existingEntry ?? entry,
                entry: next,
                sessionKey: params.sessionKey,
              });
              return patch;
            },
          });
        }),
      );
    },
    upsertSessionEntry: async (params) => {
      const { withPreparedSessionOwnership, assertStoredSessionEntryOwned, assertStoreEntryOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          const before = assertStoredSessionEntryOwned({
            action: "upsert",
            sessionKey: params.sessionKey,
            ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
            ...(params.env !== undefined ? { env: params.env } : {}),
            ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
          });
          assertStoreEntryOwned({
            action: "upsert",
            before,
            entry: params.entry,
            sessionKey: params.sessionKey,
          });
          await session.upsertSessionEntry(params);
        }),
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
      const { withPreparedSessionOwnership, assertStoredSessionEntryOwned, assertStoreEntryOwned } =
        await loadSessionOwnership();
      return await runWithPluginScope(() =>
        withPreparedSessionOwnership(params, async () => {
          assertStoredSessionEntryOwned({
            action: "update",
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          });
          return await session.updateSessionStoreEntry({
            ...params,
            update: async (entry) => {
              const patch = await params.update(entry);
              assertRuntimeCurrent();
              if (!patch) {
                return patch;
              }
              assertStoreEntryOwned({
                action: "update",
                before: entry,
                entry: { ...entry, ...patch },
                sessionKey: params.sessionKey,
              });
              return patch;
            },
          });
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
  ) as PluginRuntime["agent"];
  Object.defineProperties(scopedAgent, {
    resolveThinkingDefault: {
      configurable: true,
      enumerable: true,
      value: (params: Parameters<typeof agent.resolveThinkingDefault>[0]) =>
        invokeSelectedRuntime(() => agent.resolveThinkingDefault(params)),
    },
    resolveCliBackendDispatchEligibility: {
      configurable: true,
      enumerable: true,
      value: (params: Parameters<typeof agent.resolveCliBackendDispatchEligibility>[0]) =>
        invokeSelectedRuntime(() => agent.resolveCliBackendDispatchEligibility(params)),
    },
    resolveSessionCatalogCreateTarget: {
      configurable: true,
      enumerable: true,
      value: (params: Parameters<typeof agent.resolveSessionCatalogCreateTarget>[0]) =>
        invokeSelectedRuntime(() => agent.resolveSessionCatalogCreateTarget(params)),
    },
    resolveThinkingPolicy: {
      configurable: true,
      enumerable: true,
      value: (params: Parameters<typeof agent.resolveThinkingPolicy>[0]) =>
        invokeSelectedRuntime(() => agent.resolveThinkingPolicy(params)),
    },
    runCommandFromIngress: {
      configurable: true,
      enumerable: true,
      value: runCommandFromIngress,
    },
    runEmbeddedAgent: {
      configurable: true,
      enumerable: true,
      value: runEmbeddedAgent,
    },
    session: {
      configurable: true,
      enumerable: true,
      value: scopedSession,
    },
  });
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
    loadSessionOwnership,
    assertRuntimeCurrent,
  }: Pick<RuntimeScope, "runWithPluginScope" | "loadSessionOwnership" | "assertRuntimeCurrent">,
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
    openPluginPanel: (params) =>
      runWithPluginScope(async () => {
        const result = await gateway.openPluginPanel(params);
        assertRuntimeCurrent();
        return result;
      }),
    readSessionFacts: (params) =>
      runWithPluginScope(async () => {
        const result = await gateway.readSessionFacts(params);
        assertRuntimeCurrent();
        return result;
      }),
    withSessionFacts: (select, run) =>
      runWithPluginScope(async () => {
        const result = await gateway.withSessionFacts(select, (snapshot) => {
          assertRuntimeCurrent();
          return run(snapshot);
        });
        assertRuntimeCurrent();
        return result;
      }),
    subscribeSessionChanges: (listener) =>
      runWithPluginScope(() =>
        gateway.subscribeSessionChanges((event) => runWithPluginScope(() => listener(event))),
      ),
    withUserProfileIdentity: withIdentity
      ? async (params, run) =>
          await runWithPluginScope(async () => {
            const result = await withIdentity(params, async (assertIdentityCurrent) => {
              const assertCurrent = () => {
                assertRuntimeCurrent();
                assertIdentityCurrent();
              };
              assertCurrent();
              return await run(assertCurrent);
            });
            assertRuntimeCurrent();
            return result;
          })
      : undefined,
    resolveGitHubAccount: resolveGitHubAccount
      ? (params) =>
          runWithPluginScope(async () => {
            const result = await resolveGitHubAccount(params);
            assertRuntimeCurrent();
            return result;
          })
      : undefined,
  } satisfies PluginRuntime["gateway"];
}
