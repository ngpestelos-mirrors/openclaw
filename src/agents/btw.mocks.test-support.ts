import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { AgentHarnessHostCapabilities } from "./harness/host-capability-types.js";
import type { AgentHarness } from "./harness/types.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.js";
type RuntimeAliasParams = Parameters<
  typeof import("./model-runtime-aliases.js").resolveCliRuntimeExecutionProvider
>[0];
export const streamSimpleMock = vi.fn();
export const parseSessionEntriesMock = vi.fn();
export const migrateSessionEntriesMock = vi.fn();
export const buildSessionContextMock = vi.fn();
export const ensureOpenClawModelsJsonMock = vi.fn();
export const loadPreparedModelRuntimeSnapshotMock = vi.fn();
export const snapshotResources: { acquire?: () => { release: () => Promise<void> } } = {};
export const discoverAuthStorageMock = vi.fn();
export const discoverModelsMock = vi.fn();
export const getModelRegistryRuntimeMock = vi.fn();
export const resolveModelWithRegistryMock = vi.fn();
export const ensureAuthProfileStoreMock = vi.fn();
export const ensureAuthProfileStoreWithoutExternalProfilesMock = vi.fn();
export const resolveModelAsyncMock = vi.fn();
export const getApiKeyForModelMock = vi.fn();
export const requireApiKeyMock = vi.fn();
export const resolveSessionAuthSelectionMock = vi.fn();
export const getActiveEmbeddedRunSnapshotMock = vi.fn();
export const resolveSessionAgentIdMock = vi.fn();
export const resolveSessionAgentIdsMock = vi.fn();
export const resolveAgentWorkspaceDirMock = vi.fn();
export const listAgentEntriesMock = vi.fn();
export const prepareProviderRuntimeAuthMock = vi.fn();
export const registerProviderStreamForModelMock = vi.fn();
export const resolveEmbeddedAgentStreamMock = vi.fn();
export const prepareCliRunContextMock = vi.fn();
export const executePreparedCliRunMock = vi.fn();
export const diagDebugMock = vi.fn();
export const ensureSelectedAgentHarnessPluginMock = vi.fn();
export const createAgentHarnessHostCapabilitiesMock = vi.fn();
export const closeAgentHarnessHostCapabilitiesMock = vi.fn();
export const agentHarnessHostCapabilitiesMock: AgentHarnessHostCapabilities = Object.freeze({
  kind: "agent-harness-host-capability",
  version: 1,
  assertActive: vi.fn(),
  bindToolSurface: vi.fn((tools) => tools),
  runBeforeToolCall: vi.fn(),
  requestApproval: vi.fn(),
  waitForApproval: vi.fn(),
});
export const listSessionEntriesCoreMock = vi.fn();
export const loadSessionEntryMock = vi.fn();
export const loadTranscriptEventsMock = vi.fn();
const builtInOpenClawHarnesses = new WeakSet<object>();
export const shouldPreferExplicitConfigApiKeyAuthMock = vi.fn((..._args: unknown[]) => false);
export const hasUsableCustomProviderApiKeyMock = vi.fn((..._args: unknown[]) => false);
export const resolveProviderEntryApiKeyProfileReferenceMock = vi.fn(
  (_params?: unknown): unknown => ({
    kind: "none",
  }),
);
export const preparedRuntimeSnapshotState = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  useSnapshotPluginRegistry: false,
}));

vi.mock("../llm/stream.js", async () => {
  const original = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...original,
    streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
  };
});

vi.mock("./sessions/session-manager.js", () => ({
  buildSessionContext: (...args: unknown[]) => buildSessionContextMock(...args),
  generateSummary: vi.fn(async () => "summary"),
  migrateSessionEntries: (...args: unknown[]) => migrateSessionEntriesMock(...args),
  parseSessionEntries: (...args: unknown[]) => parseSessionEntriesMock(...args),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

// mock-isolation: BTW fixtures supply their own auth and model registries without opening real stores.
vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModelsAsync: async (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: (...args: unknown[]) => getModelRegistryRuntimeMock(...args),
}));

vi.mock("./prepared-model-runtime.js", () => {
  const loadSnapshot = async (params: PreparedModelRuntimeInput) => {
    loadPreparedModelRuntimeSnapshotMock(params);
    const workspaceOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : {};
    const configOptions = { config: params.config, ...workspaceOptions };
    await ensureOpenClawModelsJsonMock(params.config, params.agentDir, workspaceOptions);
    const authStorage = discoverAuthStorageMock(params.agentDir, {
      ...configOptions,
      ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
    });
    const modelRegistry = discoverModelsMock(authStorage, params.agentDir, configOptions);
    return {
      ...(preparedRuntimeSnapshotState.snapshot as object),
      ...(preparedRuntimeSnapshotState.useSnapshotPluginRegistry
        ? {}
        : { pluginRegistry: getActivePluginRegistry() }),
      agentId: params.agentId,
      agentDir: params.agentDir,
      config: params.config,
      workspaceDir: params.workspaceDir,
      configuredRuntimeModels: [],
      findConfiguredRuntimeModel: () => undefined,
      inlineProviderModels: [],
      createStores: () => ({ authStorage, modelRegistry }),
    };
  };
  return {
    preparedModelRuntimeConfigsMatch: (left: unknown, right: unknown) => left === right,
    loadPreparedModelRuntimeSnapshot: loadSnapshot,
    acquirePublishedPreparedModelRuntime: async (params: Parameters<typeof loadSnapshot>[0]) => {
      const snapshot = await loadSnapshot(params);
      return {
        snapshot,
        [Symbol.asyncDispose]: snapshotResources.acquire?.().release ?? (async () => {}),
      };
    },
  };
});

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./embedded-agent-runner/model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedded-agent-runner/model.js")>()),
  resolveModelAsync: (...args: unknown[]) => resolveModelAsyncMock(...args),
}));

