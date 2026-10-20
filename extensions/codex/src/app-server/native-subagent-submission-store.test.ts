import assert from "node:assert/strict";
import path from "node:path";
import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeSubagentSessionAuthority } from "./native-subagent-assignment-store.js";
import {
  createCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  agentMessage,
  collabItem,
  CodexNativeSubagentMonitor,
  createClient,
  createNativeModelSourceFixture,
  createRuntime,
  createCompletionScope,
  directSpawnItem,
  notifyChildStarted,
  threadRead,
} from "./native-subagent-monitor.test-support.js";
import type {
  CodexNativeSubagentPendingAssignment,
  CodexNativeSubagentAssignmentStore,
} from "./native-subagent-pending-assignments.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionStore,
} from "./native-subagent-submission.js";
import { scopeCodexRunBindingStore } from "./session-binding-scope.js";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);
const currentAuthority = () => undefined;

const identity = {
  kind: "session" as const,
  agentId: "main",
  sessionId: "parent-session",
  sessionKey: "agent:main:submission-test",
};
const binding = {
  threadId: "parent-thread",
  cwd: "/workspace",
  appServerRuntimeFingerprint: "runtime-one",
};
const receipt: CodexNativeSubagentSubmission = {
  parentTurnId: "parent-turn",
  callId: "call-one",
  childThreadId: "child-thread",
  submissionId: "child-turn-b",
  predecessorRunId: "codex-thread:child-thread:turn:child-turn-a",
  predecessorNativeTurnId: "child-turn-a",
};
const key = bindingStoreKey(identity);
const recordedCompletion = {
  childThreadId: "child-thread",
  status: "succeeded",
  statusLabel: "recorded_task_result",
  result: "Preserve the recorded result",
} as const;

function makeAssignment(
  owner: CodexNativeSubagentHistoryOwner,
  overrides: Partial<CodexNativeSubagentPendingAssignment> = {},
): CodexNativeSubagentPendingAssignment {
  return {
    runId: "codex-thread:child-thread:turn:child-turn-b",
    childThreadId: receipt.childThreadId,
    nativeTurnId: receipt.submissionId,
    nativeParentThreadId: binding.threadId,
    owner,
    ...overrides,
  };
}

function openState(root: string) {
  return createCodexSqliteTestBindingStateStore({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });
}

async function fixture(initialReceipt?: CodexNativeSubagentSubmission) {
  const root = tempDirs.make("codex-native-submission-");
  const state = openState(root);
  const store = createCodexAppServerBindingStore(state);
  const mutate = store.mutate.bind(store, identity);
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId: binding.threadId,
    sessionId: identity.sessionId,
    lifecycleRevision: "revision-one",
    binding,
  });
  assert(owner, "The fixture binding must have a history owner.");
  await store.mutate(identity, { kind: "set", binding });
  if (initialReceipt) {
    await store.mutate(
      identity,
      { kind: "record-native-subagent-submission", owner, receipt: initialReceipt },
      currentAuthority,
    );
  }
  return {
    root,
    state,
    store,
    owner,
    mutate,
    rotate: (threadId: string) =>
      mutate({
        kind: "replace-thread",
        expectedThreadId: binding.threadId,
        binding: { ...binding, threadId },
      }),
    patch: (patch: Partial<Omit<CodexAppServerThreadBinding, "threadId">>) =>
      mutate({ kind: "patch", threadId: binding.threadId, patch }),
    recordAssignment: (assignment: CodexNativeSubagentPendingAssignment) =>
      store.mutate(
        identity,
        { kind: "record-native-subagent-assignment", owner, assignment },
        currentAuthority,
      ),
    recordReceipt: (value: CodexNativeSubagentSubmission) =>
      store.mutate(
        identity,
        { kind: "record-native-subagent-submission", owner, receipt: value },
        currentAuthority,
      ),
    readAssignments: () => store.readNativeSubagentAssignments?.(identity, owner),
    readSubmissions: () => store.readNativeSubagentSubmissions(identity, owner),
  };
}

