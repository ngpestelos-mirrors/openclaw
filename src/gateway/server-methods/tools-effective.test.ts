import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { McpToolCatalog } from "../../agents/agent-bundle-mcp-types.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import type { EffectiveToolInventoryResult as ToolsEffectivePayload } from "../../agents/tools-effective-inventory.types.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../plugins/tool-metadata.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { toolsEffectiveHandlers, testing } from "./tools-effective.js";

type InventoryModule = typeof import("../../agents/tools-effective-inventory.js");
type SessionLookup = typeof import("../session-utils.js").loadGatewaySessionEntryReadOnlyAsync;
type SessionMcpRuntimeView = Pick<
  NonNullable<
    ReturnType<typeof import("../../agents/agent-bundle-mcp-tools.js").peekSessionMcpRuntime>
  >,
  "configFingerprint" | "peekCatalog" | "workspaceDir"
>;
type AcquiredRuntimeModelContext = Awaited<
  ReturnType<InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]>
>;

const runtimeMocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(() => ({
    channel: "telegram",
    to: "channel-1",
    accountId: "acct-1",
    threadId: "thread-2",
  })),
  applyFinalEffectiveToolPolicy: vi.fn<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js").applyFinalEffectiveToolPolicy
  >((params) => params.bundledTools),
  buildBundleMcpToolsFromCatalog: vi.fn<
    typeof import("../../agents/agent-bundle-mcp-tools.js").buildBundleMcpToolsFromCatalog
  >(() => []),
  getActivePluginChannelRegistryVersion: vi.fn(() => 1),
  getActivePluginRegistryVersion: vi.fn(() => 1),
  getRegisteredAgentHarness: vi.fn(),
  resolveRuntimeConfigCacheKey: vi.fn(() => "runtime:1:test"),
  resolveAgentDir: vi.fn(() => "/tmp/agents/main/agent"),
  loadSessionEntry: vi.fn<
    (...args: Parameters<SessionLookup>) => Awaited<ReturnType<SessionLookup>>
  >(() => ({
    cfg: {},
    agentId: "main",
    storePath: "/tmp/sessions.json",
    store: {},
    canonicalKey: "main:abc",
    entry: {
      sessionId: "session-1",
      updatedAt: 1,
      lastChannel: "telegram",
      lastAccountId: "acct-1",
      lastThreadId: "thread-2",
      lastTo: "channel-1",
      groupId: "group-4",
      groupChannel: "#ops",
      space: "workspace-5",
      chatType: "group",
      modelProvider: "openai",
      model: "gpt-4.1",
      spawnedBy: "agent:main:telegram:group:parent-group",
      spawnedWorkspaceDir: undefined as string | undefined,
    },
    storeKeys: ["main:abc"],
    legacyKey: undefined,
  })),
  peekSessionMcpRuntime: vi.fn<() => SessionMcpRuntimeView | undefined>(() => undefined),
  resolveSessionMcpConfigSummary: vi.fn(() => ({
    fingerprint: "mcp:1:test",
    serverNames: [] as string[],
  })),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace-main"),
  resolveEffectiveToolInventory: vi.fn(),
  resolveReplyToMode: vi.fn<
    typeof import("../../auto-reply/reply/reply-threading.js").resolveReplyToMode
  >(() => "first"),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
  getConnectedNodePluginToolsVersion: vi.fn(() => 1),
  acquireEffectiveToolInventoryRuntimeModelContext: vi.fn<
    InventoryModule["acquireEffectiveToolInventoryRuntimeModelContext"]
  >(async (): Promise<AcquiredRuntimeModelContext> => ({
    run: (project) =>
      project({
        modelApi: "openai-responses",
        runtimeModel: makeProviderModelFixture({
          id: "gpt-4.1",
          name: "GPT 4.1",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          contextWindow: 128_000,
          maxTokens: 8_192,
        }),
      }),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  })),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-bundle-mcp-tools.js")>()),
  buildBundleMcpToolsFromCatalog: runtimeMocks.buildBundleMcpToolsFromCatalog,
  peekSessionMcpRuntime: runtimeMocks.peekSessionMcpRuntime,
  resolveSessionMcpConfigSummary: runtimeMocks.resolveSessionMcpConfigSummary,
}));
vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentDir: runtimeMocks.resolveAgentDir,
  resolveAgentWorkspaceDir: runtimeMocks.resolveAgentWorkspaceDir,
  resolveSessionAgentId: runtimeMocks.resolveSessionAgentId,
}));
vi.mock("../../agents/embedded-agent-runner/effective-tool-policy.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
  >()),
  applyFinalEffectiveToolPolicy: runtimeMocks.applyFinalEffectiveToolPolicy,
}));
vi.mock("../../agents/harness/registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/harness/registry.js")>()),
  getRegisteredAgentHarness: runtimeMocks.getRegisteredAgentHarness,
}));
vi.mock("../../agents/tools-effective-inventory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools-effective-inventory.js")>()),
  resolveEffectiveToolInventory: runtimeMocks.resolveEffectiveToolInventory,
  acquireEffectiveToolInventoryRuntimeModelContext:
    runtimeMocks.acquireEffectiveToolInventoryRuntimeModelContext,
}));
vi.mock("../../auto-reply/reply/reply-threading.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/reply-threading.js")>()),
  resolveReplyToMode: runtimeMocks.resolveReplyToMode,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  resolveRuntimeConfigCacheKey: runtimeMocks.resolveRuntimeConfigCacheKey,
}));
vi.mock("../../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/runtime.js")>()),
  getActivePluginChannelRegistryVersion: runtimeMocks.getActivePluginChannelRegistryVersion,
  getActivePluginRegistryVersion: runtimeMocks.getActivePluginRegistryVersion,
}));
vi.mock("../../utils/delivery-context.read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/delivery-context.read.js")>()),
  deliveryContextFromSession: runtimeMocks.deliveryContextFromSession,
}));
vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  resolveSessionModelRef: runtimeMocks.resolveSessionModelRef,
}));
// mock-isolation: effective-tool policy tests supply session metadata without a database worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => runtimeMocks.loadSessionEntry(params.key, { agentId: params.agentId }),
}));
vi.mock("../node-plugin-tool-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-plugin-tool-snapshot.js")>()),
  getConnectedNodePluginToolsVersion: runtimeMocks.getConnectedNodePluginToolsVersion,
}));

