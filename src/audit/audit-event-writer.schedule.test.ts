import { expect, it, vi } from "vitest";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import { createAuditEventWriter } from "./audit-event-writer.js";

const worker = vi.hoisted(() => ({
  execute: vi.fn(async (_command: { type: string }) => ({ status: "settled" as const })),
}));

vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({}),
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: (
    _context: unknown,
    run: (scope: { execute: typeof worker.execute }) => unknown,
  ) => run(worker),
}));

it("runs hourly retention without new records and retires the schedule on stop", async () => {
  const hour = 60 * 60_000;
  const time = createGatewaySchedulerClock();
  const scheduler = new GatewayScheduler({ clock: time.clock });
  const writer = createAuditEventWriter({ scheduler, stateDir: "/synthetic/audit-state" });
  try {
    await writer.ready;
    worker.execute.mockClear();
    const pruning = createDeferredCore();
    worker.execute.mockImplementation(async (command) => {
      if (command.type === "audit.writer.prune") {
        pruning.resolve();
      }
      return { status: "settled" };
    });
    await time.advanceBy(hour - 1);
    expect(worker.execute).not.toHaveBeenCalled();
    await time.advanceBy(1);
    await pruning.promise;
    await writer.stop();
    const completedOperations = worker.execute.mock.calls.length;
    await time.advanceBy(hour);
    expect(worker.execute).toHaveBeenCalledTimes(completedOperations);
  } finally {
    await writer.stop();
    await scheduler.stop();
  }
});