describe("native subagent submission receipts in the binding store", () => {
  it("retains recorded completion across native resume without mutating incoming facts", async () => {
    const { owner, readAssignments, recordAssignment } = await fixture();
    const assignment = makeAssignment(owner, {
      runId: "codex-thread:child-thread",
      nativeTurnId: "original-turn",
    });
    await recordAssignment({ ...assignment, recordedCompletion });
    const resumed = { ...assignment, nativeTurnId: "resumed-turn" };
    await recordAssignment(resumed);

    expect(await readAssignments()).toEqual([{ ...resumed, recordedCompletion }]);
    expect(resumed).not.toHaveProperty("recordedCompletion");
  });

  it.each([
    { nativeTurnId: "child-turn-b", reverse: false, discoverTurn: false },
    { nativeTurnId: "resumed-turn", reverse: false, discoverTurn: false },
    { nativeTurnId: "resumed-turn", reverse: true, discoverTurn: false },
    { nativeTurnId: "child-turn-b", reverse: false, discoverTurn: true },
  ])(
    "deduplicates and durably retires only the exact child turn and receipt ($nativeTurnId, reverse=$reverse, discoverTurn=$discoverTurn)",
    async ({ nativeTurnId, reverse, discoverTurn }) => {
      const { root, state, owner, mutate, readAssignments, recordReceipt, recordAssignment } =
        await fixture(receipt);
      const first = makeAssignment(owner, {
        nativeTurnId,
        ...(nativeTurnId === "child-turn-b" ? { submission: receipt } : {}),
      });
      const nextReceipt = { ...receipt, callId: "call-two", submissionId: "child-turn-c" };
      const second = {
        ...first,
        runId: "codex-thread:child-thread:turn:child-turn-c",
        nativeTurnId: "child-turn-c",
        ...(first.submission ? { submission: nextReceipt } : {}),
      };
      await recordReceipt(nextReceipt);
      const row = state.lookup(key);
      assert(row?.state === "active");
      const { submission: _submission, ...unsubmitted } = first;
      const alias = { ...unsubmitted, runId: "codex-thread:child-thread" };
      const { nativeTurnId: _nativeTurnId, ...unobserved } = alias;
      const aliases = [first, { ...(discoverTurn ? unobserved : alias), recordedCompletion }];
      if (reverse) {
        aliases.reverse();
      }
      state.register(key, {
        ...row,
        nativeSubagentAssignments: { version: 1, assignments: [...aliases, second] },
      });
      await recordAssignment(first);
      await recordAssignment(alias);
      const pending = await readAssignments();
      expect(pending).toHaveLength(2);
      expect(pending).toContainEqual({ ...first, recordedCompletion });
      await expect(
        recordAssignment({
          ...first,
          recordedCompletion: { ...recordedCompletion, result: "Conflicting result" },
        }),
      ).rejects.toThrow("Conflicting Codex native pending assignment metadata");
      const retirement = {
        kind: "consume-native-subagent-assignment" as const,
        owner,
        assignment: alias,
        undelivered: true as const,
      };
      await expect(mutate(retirement, currentAuthority)).resolves.toBe(true);
      await expect(mutate(retirement, currentAuthority)).resolves.toBe(true);
      await expect(
        mutate(
          { ...retirement, owner: { ...owner, lifecycleRevision: "other-lifecycle" } },
          currentAuthority,
        ),
      ).resolves.toBe(false);
      await expect(
        mutate({ ...retirement, assignment: { ...alias, runId: second.runId } }, currentAuthority),
      ).resolves.toBe(false);
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const reopened = createLazyCodexAppServerBindingStore(openState(root));
      expect(await reopened.readNativeSubagentSubmissions(identity, owner)).toEqual([nextReceipt]);
      await reopened.mutate(identity, {
        kind: "replace-thread",
        expectedThreadId: binding.threadId,
        binding: { ...binding, threadId: "rotated-parent" },
      });
      const rotated = { ...owner, parentThreadId: "rotated-parent" };
      expect(await reopened.readNativeSubagentAssignments?.(identity, rotated)).toEqual([second]);
    },
  );

  it.each(["receipt", "assignment"] as const)(
    "Stop preserves recovery across a rejected %s acknowledgement and consumes it on retry",
    async (rejectedOwner) => {
      const f = await fixture();
      let store = f.store;
      const { root, owner } = f;
      const stopReceipt = { ...receipt, predecessorRunId: "codex-thread:child-thread" };
      const assignment = makeAssignment(owner, { submission: stopReceipt });
      const assignmentRecorded = createDeferred<boolean>();
      const receiptRecorded = createDeferred<boolean>();
      let reject = false;
      const assertCurrent = () => {
        if (store.read(identity)?.threadId !== binding.threadId) {
          throw new Error("Cancellation binding changed");
        }
      };
      const assignmentStore: CodexNativeSubagentAssignmentStore = {
        assertCurrent,
        assertCurrentAsync: async () => assertCurrent(),
        read: () => store.readNativeSubagentAssignments?.(identity, owner) ?? Promise.resolve([]),
        record: (value, guard) => {
          const recorded = store.mutate(
            identity,
            { kind: "record-native-subagent-assignment", owner, assignment: value },
            guard,
          );
          if (value.runId === assignment.runId && !value.submission) {
            assignmentRecorded.resolve(recorded);
          }
          return recorded;
        },
        consume: (value, guard) =>
          reject && rejectedOwner === "assignment"
            ? Promise.resolve(false)
            : store.mutate(
                identity,
                { kind: "consume-native-subagent-assignment", owner, assignment: value },
                guard,
              ),
      };
      const consumeReceipt = vi.fn<CodexNativeSubagentSubmissionStore["consume"]>((value, guard) =>
        reject && rejectedOwner === "receipt"
          ? Promise.resolve(false)
          : store.mutate(
              identity,
              { kind: "consume-native-subagent-submission", owner, receipt: value },
              guard,
            ),
      );
      const submissionStore: CodexNativeSubagentSubmissionStore = {
        assertCurrent,
        assertCurrentAsync: async () => assertCurrent(),
        read: () => store.readNativeSubagentSubmissions(identity, owner),
        record: (value, guard) => {
          const recorded = store.mutate(
            identity,
            { kind: "record-native-subagent-submission", owner, receipt: value },
            guard,
          );
          receiptRecorded.resolve(recorded);
          return recorded;
        },
        consume: consumeReceipt,
      };
      const client = createClient();
      client.setThreadRead(
        stopReceipt.childThreadId,
        threadRead({
          turnId: stopReceipt.predecessorNativeTurnId,
          status: "inProgress",
          threadStatus: "active",
        }),
      );
      const runtime = createRuntime();
      const custody: AgentHarnessCompletionCustody = {
        signal: new AbortController().signal,
        isCurrent: () => true,
        retain: () => custody,
        settleExecution() {},
        release() {},
      };
      runtime.captureAgentHarnessCompletionCustody.mockResolvedValue(custody);
      const interrupt = vi.fn(async (threadId: string, turnId: string, guard: () => void) => {
        guard();
        expect([threadId, turnId]).toEqual([stopReceipt.childThreadId, stopReceipt.submissionId]);
        await client.completeTurn({
          turnId: stopReceipt.submissionId,
          status: "interrupted",
        });
        return true;
      });
      const monitor = new CodexNativeSubagentMonitor(client.client, runtime, {
        recoveryPollDelaysMs: [],
        interruptChildAndWait: interrupt,
      });
      const completionScope = createCompletionScope(identity.sessionKey);
      const requestCustody = Object.freeze({});
      const modelSource = createNativeModelSourceFixture(["test-model"]);
      const parent = await monitor.registerParent({
        parentThreadId: binding.threadId,
        requesterSessionKey: identity.sessionKey,
        requesterTurnRunId: "parent-run",
        requestCustody,
        agentId: identity.agentId,
        historyOwner: owner,
        completionScope,
        modelSource,
        configurationQualification: {
          assertCurrent: modelSource.assertCurrent,
          hasProvider: (provider) => provider === "test-provider",
        },
        claimDirectChild: () => () => {},
        assignmentStore,
        submissionStore,
      });
      const stop = () =>
        monitor.withDescendantCancellation(
          {
            parentThreadId: binding.threadId,
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            sessionId: identity.sessionId,
            lifecycleRevision: owner.lifecycleRevision,
            acceptsRequest: (acceptedCustody) => acceptedCustody === requestCustody,
            assertCurrent,
          },
          (cancel) => cancel(),
        );
      const reopen = async () => {
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
        store = createLazyCodexAppServerBindingStore(openState(root));
      };
      try {
        await parent.ready;
        parent.bindTurn(stopReceipt.parentTurnId);
        await notifyChildStarted(client);
        await client.item(
          directSpawnItem("v1", binding.threadId, stopReceipt.childThreadId),
          stopReceipt.parentTurnId,
          binding.threadId,
        );
        await client.startTurn(stopReceipt.predecessorNativeTurnId);
        await client.completeTurn({
          turnId: stopReceipt.predecessorNativeTurnId,
          status: "completed",
          items: [agentMessage("a-final", "A result", "final_answer")],
        });
        await client.item(
          collabItem("wait", [stopReceipt.childThreadId], {
            id: "wait-a",
            senderThreadId: binding.threadId,
            agentsStates: {
              [stopReceipt.childThreadId]: { status: "completed", message: "A result" },
            },
          }),
          stopReceipt.parentTurnId,
          binding.threadId,
        );
        const predecessor = threadRead({
          turnId: stopReceipt.predecessorNativeTurnId,
          result: "A result",
          resultPhase: "final_answer",
          threadStatus: "notLoaded",
        });
        predecessor.thread.modelProvider = "test-provider";
        client.setThreadRead(stopReceipt.childThreadId, predecessor);
        await monitor.prepareModelInput({
          threadId: binding.threadId,
          turnId: stopReceipt.parentTurnId,
          itemId: stopReceipt.callId,
          target: stopReceipt.childThreadId,
          readQualification: () => undefined,
          assertCurrent,
        });
        const history = threadRead({
          turnId: stopReceipt.submissionId,
          status: "inProgress",
          threadStatus: "active",
        });
        assert(history.thread.turns && predecessor.thread.turns);
        history.thread.turns.unshift(...predecessor.thread.turns);
        history.thread.modelProvider = "test-provider";
        client.setThreadRead(stopReceipt.childThreadId, history);
        await client.item(
          collabItem("sendInput", [stopReceipt.childThreadId], {
            id: stopReceipt.callId,
            senderThreadId: binding.threadId,
          }),
          stopReceipt.parentTurnId,
          binding.threadId,
        );
        await client.sendInputOutput({
          parentThreadId: binding.threadId,
          turnId: stopReceipt.parentTurnId,
          callId: stopReceipt.callId,
          submissionId: stopReceipt.submissionId,
        });
        await client.startTurn(stopReceipt.submissionId);
        expect(await assignmentRecorded.promise).toBe(true);
        expect(await receiptRecorded.promise).toBe(true);
        expect(await assignmentStore.read()).toEqual([assignment]);
        expect(await submissionStore.read()).toEqual([stopReceipt]);
        reject = true;
        const failed = await stop();
        expect(failed.killed).toBe(0);
        expect(failed.errors).toEqual([
          new Error(
            rejectedOwner === "receipt"
              ? "Cancelled native follow-up receipt was not acknowledged."
              : "Cancelled native assignment was not acknowledged.",
          ),
        ]);
        await reopen();
        expect(await assignmentStore.read()).toEqual([assignment]);
        expect(await submissionStore.read()).toEqual(
          rejectedOwner === "receipt" ? [stopReceipt] : [],
        );
        reject = false;
        const retried = await stop();
        expect(retried.killed).toBe(1);
        expect(retried.errors).toBeUndefined();
        expect(interrupt).toHaveBeenCalledOnce();
        expect(consumeReceipt).toHaveBeenCalledTimes(rejectedOwner === "receipt" ? 2 : 1);
        await reopen();
        expect(await assignmentStore.read()).toEqual([]);
        expect(await submissionStore.read()).toEqual([]);
        expect(runtime.deliverAgentHarnessCompletion).not.toHaveBeenCalled();
      } finally {
        await parent.unregister();
        await monitor.dispose();
      }
    },
  );

  it("refuses receipt persistence after the captured parent lifecycle changes", async () => {
    const { root, owner, mutate, readSubmissions } = await fixture();
    const scope = {
      agentId: identity.agentId,
      sessionKey: identity.sessionKey,
      storePath: path.join(root, "agents", identity.agentId, "sessions", "sessions.json"),
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    };
    const entry = {
      sessionId: identity.sessionId,
      lifecycleRevision: owner.lifecycleRevision,
      updatedAt: 1,
    };
    await patchSessionEntry({
      ...scope,
      fallbackEntry: entry,
      replaceEntry: true,
      skipMaintenance: true,
      update: () => entry,
    });
    const parent = await captureSessionEntryCurrentCheckAsync(scope);
    using _ = { [Symbol.dispose]: () => parent.release() };
    const authority = createNativeSubagentSessionAuthority(parent);
    await patchSessionEntry({
      ...scope,
      replaceEntry: true,
      skipMaintenance: true,
      update: () => ({ ...entry, lifecycleRevision: "replacement-lifecycle" }),
    });
    await expect(
      mutate(
        { kind: "record-native-subagent-submission", owner, receipt },
        currentAuthority,
        authority,
      ),
    ).rejects.toThrow();
    expect(await readSubmissions()).toEqual([]);
  });

  it("reopens initial assignment facts across native rotation but not physical adoption", async () => {
    const { root, owner, recordAssignment, rotate } = await fixture();
    const assignment = makeAssignment(owner, {
      runId: "codex-thread:initial-child",
      childThreadId: "initial-child",
      nativeTurnId: "initial-turn",
    });
    await expect(recordAssignment(assignment)).resolves.toBe(true);
    await rotate("rotated-parent");
    resetPluginStateStoreForTests();
    const reopened = createLazyCodexAppServerBindingStore(openState(root));
    const rotated = { ...owner, parentThreadId: "rotated-parent" };
    expect(await reopened.readNativeSubagentAssignments?.(identity, rotated)).toEqual([assignment]);
    expect(await reopened.readNativeSubagentSubmissions(identity, rotated)).toEqual([]);
    const successor = { ...identity, sessionId: "new-physical-session" };
    await reopened.adoptSessionGeneration(successor, identity.sessionId, currentAuthority);
    expect(
      await reopened.readNativeSubagentAssignments?.(successor, {
        ...rotated,
        sessionId: successor.sessionId,
      }),
    ).toEqual([]);
  });

  it("persists concurrent receipts across reopen and consumes only the exact submission", async () => {
    const { root, state, store, owner, mutate } = await fixture();
    const logicalIdentity = { ...identity, sessionId: "logical-parent-session" };
    const logicalOwner = { ...owner, sessionId: logicalIdentity.sessionId };
    const scope = (bindingStore: CodexAppServerBindingStore) =>
      scopeCodexRunBindingStore({ bindingStore, logicalIdentity, physicalIdentity: identity });
    const peer = scope(createLazyCodexAppServerBindingStore(state));
    const second = {
      ...receipt,
      callId: "call-two",
      childThreadId: "second-child",
      predecessorRunId: "codex-thread:second-child:turn:child-turn-a",
    };
    const record = { kind: "record-native-subagent-submission" as const, owner, receipt };
    const logicalRecord = { ...record, owner: logicalOwner };
    await expect(
      Promise.all([
        mutate(record, currentAuthority),
        peer.mutate(logicalIdentity, { ...logicalRecord, receipt: second }, currentAuthority),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(peer.mutate(logicalIdentity, logicalRecord, currentAuthority)).resolves.toBe(true);
    await expect(
      peer.mutate(
        logicalIdentity,
        { ...logicalRecord, receipt: { ...receipt, childThreadId: "wrong-child" } },
        currentAuthority,
      ),
    ).resolves.toBe(false);
    expect(store.read(identity)).toEqual(binding);

    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    const reopenedState = openState(root);
    const reopened = scope(createLazyCodexAppServerBindingStore(reopenedState));
    expect(await reopened.readNativeSubagentSubmissions(logicalIdentity, logicalOwner)).toEqual([
      receipt,
      second,
    ]);
    const consume = { ...logicalRecord, kind: "consume-native-subagent-submission" as const };
    const wrongTurn = { ...consume, receipt: { ...receipt, submissionId: "wrong-turn" } };
    await expect(reopened.mutate(logicalIdentity, wrongTurn, currentAuthority)).resolves.toBe(
      false,
    );
    await expect(reopened.mutate(logicalIdentity, consume, currentAuthority)).resolves.toBe(true);
    await expect(reopened.mutate(logicalIdentity, consume, currentAuthority)).resolves.toBe(true);
    expect(await reopened.readNativeSubagentSubmissions(logicalIdentity, logicalOwner)).toEqual([
      second,
    ]);
    const consumeSecond = { ...consume, receipt: second };
    await expect(reopened.mutate(logicalIdentity, consumeSecond, currentAuthority)).resolves.toBe(
      true,
    );
    expect(reopenedState.lookup(key)).not.toHaveProperty("nativeSubagentSubmissions");
    await expect(reopened.mutate(logicalIdentity, consumeSecond, currentAuthority)).resolves.toBe(
      false,
    );
    expect(reopened.read(logicalIdentity)).toEqual(binding);
  });

  it.each(["missing", "retired", "generation", "actor", "thread", "connection", "lifecycle"])(
    "rejects receipt reads and writes for a %s owner without changing the binding",
    async (scenario) => {
      const { state, store, owner } = await fixture(receipt);
      let selectedIdentity = identity;
      let selectedOwner: CodexNativeSubagentHistoryOwner = owner;
      if (scenario === "missing") {
        state.delete(key);
      } else if (scenario === "retired") {
        await store.retireSessionGeneration(identity);
      } else if (scenario === "generation") {
        selectedIdentity = { ...identity, sessionId: "replacement-session" };
        selectedOwner = { ...owner, sessionId: selectedIdentity.sessionId };
      } else if (scenario === "actor") {
        selectedOwner = { ...owner, sessionId: "unrelated-session" };
      } else if (scenario === "thread") {
        selectedOwner = { ...owner, parentThreadId: "replacement-thread" };
      } else if (scenario === "connection") {
        selectedOwner = { ...owner, connectionFingerprint: "f".repeat(64) };
      } else {
        selectedOwner = { ...owner, lifecycleRevision: "replacement-revision" };
      }
      const before = state.lookup(key);
      expect(await store.readNativeSubagentSubmissions(selectedIdentity, selectedOwner)).toEqual(
        [],
      );
      for (const kind of [
        "record-native-subagent-submission",
        "consume-native-subagent-submission",
      ] as const) {
        await expect(
          store.mutate(selectedIdentity, { kind, owner: selectedOwner, receipt }, currentAuthority),
        ).resolves.toBe(false);
      }
      expect(state.lookup(key)).toEqual(before);
    },
  );

  it.each(["record-native-subagent-submission", "consume-native-subagent-submission"] as const)(
    "rechecks current authority before the atomic %s update",
    async (kind) => {
      const { state, owner } = await fixture(receipt);
      const before = state.lookup(key);
      let current = true;
      const guarded = createCodexAppServerBindingStore({
        ...state,
        withCurrent(authority) {
          const mutationState = state.withCurrent(authority);
          return {
            ...mutationState,
            compareAndApply(stateKey, comparison, intent) {
              current = false;
              return mutationState.compareAndApply(stateKey, comparison, intent);
            },
          };
        },
      });
      await expect(
        guarded.mutate(identity, { kind, owner, receipt }, () => {
          if (!current) {
            throw new Error("Parent authority changed.");
          }
        }),
      ).rejects.toThrow("Parent authority changed.");
      expect(state.lookup(key)).toEqual(before);
    },
  );

  it("preserves receipts through same-owner writes and binding leases", async () => {
    const { state, store, mutate, readSubmissions, patch } = await fixture(receipt);
    await store.withLease(identity, async () => {
      await mutate({ kind: "set", binding: { ...binding, model: "gpt-5.5" } });
      await patch({ serviceTier: "priority" });
      expect(await readSubmissions()).toEqual([receipt]);
    });
    expect(await readSubmissions()).toEqual([receipt]);
    expect(state.lookup(key)).not.toHaveProperty("lease");
    expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5", serviceTier: "priority" });
  });

  it.each(["thread", "connection", "reset", "retire"])(
    "clears receipt metadata when the binding changes its %s boundary",
    async (scenario) => {
      const { state, store, readSubmissions, rotate, patch } = await fixture(receipt);
      if (scenario === "thread") {
        await rotate("replacement-thread");
      } else if (scenario === "connection") {
        await patch({ appServerRuntimeFingerprint: "replacement-runtime" });
      } else if (scenario === "reset") {
        await store.resetSessionGeneration(identity);
      } else {
        await store.retireSessionGeneration(identity);
      }
      expect(state.lookup(key) ?? {}).not.toHaveProperty("nativeSubagentSubmissions");
      expect(store.read(identity)).toEqual(
        scenario === "thread"
          ? { ...binding, threadId: "replacement-thread" }
          : scenario === "connection"
            ? { ...binding, appServerRuntimeFingerprint: "replacement-runtime" }
            : undefined,
      );
      expect(await readSubmissions()).toEqual([]);
    },
  );

  it.each([true, false])(
    "adopts physical sessions with lifecycle stamp present=%s",
    async (stamped) => {
      const { state, store, owner, readSubmissions, recordReceipt } = await fixture();
      if (!stamped) {
        delete owner.lifecycleRevision;
      }
      await recordReceipt(receipt);
      const successor = { ...identity, sessionId: "adopted-session" };
      await expect(store.adoptSessionGeneration(successor, identity.sessionId)).resolves.toBe(
        "adopted",
      );
      const successorOwner = { ...owner, sessionId: successor.sessionId };
      expect(await store.readNativeSubagentSubmissions(successor, successorOwner)).toEqual(
        stamped ? [receipt] : [],
      );
      expect(store.read(successor)).toEqual(binding);
      expect(await readSubmissions()).toEqual([]);
      if (stamped) {
        const replacement = { ...successorOwner, lifecycleRevision: "replacement-revision" };
        expect(await store.readNativeSubagentSubmissions(successor, replacement)).toEqual([]);
        await expect(
          store.mutate(
            successor,
            {
              kind: "record-native-subagent-submission",
              owner: replacement,
              receipt,
            },
            currentAuthority,
          ),
        ).resolves.toBe(false);
      } else {
        expect(state.lookup(bindingStoreKey(successor))).not.toHaveProperty(
          "nativeSubagentSubmissions",
        );
      }
    },
  );

  it.each([
    { version: 2, future: ["preserve-me"] },
    { version: 1, receipts: ["malformed"] },
  ])(
    "preserves unreadable receipt metadata through writes and retirement (version $version)",
    async (metadata) => {
      const { root, state, store, owner, mutate, readSubmissions, recordAssignment, patch } =
        await fixture();
      state.register(key, {
        version: 1,
        state: "active",
        sessionId: identity.sessionId,
        binding,
        nativeSubagentSubmissions: metadata,
      });
      await store.withLease(identity, async () => {
        await mutate({ kind: "set", binding });
        await patch({ model: "gpt-5.5" });
      });
      expect(store.read(identity)).toEqual({ ...binding, model: "gpt-5.5" });
      const before = state.lookup(key);
      expect(before).toHaveProperty("nativeSubagentSubmissions", metadata);
      await expect(readSubmissions()).rejects.toThrow(/native subagent submission/i);
      for (const kind of [
        "record-native-subagent-submission",
        "consume-native-subagent-submission",
      ] as const) {
        await expect(mutate({ kind, owner, receipt }, currentAuthority)).rejects.toThrow(
          /native subagent submission/i,
        );
      }
      expect(state.lookup(key)).toEqual(before);

      const assignment = makeAssignment(owner);
      await recordAssignment(assignment);
      const retirement = {
        kind: "consume-native-subagent-assignment" as const,
        owner,
        assignment,
        undelivered: true as const,
      };
      await expect(mutate(retirement, currentAuthority)).resolves.toBe(true);
      await expect(mutate(retirement, currentAuthority)).resolves.toBe(true);
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      const reopenedState = openState(root);
      const reopened = createLazyCodexAppServerBindingStore(reopenedState);
      expect(await reopened.readNativeSubagentAssignments?.(identity, owner)).toEqual([]);
      expect(reopenedState.lookup(key)).toEqual(before);
    },
  );
});