const { applyFinalEffectiveToolPolicy } = await vi.importActual<
  typeof import("../../agents/embedded-agent-runner/effective-tool-policy.js")
>("../../agents/embedded-agent-runner/effective-tool-policy.js");

type RespondCall = [boolean, unknown?, { code: number; message: string }?];
function createInvokeParams(
  params: Record<string, unknown> = { sessionKey: "main:abc" },
  cfg: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await expectDefined(
        toolsEffectiveHandlers["tools.effective"],
        'toolsEffectiveHandlers["tools.effective"] test invariant',
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => cfg } as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

async function invokeTools(
  params: Record<string, unknown> = { sessionKey: "main:abc" },
  cfg: Record<string, unknown> = {},
) {
  const { respond, invoke } = createInvokeParams(params, cfg);
  await invoke();
  return respond;
}

function mockSession(entry: Partial<NonNullable<Awaited<ReturnType<SessionLookup>>["entry"]>>) {
  const loaded = expectDefined(
    runtimeMocks.loadSessionEntry.getMockImplementation(),
    "session fixture",
  )("main:abc");
  runtimeMocks.loadSessionEntry.mockReturnValueOnce({
    ...loaded,
    entry: { ...expectDefined(loaded.entry, "session fixture"), ...entry },
  });
}

function resolveEffectiveToolInventoryArg(callIndex = 0): Record<string, unknown> | undefined {
  const calls = runtimeMocks.resolveEffectiveToolInventory.mock.calls as unknown as Array<
    [Record<string, unknown>]
  >;
  return calls[callIndex]?.[0];
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function payloadOf(respond: ReturnType<typeof vi.fn>) {
  return firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
}

function makeMcpTool(
  params: Record<string, unknown> = { type: "object", properties: {} },
  identity = {
    name: "reproProbe__probe_tool",
    label: "Probe Tool",
    toolName: "probe_tool",
    serverName: "reproProbe",
    deniedBySession: false,
  },
) {
  const tool = {
    name: identity.name,
    label: identity.label,
    description: "Probe from MCP",
    parameters: params,
    execute: vi.fn(),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: identity.serverName,
      safeServerName: identity.serverName,
      toolName: identity.toolName,
      operation: "tool",
      ...(identity.deniedBySession ? { deniedBySession: true } : {}),
    },
  });
  return tool;
}

