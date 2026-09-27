import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../subagent-test-fixtures.test-helpers.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import { makeQueuedRun } from "./subagent-registry.run-fixtures.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerRestoredRollbackPublicationTest({
  mocks,
  hydrateAndActivateRegistry,
  mockSingleCollectorConcurrency,
  mockRestoredRuns,
}: {
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "entries" | "persistSubagentRunsToDiskOrThrow" | "callGateway" | "emitSessionLifecycleEvent"
  >;
  hydrateAndActivateRegistry: () => void;
  mockSingleCollectorConcurrency: () => void;
  mockRestoredRuns: (createEntries: () => SubagentRunRecord[]) => void;
}): void {
  it("holds restored rollback for publication and retries settlement without relaunching", async () => {
    vi.useRealTimers();
    const now = Date.now();
    mockSingleCollectorConcurrency();
    mockRestoredRuns(() => [
      makeQueuedRun({ runId: "run-restored-stop-one", groupId: "restore-stop", createdAt: now }),
      makeQueuedRun({
        runId: "run-restored-stop-two",
        groupId: "restore-stop",
        createdAt: now + 1,
      }),
    ]);
    mocks.entries = {
      "agent:main:subagent:run-restored-stop-one": {
        sessionId: "one",
        lifecycleRevision: "revision-one",
        updatedAt: now,
      },
      "agent:main:subagent:run-restored-stop-two": { sessionId: "two", updatedAt: now },
    };
    mocks.persistSubagentRunsToDiskOrThrow.mockImplementationOnce(() => {
      throw new Error("sqlite unavailable after Gateway acceptance");
    });
    let agentCalls = 0;
    const dispatchedSessionKeys: unknown[] = [];
    const launchEntered = createDeferred();
    const releaseLaunch = createDeferred();
    let releaseAbort: (() => void) | undefined;
    const deleteReleases: Array<() => void> = [];
    let deletionPublicationFailed = false;
    mocks.callGateway.mockImplementation(async (request) => {
      if (request.method === "agent") {
        agentCalls += 1;
        dispatchedSessionKeys.push(request.params?.sessionKey);
        if (agentCalls === 1) {
          launchEntered.resolve();
          await releaseLaunch.promise;
        }
        return { runId: `gateway-restored-${agentCalls}` };
      }
      if (request.method === "chat.abort") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          releaseAbort = () => resolve({});
        });
      }
      if (request.method === "sessions.delete") {
        return await new Promise<Record<string, unknown>>((resolve) => {
          deleteReleases.push(() => resolve({}));
        });
      }
      return request.method === "agent.wait" ? { status: "pending" } : {};
    });

    hydrateAndActivateRegistry();
    await launchEntered.promise;
    const memory = await import("./subagent-registry-memory.js");
    const entry = expectDefined(memory.subagentRuns.get("run-restored-stop-one"), "restored run");
    const publication = memory.subagentRuns.captureRetirement(
      entry,
      (current) => current === entry,
    );
    const overlap = memory.subagentRuns.captureRetirement(entry, (current) => current === entry);
    const cleanupWaiting = createDeferred();
    const waitForPublication = memory.waitForSubagentRetirementPublication;
    const publicationWait = vi
      .spyOn(memory, "waitForSubagentRetirementPublication")
      .mockImplementation((current) => {
        const pending = waitForPublication(current);
        if (current === entry && pending) {
          cleanupWaiting.resolve();
        }
        return pending;
      });
    try {
      releaseLaunch.resolve();
      await cleanupWaiting.promise;
      expect(releaseAbort).toBeUndefined();
      expect(deleteReleases).toEqual([]);
      expect(agentCalls).toBe(1);
      publication.completePublication();
      expect(memory.hasPendingSubagentRetirementPublication(entry)).toBe(true);
      expect(releaseAbort).toBeUndefined();
      overlap.completePublication();
    } finally {
      releaseLaunch.resolve();
      publication.release();
      overlap.release();
      publicationWait.mockRestore();
    }
    await waitForFast(() => expect(releaseAbort).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);

    releaseAbort?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(1));
    expect(agentCalls).toBe(1);
    await waitForFast(() =>
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.delete",
          params: expect.objectContaining({
            key: "agent:main:subagent:run-restored-stop-one",
            expectedSessionId: "one",
            expectedLifecycleRevision: "revision-one",
          }),
        }),
      ),
    );
    deleteReleases[0]?.();
    await waitForFast(() => expect(deleteReleases).toHaveLength(2));
    expect(agentCalls).toBe(1);
    mocks.emitSessionLifecycleEvent.mockImplementationOnce(({ reason }: { reason: string }) => {
      expect(reason).toBe("delete");
      deletionPublicationFailed = true;
      throw new Error("restored deletion publication failed");
    });
    deleteReleases[1]?.();
    await waitForFast(() => expect(agentCalls).toBe(2));
    expect(deletionPublicationFailed).toBe(true);
    expect(dispatchedSessionKeys).toEqual([
      "agent:main:subagent:run-restored-stop-one",
      "agent:main:subagent:run-restored-stop-two",
    ]);
    expect(
      mocks.callGateway.mock.calls.filter(([request]) => request.method === "chat.abort"),
    ).toHaveLength(1);
  });
}
