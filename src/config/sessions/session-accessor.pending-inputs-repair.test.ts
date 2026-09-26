import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import * as pendingInputRuntime from "./session-accessor.pending-inputs.runtime.js";
import { usePendingInputFixture } from "./session-pending-inputs-test-helpers.js";

describe("pending input repair admission", () => {
  const { scope, message, stage, promote } = usePendingInputFixture("pending-input-repair-");
  it("retains prepared custody through lifecycle retirement before allowing a retry", async () => {
    const requestFingerprint = "rotation-after-read";
    const previous = await stage("read-rotation", { requestFingerprint });
    const read = pendingInputRuntime.withSessionPendingInputDatabase;
    const rotateAfterRead: typeof read = (resolved, assertCurrent, run, captured) =>
      read(
        resolved,
        assertCurrent,
        (access) => {
          const preparing = run(access);
          rotateAgentEventLifecycleGeneration();
          return preparing;
        },
        captured,
      );
    vi.spyOn(pendingInputRuntime, "withSessionPendingInputDatabase").mockImplementationOnce(
      rotateAfterRead,
    );
    await expect(
      stageSessionPendingInput(scope(), {
        runId: "read-rotation",
        message: message("read-rotation"),
        requestFingerprint,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("already admitted");
    await previous.finish("interrupted");
    const current = await stage("read-rotation", { requestFingerprint });
    expect(current.run(() => "recovered input")).toBe("recovered input");
  });

  it("skips a stale read repair after staging publishes its live owner", async () => {
    const committed = createDeferred<void>();
    const publish = createDeferred<void>();
    const repairing = createDeferred<void>();
    const accessDatabase = pendingInputRuntime.withSessionPendingInputDatabase;
    const holdPublication: typeof accessDatabase = (resolved, assertCurrent, run, captured) =>
      accessDatabase(
        resolved,
        assertCurrent,
        (access) =>
          run({
            ...access,
            stage: async (request) => {
              const accepted = await access.stage(request);
              committed.resolve();
              await publish.promise;
              return accepted;
            },
          }),
        captured,
      );
    vi.spyOn(pendingInputRuntime, "withSessionPendingInputDatabase").mockImplementationOnce(
      holdPublication,
    );
    const repair = pendingInputRuntime.repairSessionPendingInputRows;
    vi.spyOn(pendingInputRuntime, "repairSessionPendingInputRows").mockImplementationOnce(
      (...args) => {
        repairing.resolve();
        return repair(...args);
      },
    );
    const staging = stage("publishing-owner");
    await committed.promise;
    const listing = listSessionPendingInputs(scope());
    try {
      await repairing.promise;
    } finally {
      publish.resolve();
    }
    const receipt = await staging;
    await expect(listing).resolves.toMatchObject({
      items: [{ id: receipt.inputId, state: "queued" }],
    });
    expect(await promote(receipt)).toMatchObject({ appended: true, messageId: receipt.inputId });
  });

  it("does not interrupt custody when the selected session becomes current during a pending read", async () => {
    const receipt = await stage("reactivated");
    await upsertSessionEntryCore(scope(), { sessionId: "replacement-session", updatedAt: 2 });
    const repair = pendingInputRuntime.repairSessionPendingInputRows;
    vi.spyOn(pendingInputRuntime, "repairSessionPendingInputRows").mockImplementationOnce(
      async (...args) => {
        await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 3 });
        return repair(...args);
      },
    );
    expect(await listSessionPendingInputs(scope())).toMatchObject({
      items: [{ id: receipt.inputId, state: "queued" }],
    });
    expect(await promote(receipt)).toMatchObject({ appended: true, messageId: receipt.inputId });
  });
});
