// Verifies sessions_spawn lifecycle hooks and gateway calls.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagents/spawn/subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  updateSessionStoreMock: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentProgress: vi.fn(async () => {}),
}));

let resetSubagentRegistryForTests: typeof import("./subagents/registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagents/spawn/subagent-spawn.js").spawnSubagentDirect;

const requireRecord = createRequireRecord("object", "expected-label");

function expectFields(value: unknown, expected: Record<string, unknown>, label = "object"): void {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
}

function expectSubagentSessionKey(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  const sessionKey = value as string;
  expect(sessionKey.startsWith("agent:main:subagent:")).toBe(true);
  return sessionKey;
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params?: {
  task?: string;
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  context?: "isolated" | "fork";
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
}) {
  return await spawnSubagentDirect(
    {
      task: params?.task ?? "do thing",
      ...(params?.label ? { label: params.label } : {}),
      ...(params?.model ? { model: params.model } : {}),
      ...(typeof params?.runTimeoutSeconds === "number"
        ? { runTimeoutSeconds: params.runTimeoutSeconds }
        : {}),
      context: params?.context ?? "isolated",
    },
    {
      agentSessionKey: params?.agentSessionKey ?? "main",
      agentChannel: params?.agentChannel ?? "discord",
      agentAccountId: params?.agentAccountId,
      agentTo: params?.agentTo,
      agentThreadId: params?.agentThreadId,
      currentMessagingTarget: params?.currentMessagingTarget,
      currentChannelId: params?.currentChannelId,
      currentMessageId: params?.currentMessageId,
    },
  );
}

function requireSpawnedHookCall(): [Record<string, unknown>, Record<string, unknown>] {
  const call = hookRunnerMocks.runSubagentSpawned.mock.calls[0] as readonly unknown[] | undefined;
  if (!call) {
    throw new Error("expected spawned hook call");
  }
  return [requireRecord(call[0], "spawned event"), requireRecord(call[1], "spawned context")];
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    updateSessionStoreMock: hoisted.updateSessionStoreMock,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawned" || hookName === "subagent_progress",
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentProgress: hookRunnerMocks.runSubagentProgress,
    },
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentProgress.mockClear();
    setConfig({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    });
    const store: Record<string, Record<string, unknown>> = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_storePath: unknown, mutator: unknown) => {
        if (typeof mutator !== "function") {
          throw new Error("missing session store mutator");
        }
        await mutator(store);
        return store;
      },
    );
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("emits subagent_spawned with requester metadata", async () => {
    const result = await spawn({
      label: "research",
      model: "openai/gpt-5.4",
      runTimeoutSeconds: 1,
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
      currentMessagingTarget: "channel:source",
      currentChannelId: "source-native",
      currentMessageId: "message-789",
      context: "isolated",
    });

    expectFields(
      result,
      {
        status: "accepted",
        runId: "run-1",
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawn result",
    );
    expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
    const [event, ctx] = requireSpawnedHookCall();
    expectFields(
      event,
      {
        runId: "run-1",
        agentId: "main",
        label: "research",
        mode: "run",
        threadRequested: false,
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawned event",
    );
    expectFields(
      event.requester,
      {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      "spawned requester",
    );
    expectSubagentSessionKey(event.childSessionKey, "spawned event child session key");
    expectFields(
      ctx,
      {
        runId: "run-1",
        requesterSessionKey: "main",
        childSessionKey: event.childSessionKey,
      },
      "spawned context",
    );
    expect(hookRunnerMocks.runSubagentProgress).toHaveBeenCalledWith(
      {
        phase: "started",
        runId: "run-1",
        childSessionKey: event.childSessionKey,
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:source",
          threadId: 456,
          channelId: "source-native",
          messageId: "message-789",
        },
      },
      ctx,
    );
    expect(
      hookRunnerMocks.runSubagentProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      hookRunnerMocks.runSubagentSpawned.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