function makeCoreInventory(
  tool: { id: string; label: string; description: string; rawDescription?: string } = {
    id: "exec",
    label: "Exec",
    description: "Run shell commands",
  },
): ToolsEffectivePayload {
  return {
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            ...tool,
            rawDescription: tool.rawDescription ?? tool.description,
            source: "core",
          },
        ],
      },
    ],
  };
}

function makeMcpCatalog(): McpToolCatalog {
  return { version: 1, generatedAt: 1, servers: {}, tools: [] };
}

function mockMcpConfigSummary(params: { fingerprint?: string; serverNames?: string[] } = {}): void {
  runtimeMocks.resolveSessionMcpConfigSummary.mockReturnValueOnce({
    fingerprint: params.fingerprint ?? "mcp:1:test",
    serverNames: params.serverNames ?? ["reproProbe"],
  });
}

function mockWarmMcpRuntime(
  catalog: McpToolCatalog,
  params: { workspaceDir?: string; configFingerprint?: string } = {},
): void {
  runtimeMocks.peekSessionMcpRuntime.mockReturnValueOnce({
    workspaceDir: params.workspaceDir ?? "/tmp/workspace-main",
    configFingerprint: params.configFingerprint ?? "mcp:1:test",
    peekCatalog: () => catalog,
  });
}

function mockWarmMcpTool(params: Record<string, unknown> = { type: "object", properties: {} }) {
  mockMcpTools([makeMcpTool(params)]);
}

function mockMcpTools(
  tools: ReturnType<typeof makeMcpTool>[],
  summary: Parameters<typeof mockMcpConfigSummary>[0] = {},
  catalog = makeMcpCatalog(),
) {
  mockMcpConfigSummary(summary);
  mockWarmMcpRuntime(catalog);
  runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce(tools);
}

function expectInvalidResponse(respond: ReturnType<typeof vi.fn>, message: string): void {
  const call = firstRespondCall(respond);
  expect(call?.[0]).toBe(false);
  expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  expect(call?.[2]?.message).toContain(message);
}

function expectPayloadGroupIds(respond: ReturnType<typeof vi.fn>, ids: string[]): void {
  const payload = payloadOf(respond);
  expect(payload?.groups?.map((group) => group.id)).toEqual(ids);
}

function expectResponsesOk(...responds: Array<ReturnType<typeof vi.fn>>): void {
  for (const respond of responds) {
    expect(firstRespondCall(respond)?.[0]).toBe(true);
  }
}

function expectPayloadNotice(respond: ReturnType<typeof vi.fn>, id: string) {
  const payload = payloadOf(respond);
  const notice = payload?.notices?.[0];
  expect(notice?.id).toBe(id);
  return notice;
}

