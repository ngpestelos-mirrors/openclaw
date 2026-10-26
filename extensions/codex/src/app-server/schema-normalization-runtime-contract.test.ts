import path from "node:path";
import {
  createParameterFreeTool,
  createPermissiveTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { threadStartResult as nativeThreadStartResult } from "./codex-app-server.test-fixtures.js";
import type { CodexThreadStartParams } from "./protocol.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createAppServerOptions as createBaseAppServerOptions,
  createLifecycleRequest,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThreadWithEmptySkillCatalog as startOrResumeThreadImpl,
} from "./thread-lifecycle.test-fixtures.js";

let tempDir: string;
let bindingStore: ReturnType<typeof createCodexTestBindingStore>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function threadStartResult(threadId = "thread-1", serviceTier: string | null = null) {
  const result = nativeThreadStartResult(threadId, tempDir);
  return {
    ...result,
    thread: { ...result.thread, cliVersion: "0.149.0" },
    model: "gpt-5.4",
    serviceTier,
  };
}

function createRun(result = () => threadStartResult()) {
  const workspaceDir = path.join(tempDir, "workspace");
  const appServer = { ...createBaseAppServerOptions(), connectionClass: "local-loopback" as const };
  const request = createLifecycleRequest(async (method) => {
    if (method === "thread/start") {
      return result();
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const start = (dynamicTools: Parameters<typeof startOrResumeThreadImpl>[0]["dynamicTools"]) =>
    startOrResumeThreadImpl({
      client: { request } as never,
      params: {
        ...createParams(path.join(tempDir, "session.jsonl"), workspaceDir),
        modelId: "gpt-5.4",
      },
      cwd: workspaceDir,
      dynamicTools,
      appServer,
      bindingStore,
    });
  return { request, start, workspaceDir };
}

beforeEach(() => {
  bindingStore = createCodexTestBindingStore();
  tempDir = tempDirs.make("openclaw-codex-schema-contract-");
});

afterEach(() => {
  resetThreadLifecycleTestFixtures();
  vi.restoreAllMocks();
});

it.each([null, "priority"])(
  "passes canonical thread start specs with service tier %s",
  async (serviceTier) => {
    const { request, start, workspaceDir } = createRun(() =>
      threadStartResult(serviceTier ? "thread-priority" : "thread-1", serviceTier),
    );
    const { name, description } = createParameterFreeTool("message");
    const inputSchema = normalizedParameterFreeSchema();
    const dynamicTools = serviceTier
      ? []
      : [{ type: "function" as const, name, description, inputSchema }];
    const binding = await start(dynamicTools);
    expect(binding.threadId).toBe(serviceTier ? "thread-priority" : "thread-1");

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "config/read",
      "configRequirements/read",
      "thread/start",
    ]);
    const startPayload = request.mock.calls[2]?.[1] as CodexThreadStartParams | undefined;
    expect(startPayload?.dynamicTools).toStrictEqual(
      serviceTier ? [] : [{ type: "function", name, description, inputSchema }],
    );
    expect(startPayload).toMatchObject({
      cwd: workspaceDir,
      model: "gpt-5.4",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "OpenClaw",
      experimentalRawEvents: true,
    });
    expect(startPayload?.modelProvider).toBeUndefined();
    expect(startPayload?.developerInstructions).toEqual(expect.stringContaining("OpenClaw"));
  },
);

it("treats dynamic tool schema changes as thread-fingerprint changes", async () => {
  let nextThreadId = 1;
  const { start } = createRun(() => threadStartResult(`thread-${nextThreadId++}`));

  const permissiveTool = createPermissiveTool("message");
  const tool = {
    type: "function" as const,
    name: permissiveTool.name,
    description: permissiveTool.description,
  };
  const first = await start([{ ...tool, inputSchema: { type: "object" } }]);
  const second = await start([{ ...tool, inputSchema: permissiveTool.parameters }]);
  expect([first.threadId, second.threadId]).toEqual(["thread-1", "thread-2"]);
});