// mock-isolation: Side-question runs use controlled auth results without host credential discovery.
vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  ensureAuthProfileStoreAsync: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  ensureAuthProfileStoreWithoutExternalProfiles: (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(...args),
  ensureAuthProfileStoreWithoutExternalProfilesAsync: (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(...args),
  getApiKeyForModelCore: (...args: unknown[]) => getApiKeyForModelMock(...args),
  hasUsableCustomProviderApiKey: (...args: unknown[]) => hasUsableCustomProviderApiKeyMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
  resolveProviderEntryApiKeyProfileReference: (params: unknown) =>
    resolveProviderEntryApiKeyProfileReferenceMock(params),
  shouldPreferExplicitConfigApiKeyAuth: (...args: unknown[]) =>
    shouldPreferExplicitConfigApiKeyAuthMock(...args),
}));

vi.mock("./model-runtime-aliases.js", () => ({
  isCliRuntimeAliasForProvider: ({ runtime, provider }: { runtime?: string; provider?: string }) =>
    runtime === "claude-cli" && provider === "anthropic",
  resolveCliRuntimeExecutionProvider: (params: RuntimeAliasParams) => {
    const { provider, cfg, modelId, authProfileId } = params;
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    if (runtime && runtime !== "auto") {
      return runtime === "claude-cli" ? runtime : undefined;
    }
    const profiles = authProfileId?.trim()
      ? [authProfileId]
      : (cfg?.auth?.order?.[provider ?? ""] ?? []);
    return profiles.some((id) => cfg?.auth?.profiles?.[id]?.provider === "claude-cli")
      ? "claude-cli"
      : undefined;
  },
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: (...args: unknown[]) => prepareCliRunContextMock(...args),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: (...args: unknown[]) => executePreparedCliRunMock(...args),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (...args: unknown[]) =>
    ensureSelectedAgentHarnessPluginMock(...args),
}));

// Selection and host-capability owner suites execute the embedded runner and capability surface.
// BTW only needs their identities while it verifies side-question orchestration.
vi.mock("./harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: (): AgentHarness => {
    const harness: AgentHarness = {
      id: "openclaw",
      label: "OpenClaw embedded agent",
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt: vi.fn(),
    };
    builtInOpenClawHarnesses.add(harness);
    return harness;
  },
  isBuiltInOpenClawAgentHarness: (harness: AgentHarness) => builtInOpenClawHarnesses.has(harness),
}));

vi.mock("./harness/host-capability.js", () => ({
  createAgentHarnessHostCapabilities: (params: unknown) => {
    createAgentHarnessHostCapabilitiesMock(params);
    return {
      capabilities: agentHarnessHostCapabilitiesMock,
      close: closeAgentHarnessHostCapabilitiesMock,
    };
  },
}));

vi.mock("./embedded-agent-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
}));

vi.mock("./agent-scope.js", () => ({
  listAgentEntries: (...args: unknown[]) => listAgentEntriesMock(...args),
  listAgentEntriesWithSource: () => [],
  resolveAgentConfig: (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
  resolveSessionAgentIds: (...args: unknown[]) => resolveSessionAgentIdsMock(...args),
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentDir: () => "/tmp/agent",
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: (...args: unknown[]) => prepareProviderRuntimeAuthMock(...args),
}));

// Keep plugin discovery out of BTW orchestration tests.
vi.mock("../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" as const }),
}));

vi.mock("../plugins/provider-policy-surface.js", () => ({
  resolveDirectBundledProviderPolicySurface: (provider: string) => {
    if (provider.trim().toLowerCase() !== "openai") {
      return null;
    }
    return {
      normalizeModelCatalogId: ({ modelId }: { modelId: string }) => modelId,
      resolveModelRoutes: ({
        requestTransportOverrides = "none",
      }: ProviderResolveModelRoutesContext) => {
        const compatibleIds =
          requestTransportOverrides === "none" ? ["openclaw", "codex"] : ["openclaw"];
        return {
          kind: "routes" as const,
          defaultRuntimeId: requestTransportOverrides === "none" ? "codex" : "openclaw",
          routes: (
            [
              ["openai-responses", "https://api.openai.com/v1", "api-key"],
              ["openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "subscription"],
            ] as const
          ).map(([api, baseUrl, authRequirement]) => ({
            api,
            baseUrl,
            authRequirement,
            requestTransportOverrides,
            runtimePolicy: { compatibleIds },
          })),
        };
      },
    };
  },
  resolveTrustedExternalProviderPolicySurface: () => null,
}));

vi.mock("./provider-stream.js", () => ({
  registerProviderStreamForModel: (...args: unknown[]) =>
    registerProviderStreamForModelMock(...args),
}));

vi.mock("./embedded-agent-runner/stream-resolution.js", () => ({
  resolveEmbeddedAgentStream: (...args: unknown[]) => resolveEmbeddedAgentStreamMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: (...args: unknown[]) => resolveSessionAuthSelectionMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

// mock-isolation: BTW fixtures supply transcript events without opening the transcript database.
vi.mock("../config/sessions/session-accessor.js", () => ({
  findTranscriptEvent: vi.fn(async () => undefined),
  loadTranscriptEvents: (...args: unknown[]) => loadTranscriptEventsMock(...args),
}));

vi.mock("../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryInWorker: async (...args: unknown[]) => loadSessionEntryMock(...args),
  readSessionEntrySummariesInWorker: async (...args: unknown[]) =>
    listSessionEntriesCoreMock(...args),
}));