describe("tools.effective handler", () => {
  afterEach(() => {
    memorySessionActorOwners.reset();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(runtimeMocks)) {
      mock.mockReset();
    }
    testing.resetToolsEffectiveCacheForTest();
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValue(makeCoreInventory());
  });

  it("rejects caller-supplied auth context params", async () => {
    expectInvalidResponse(
      await invokeTools({ sessionKey: "main:abc", senderIsOwner: true }),
      "invalid tools.effective params",
    );
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("uses memory session facts and refuses inventory after its captured owner closes", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/effective-tools");
    const sessionKey = "agent:main:dashboard:incognito-tools";
    const owner = memorySessionActorOwners.get({
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    });
    const actor = await owner.acquire(
      { sessionKey, database: owner.identity },
      { assertCurrent() {}, assertReadable() {} },
    );
    try {
      expect(
        (
          await actor.storage!.mutate(
            {
              type: "session.entry.create",
              input: { entry: { sessionId: "private-tools", updatedAt: 1, incognito: true } },
            },
            { assertCurrent() {}, authorize() {} },
          )
        ).kind,
      ).toBe("committed");
      const first = await invokeTools({ sessionKey });
      expect(firstRespondCall(first)?.[0]).toBe(true);
      expect(resolveEffectiveToolInventoryArg()?.sessionId).toBe("private-tools");
      expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
      testing.resetToolsEffectiveCacheForTest();
      runtimeMocks.resolveEffectiveToolInventory.mockImplementationOnce(async () => {
        memorySessionActorOwners.closeDatabase(owner);
        return makeCoreInventory();
      });
      const second = await invokeTools({ sessionKey });
      expect(firstRespondCall(second)?.[0]).toBe(false);
    } finally {
      await actor.release();
    }
  });

  it("rejects unknown session keys", async () => {
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const respond = await invokeTools({ sessionKey: "missing-session" });
    expectInvalidResponse(respond, 'unknown session key "missing-session"');
  });

  it.each([
    ["sessionId", "session-2"],
    ["spawnedWorkspaceDir", "/tmp/workspace-sandbox"],
  ] as const)("invalidates fresh inventory when %s changes", async (field, value) => {
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(
        makeCoreInventory({ id: "old_session_tool", label: "Old", description: "Old session" }),
      )
      .mockResolvedValueOnce(
        makeCoreInventory({ id: "new_session_tool", label: "New", description: "New session" }),
      );
    const first = await invokeTools();
    mockSession(field === "sessionId" ? { sessionId: value } : { spawnedWorkspaceDir: value });
    const second = await invokeTools();
    expect(firstRespondCall(first)?.[1]).toMatchObject({
      groups: [{ tools: [{ id: "old_session_tool" }] }],
    });
    expect(firstRespondCall(second)?.[1]).toMatchObject({
      groups: [{ tools: [{ id: "new_session_tool" }] }],
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);
    const inventoryField = field === "sessionId" ? "sessionId" : "workspaceDir";
    expect(resolveEffectiveToolInventoryArg(1)?.[inventoryField]).toBe(value);
  });

  it("updates returned web_search availability when only the saved override changes", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => clock.mockRestore());
    const { resolveEffectiveToolInventory } = await vi.importActual<InventoryModule>(
      "../../agents/tools-effective-inventory.js",
    );
    runtimeMocks.resolveEffectiveToolInventory.mockImplementation(resolveEffectiveToolInventory);
    const cfg: OpenClawConfig = {
      tools: { web: { search: { enabled: true, provider: "brave" } } },
    };
    const loaded = runtimeMocks.loadSessionEntry("main:abc");
    const entry = expectDefined(loaded.entry, "session fixture");

    // Keep all other cache inputs and time fixed across both override transitions.
    for (const webSearch of [undefined, false, true, undefined]) {
      runtimeMocks.loadSessionEntry.mockReturnValueOnce({
        ...loaded,
        cfg,
        entry: { ...entry, toolOverrides: { webSearch } },
      });
      const respond = await invokeTools({ sessionKey: "main:abc" }, cfg);
      expectResponsesOk(respond);
      const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
      const toolIds = payload.groups?.flatMap((group) => group.tools?.map((tool) => tool.id) ?? []);
      expect(toolIds?.includes("web_search")).toBe(webSearch !== false);
    }
  });

  it("coalesces identical base inventory cache misses while inventory resolution is pending", async () => {
    const first = createInvokeParams();
    const second = createInvokeParams();

    await Promise.all([first.invoke(), second.invoke()]);

    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);
    expectResponsesOk(first.respond, second.respond);
  });

  it("returns stale cached base inventory immediately while refreshing in the background", async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => clock.mockRestore());
    const stalePayload = makeCoreInventory({
      id: "read",
      label: "Read",
      description: "Read files",
    });
    const refreshedPayload = makeCoreInventory();
    runtimeMocks.resolveEffectiveToolInventory
      .mockResolvedValueOnce(stalePayload)
      .mockResolvedValueOnce(refreshedPayload);

    await invokeTools();
    now += 11_000;

    const stale = await invokeTools();

    expect(firstRespondCall(stale)?.[1]).toBe(stalePayload);
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runtimeMocks.resolveEffectiveToolInventory).toHaveBeenCalledTimes(2);

    const fresh = await invokeTools();
    expect(firstRespondCall(fresh)?.[1]).toBe(refreshedPayload);
  });

  it("reports configured MCP servers as not connected without starting them", async () => {
    mockMcpConfigSummary({ serverNames: ["zeta", "alpha"] });
    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"]);
    const notice = expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(notice?.message).toContain('"alpha", "zeta"');
    expect(notice?.servers).toEqual(["alpha", "zeta"]);
  });

  it("applies inherited MCP denies from the session entry already read by the request", async () => {
    const sessionKey = "agent:main:subagent:prepared-policy";
    runtimeMocks.loadSessionEntry.mockReturnValueOnce({
      cfg: { session: { store: "/tmp/tools-effective-prepared-policy/sessions.sqlite" } },
      agentId: "main",
      storePath: "/tmp/tools-effective-prepared-policy/sessions.sqlite",
      store: {},
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
      entry: {
        sessionId: "prepared-policy-session",
        updatedAt: 1,
        spawnDepth: 1,
        spawnedBy: "agent:main:main",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["reproProbe__probe_tool"],
      },
    });
    mockWarmMcpTool();
    runtimeMocks.applyFinalEffectiveToolPolicy.mockImplementationOnce(
      applyFinalEffectiveToolPolicy,
    );

    const respond = await invokeTools({ sessionKey });

    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expectPayloadGroupIds(respond, ["core"]);
    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledOnce();
  });

  it("projects MCP tools from the session-owning native harness catalog", async () => {
    mockSession({ agentHarnessId: "codex", toolOverrides: { mcpToolsDeny: { docs: ["delete"] } } });
    mockMcpConfigSummary();
    const catalog = makeMcpCatalog();
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(catalog);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    runtimeMocks.buildBundleMcpToolsFromCatalog.mockReturnValueOnce([makeMcpTool()]);

    const respond = await invokeTools();

    expect(loadMcpToolCatalog).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "main:abc",
      workspaceDir: "/tmp/workspace-main",
      mcpServerNames: ["reproProbe"],
      toolOverrides: { mcpToolsDeny: { docs: ["delete"] } },
    });
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).toHaveBeenCalledWith({
      catalog,
      reservedToolNames: ["exec"],
      includeSessionDenied: true,
    });
    expectPayloadGroupIds(respond, ["core", "mcp"]);
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("does not substitute the core MCP catalog when native inventory is unavailable", async () => {
    mockSession({ agentHarnessId: "codex" });
    mockMcpConfigSummary();
    const loadMcpToolCatalog = vi.fn().mockResolvedValue(undefined);
    runtimeMocks.getRegisteredAgentHarness.mockReturnValueOnce({
      harness: { loadMcpToolCatalog },
    });
    mockWarmMcpRuntime(makeMcpCatalog());

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-not-yet-connected");
    expect(runtimeMocks.peekSessionMcpRuntime).not.toHaveBeenCalled();
  });

  it("preserves raw MCP identities and session denials across sanitized collisions", async () => {
    const enabled = makeMcpTool(undefined, {
      name: "collision__alpha-",
      label: "Alpha bang",
      toolName: "alpha!",
      serverName: "collision",
      deniedBySession: false,
    });
    const denied = makeMcpTool(undefined, {
      name: "collision__alpha--2",
      label: "Alpha question",
      toolName: "alpha?",
      serverName: "collision",
      deniedBySession: true,
    });
    const catalog = makeMcpCatalog();
    mockMcpTools([enabled, denied], { serverNames: ["collision"] }, catalog);

    const respond = await invokeTools();

    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload | undefined;
    expect(payload?.groups?.[0]?.tools?.[0]).toEqual({
      id: "exec",
      label: "Exec",
      description: "Run shell commands",
      rawDescription: "Run shell commands",
      source: "core",
    });
    expect(payload?.groups?.[1]?.tools).toEqual([
      expect.objectContaining({
        id: "collision__alpha-",
        mcpServer: "collision",
        mcpToolName: "alpha!",
      }),
      expect.objectContaining({
        id: "collision__alpha--2",
        mcpServer: "collision",
        mcpToolName: "alpha?",
        deniedBySession: true,
      }),
    ]);
  });

  it("quarantines warm MCP tools with schemas the runtime cannot project", async () => {
    mockWarmMcpTool({ type: "array", items: { type: "string" } });

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "unsupported-tool-schema:reproProbe__probe_tool");
  });

  it.each(["empty", "mixed"])(
    "reports unavailable MCP servers with a %s catalog without losing base notices",
    async (kind) => {
      const baseNotice = { id: "base-notice", severity: "info", message: "Keep the base notice" };
      const base = { ...makeCoreInventory(), notices: [baseNotice] };
      const diagnostic = {
        serverName: "offline",
        safeServerName: "offline",
        launchSummary: "https://mcp.example.invalid/mcp",
        message:
          "unavailable; retry after 2026-09-25T12:00:30.000Z; check reachability or reload MCP",
      };
      runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(base);
      mockMcpTools(
        kind === "empty" ? [] : [makeMcpTool()],
        { serverNames: ["offline", "reproProbe"] },
        { ...makeMcpCatalog(), diagnostics: [diagnostic] },
      );

      const respond = await invokeTools();

      expectPayloadGroupIds(respond, kind === "empty" ? ["core"] : ["core", "mcp"]);
      const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
      expect(payload.notices).toEqual([
        baseNotice,
        {
          id: "mcp-server-diagnostic:offline",
          severity: "warning",
          message: `MCP server "offline": ${diagnostic.message}`,
          servers: ["offline"],
        },
      ]);
      expect(base.notices).toEqual([baseNotice]);
    },
  );

  it("keeps usable MCP tools and ordered quarantine notices without changing the cached base", async () => {
    const base = {
      ...makeCoreInventory(),
      notices: [{ id: "base-notice", severity: "info", message: "Keep the base notice" }],
    };
    const originalBase = structuredClone(base);
    Object.freeze(base.groups);
    Object.freeze(base.notices);
    Object.freeze(base);
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(base);
    const invalid = makeMcpTool({ type: "array", items: { type: "string" } });
    invalid.name = "reproProbe__invalid";
    mockMcpTools([makeMcpTool(), invalid]);

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core", "mcp"]);
    const payload = firstRespondCall(respond)?.[1] as ToolsEffectivePayload;
    expect(payload.groups?.[1]?.tools?.map((tool) => tool.id)).toEqual(["reproProbe__probe_tool"]);
    expect(payload.notices?.map((notice) => notice.id)).toEqual([
      "base-notice",
      "unsupported-tool-schema:reproProbe__invalid",
    ]);
    expect(base).toEqual(originalBase);
  });

  it("does not project stale MCP catalogs after config changes", async () => {
    mockMcpConfigSummary({ fingerprint: "mcp:2:test" });
    mockWarmMcpRuntime(makeMcpCatalog(), {
      configFingerprint: "mcp:1:test",
    });

    const respond = await invokeTools();

    expectPayloadGroupIds(respond, ["core"]);
    expectPayloadNotice(respond, "mcp-stale-catalog");
    expect(runtimeMocks.buildBundleMcpToolsFromCatalog).not.toHaveBeenCalled();
  });

  it("rejects unknown agent ids before loading the session", async () => {
    const respond = await invokeTools({
      sessionKey: "main:abc",
      agentId: "other",
    });
    expectInvalidResponse(respond, 'unknown agent id "other"');
    expect(runtimeMocks.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("loads a bare session through the persisted fixed-store owner", async () => {
    const cfg: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
        defaults: { sessionStore: { agentId: "ops" } },
      },
    };
    const entry = { sessionId: "session-ops-global", updatedAt: 1 };
    runtimeMocks.loadSessionEntry.mockReturnValue({
      cfg,
      agentId: "ops",
      canonicalKey: "global",
      entry,
      store: { global: entry },
      storePath: "/tmp/shared-sessions.sqlite",
      storeKeys: ["global"],
      legacyKey: undefined,
    });
    runtimeMocks.resolveSessionAgentId.mockReturnValue("ops");
    runtimeMocks.resolveEffectiveToolInventory.mockResolvedValueOnce(makeCoreInventory());

    const respond = await invokeTools({ sessionKey: "global" }, cfg);

    expect(runtimeMocks.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expect(firstRespondCall(respond)?.[0]).toBe(true);
    expect(resolveEffectiveToolInventoryArg()?.agentId).toBe("ops");
  });
});
