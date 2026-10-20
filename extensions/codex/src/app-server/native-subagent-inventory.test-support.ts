import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { Type } from "typebox";
import { onTestFinished, vi } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import {
  createNativeSubagentAssignmentStore,
  createNativeSubagentSessionAuthority,
} from "./native-subagent-assignment-store.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  agentMessage,
  collabItem,
  createClient,
  createNativeModelSourceFixture,
  directSpawnItem,
  nativeHistoryOwner,
} from "./native-subagent-monitor.test-support.js";
import type { CodexNativeSubagentSubmissionStore } from "./native-subagent-submission.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import { createParams, tempDir } from "./run-attempt-test-harness.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  type CodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

export async function fixture() {
  const identity = {
    kind: "session" as const,
    agentId: "main",
    // Session entry cleanup preserves history, so fixtures need distinct physical transcripts.
    sessionId: randomUUID(),
    sessionKey: "agent:main:inventory",
  };
  await seedRunSessionOwnerForTest(identity.sessionId, identity.sessionKey, {
    lifecycleRevision: "inventory-generation",
  });
  const sessionScope = {
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    storePath: resolveStorePath(undefined, { agentId: identity.agentId }),
  };
  const entry = getSessionEntry(sessionScope);
  assert(entry?.lifecycleRevision);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => vi.useRealTimers());
  const lifecycleRevision = entry.lifecycleRevision;
  const historyOwner = (parentThreadId = "parent-thread"): CodexNativeSubagentHistoryOwner => ({
    ...nativeHistoryOwner(parentThreadId),
    sessionId: identity.sessionId,
    lifecycleRevision,
  });
  const binding = {
    threadId: "parent-thread",
    cwd: tempDir,
    appServerRuntimeFingerprint: "connection-A",
  };
  const state = createCodexTestBindingStateStore();
  const store = createCodexAppServerBindingStore(state);
  await store.mutate(identity, { kind: "set", binding });
  const deliver = vi.fn(defaultNativeSubagentMonitorRuntime.deliverAgentHarnessCompletion);
  // Isolate outbound user delivery only; capture/isCurrent/retain are the real host contract.
  deliver.mockImplementation(async ({ completionCustody }) => {
    assert(completionCustody?.isCurrent(), "Delivery must retain real, current host custody");
    return { delivered: true, path: "direct" };
  });
  const runtime = {
    ...defaultNativeSubagentMonitorRuntime,
    deliverAgentHarnessCompletion: deliver,
  };
  let sequence = 0;
  const register = async (
    client: ReturnType<typeof createClient>,
    owner = historyOwner(),
    modelSource?: ReturnType<typeof createNativeModelSourceFixture>,
    configurationQualification?: CodexInferenceThreadQualification,
    options: {
      bindingStore?: CodexAppServerBindingStore;
      retainParentThread?: (threadId: string) => () => void;
    } = {},
  ) => {
    const registrationStore = options.bindingStore ?? store;
    const params = createParams(`${tempDir}/inventory-${++sequence}.jsonl`, tempDir, {
      ...identity,
      runId: `inventory-${sequence}`,
    });
    params.agentId = identity.agentId;
    const host = await createAdmittedHostCapabilityTestFixture(params, { gatewayContext: true });
    onTestFinished(() => {
      host.closeHost();
      host.closeAdmission();
      host.closeGateway();
    });
    assert(host.agentHarnessCompletionScope);
    const completionScope = host.agentHarnessCompletionScope;
    const parent = await captureSessionEntryCurrentCheckAsync(sessionScope);
    const authority = createNativeSubagentSessionAuthority(parent);
    const assignmentStore = createNativeSubagentAssignmentStore({
      bindingStore: registrationStore,
      readBinding: () => registrationStore.read(identity),
      identity,
      owner,
      assertLifecycleCurrentAsync: parent.assertCurrent,
      authority,
    });
    const writeSubmission =
      (
        kind: "record-native-subagent-submission" | "consume-native-subagent-submission",
      ): CodexNativeSubagentSubmissionStore["record"] =>
      (receipt, assertCurrent) =>
        registrationStore.mutate(identity, { kind, owner, receipt }, assertCurrent, authority);
    const submissionStore: CodexNativeSubagentSubmissionStore = {
      assertCurrent: () => assignmentStore.assertCurrent(),
      assertCurrentAsync: () => assignmentStore.assertCurrentAsync(),
      read: () => registrationStore.readNativeSubagentSubmissions(identity, owner),
      record: writeSubmission("record-native-subagent-submission"),
      consume: writeSubmission("consume-native-subagent-submission"),
    };
    ensureCodexAppServerClientRuntime(client.client, { agentDir: tempDir });
    const registration: {
      value?: Awaited<ReturnType<typeof codexNativeSubagentMonitorRuntime.register>>;
    } = {};
    const tool = host.hostCapabilities.bindToolSurface([
      {
        name: "register_native_inventory",
        label: "Register native inventory",
        description: "Test registration",
        parameters: Type.Object({}),
        execute: async () => {
          registration.value = await codexNativeSubagentMonitorRuntime.register({
            client: client.client,
            parentThreadId: owner.parentThreadId,
            requesterSessionKey: identity.sessionKey,
            completionScope,
            historyOwner: owner,
            assignmentStore,
            submissionStore,
            assertCurrentAsync: parent.assertCurrent,
            runtime,
            configurationQualification,
            retainParentThread: options.retainParentThread,
            ...(modelSource ? { modelSource } : {}),
          });
          return { content: [{ type: "text", text: "registered" }], details: {} };
        },
      },
    ])[0];
    assert(tool);
    await host.runWithGatewayScope(() => tool.execute("register", {}));
    assert(registration.value);
    return {
      ...registration.value,
      closeGateway: host.closeGateway,
      closeCaller: () => {
        host.closeHost();
        host.closeAdmission();
      },
    };
  };
  const spawn = async (client: ReturnType<typeof createClient>, observeTurn = true) => {
    await client.item({ id: "spawn", ...directSpawnItem("v1", "parent-thread", "child-thread") });
    await client.notify({
      method: "rawResponseItem/completed",
      params: {
        threadId: "parent-thread",
        turnId: "parent-turn",
        item: {
          type: "function_call_output",
          call_id: "spawn",
          output: JSON.stringify({ agent_id: "child-thread" }),
        },
      },
    });
    if (observeTurn) {
      await client.startTurn("child-turn");
    }
  };
  return {
    identity,
    binding,
    state,
    store,
    deliver,
    register,
    spawn,
    historyOwner,
    newBindingStore: () => createCodexAppServerBindingStore(state),
  };
}

export async function completeInForeground(client: ReturnType<typeof createClient>) {
  await client.completeTurn({
    status: "completed",
    items: [agentMessage("final", "Native result", "final_answer")],
  });
  await client.item(
    collabItem("wait", ["child-thread"], {
      id: "wait",
      agentsStates: { "child-thread": { status: "completed", message: "Native result" } },
    }),
  );
}

export async function submitFollowup(client: ReturnType<typeof createClient>) {
  await client.item(collabItem("sendInput", ["child-thread"], { id: "followup" }));
  await client.sendInputOutput({ callId: "followup", submissionId: "followup-turn" });
}
