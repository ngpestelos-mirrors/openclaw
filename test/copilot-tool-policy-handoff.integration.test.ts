import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createCopilotToolPolicyHarnessFixtureForTest } from "../extensions/copilot/test-api.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../src/agents/harness/registry.js";
import { runAgentHarnessAttempt } from "../src/agents/harness/selection.js";
import { createHarnessAttemptParams } from "../src/agents/harness/selection.test-support.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../src/test-utils/session-state-cleanup.js";

const createdFixtures: Array<ReturnType<typeof createCopilotToolPolicyHarnessFixtureForTest>> = [];
afterEach(async () => {
  clearAgentHarnesses();
  await Promise.all(createdFixtures.splice(0).map((fixture) => fixture.dispose()));
});
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-copilot-policy-");

function createUserTurnRecorder(message: Extract<AgentMessage, { role: "user" }>) {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: vi.fn(async () => message),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(() => {
      persisted = true;
    }),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  };
}

it.each([
  { name: "disabled tools", policy: { disableTools: true }, restricted: true },
  { name: "empty runtime allowlist", policy: { toolsAllow: [] }, restricted: true },
  { name: "unrestricted control", policy: {}, restricted: false },
])("enforces $name before native create, resume, and filesystem effects", async (testCase) => {
  const workspaceDir = sessionDirs.make();
  const outputPath = path.join(workspaceDir, "native-write-proof.txt");
  const fixture = createCopilotToolPolicyHarnessFixtureForTest(outputPath);
  createdFixtures.push(fixture);
  registerAgentHarness(fixture.harness, { ownerPluginId: "copilot" });
  const sessionId = `session-${testCase.name.replaceAll(" ", "-")}`;
  const target = {
    agentId: "copilot-policy-proof",
    sessionId,
    sessionKey: `agent:copilot-policy-proof:${sessionId}`,
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await replaceSessionEntry(target, { sessionId, updatedAt: 1 });

  for (const phase of ["create", "resume"]) {
    const runId = `${sessionId}-${phase}`;
    const admission = prepareAgentRunAdmission({
      cfg: {},
      facts: {
        runId,
        agentId: target.agentId,
        ingress: { kind: "system", boundary: "copilot-policy-handoff-test", state: "present" },
      },
      operationalRunInstance: createOperationalRunInstanceRef(runId),
    });
    try {
      const admitted = await admission.admit("plugin-harness", "copilot");
      const message = { role: "user" as const, content: "write the proof file", timestamp: 1 };
      const result = await runAgentHarnessAttempt({
        ...createHarnessAttemptParams(admitted, {
          plugins: { enabled: false },
          tools: { codeMode: false, fs: { workspaceOnly: true }, toolSearch: false },
        }),
        ...testCase.policy,
        agentId: target.agentId,
        agentDir: workspaceDir,
        agentHarnessRuntimeOverride: "copilot",
        auth: { useLoggedInUser: true },
        messages: [message],
        model: { api: "openai-responses", id: "gpt-4.1", provider: "github-copilot" } as Model,
        modelId: "gpt-4.1",
        profileVersion: "v1",
        prompt: message.content,
        provider: "github-copilot",
        sessionFile: path.join(workspaceDir, `${sessionId}.jsonl`),
        sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        userTurnTranscriptRecorder: createUserTurnRecorder(message),
        workspaceDir,
      } as EmbeddedRunAttemptParams);
      expect(result.terminal).toEqual({ kind: "ok" });
    } finally {
      admission.close();
    }
  }
  expect([fixture.createConfigs.length, fixture.resumeConfigs.length]).toEqual([1, 1]);
  for (const config of [...fixture.createConfigs, ...fixture.resumeConfigs]) {
    if (testCase.restricted) {
      expect(config).toMatchObject({ toolNames: [], availableTools: [] });
    } else {
      expect(config).toMatchObject({
        toolNames: expect.arrayContaining(["write"]),
        writeHandler: true,
        availableTools: expect.arrayContaining(["write", "builtin:ask_user"]),
      });
    }
  }
  if (testCase.restricted) {
    expect(fixture.writeResults).toEqual([]);
    await expect(fs.readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    const success = expect.objectContaining({ resultType: "success" });
    expect(fixture.writeResults).toEqual([success, success]);
    await expect(fs.readFile(outputPath, "utf8")).resolves.toBe("write-1-1");
  }
});
