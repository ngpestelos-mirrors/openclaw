import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as existingWrites from "../state/openclaw-state-db-existing-write.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import type { UpdateRunWriteCommand } from "./update-run-mutation.types.js";
import {
  openUpdateRunWriter,
  recordUpdateRunMutationInWorker,
} from "./update-run-mutation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let options: { env: NodeJS.ProcessEnv };
let runId: string;
let blocker: DatabaseSync;
let writer: ReturnType<typeof openUpdateRunWriter>;
let elapsed: number;

beforeAll(async () => {
  const home = dirs.make("update-run-contention-");
  options = { env: { HOME: home, OPENCLAW_STATE_DIR: home } };
  createUpdateRun(
    { trigger: "cli", settlement: { reason: "fixture", detail: "fixture" } },
    options,
  );
  await closeOpenClawStateDatabaseAsync();
});

beforeEach(async () => {
  runId = createUpdateRun({ trigger: "cli" }, options).runId;
  await closeOpenClawStateDatabaseAsync();
  blocker = new DatabaseSync(resolveOpenClawStateSqlitePath(options.env));
  writer = openUpdateRunWriter(options);
  elapsed = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (blocker.isTransaction) {
    blocker.exec("ROLLBACK");
  }
  blocker.close();
  writer.close();
  await closeOpenClawStateDatabaseAsync();
});

// Keep SQLite's real competing writer, rollback, and commit boundaries. Only
// native busy waits and retry sleeps use a virtual clock, not seconds of CI time.
function holdWriter(untilMs: number, onRelease?: () => void) {
  blocker.exec("BEGIN IMMEDIATE");
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const advance = (ms: number) => {
    elapsed += ms;
    if (blocker.isTransaction && elapsed >= untilMs) {
      blocker.exec("COMMIT");
      onRelease?.();
    }
  };
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    writer.assertSettled();
    advance(timeout ?? 0);
    return "timed-out";
  });
  const attempt = <T>(write: () => T, budget = 5_000): T => {
    try {
      return write();
    } catch (error) {
      if (isSqliteLockError(error)) {
        writer.assertSettled();
        advance(budget);
      }
      throw error;
    }
  };
  const run = writer.run.bind(writer);
  vi.spyOn(writer, "run").mockImplementation((operation, current) =>
    attempt(() => run(operation, { ...current, busyTimeoutMs: 0 }), current.busyTimeoutMs),
  );
  const write = existingWrites.runExistingOpenClawStateWriteTransaction;
  vi.spyOn(existingWrites, "runExistingOpenClawStateWriteTransaction").mockImplementation(
    (operation, current, contract) => {
      const immediate = { ...current, busyTimeoutMs: 0 };
      return attempt(
        () => write(operation, immediate, { ...contract, busyTimeoutMs: 0 }),
        contract.busyTimeoutMs,
      );
    },
  );
}

function retentionCommand(requireNoRecovery?: true): UpdateRunWriteCommand {
  return {
    type: "updateRuns.recordStep",
    input: {
      runId,
      redactionFacts: captureUpdateRunRedactionFacts(options.env),
      requireNoRecovery,
      step: { step: "updater-runtime-retention", status: "completed" },
    },
  };
}

it("records retention after a writer outlasts five seconds without skipping recovery admission", () => {
  holdWriter(107_000);
  const assertCurrent = vi.fn();
  const result = recordUpdateRunMutationInWorker(
    retentionCommand(true),
    options,
    assertCurrent,
    writer,
  );
  expect(elapsed).toBeGreaterThanOrEqual(107_000);
  expect(elapsed).toBeLessThanOrEqual(120_000);
  expect(result).toMatchObject({ kind: "recorded", record: { runId } });
  expect(assertCurrent.mock.calls).toEqual([["transaction"], ["commit"]]);
  expect(getUpdateRun(runId, options)?.steps).toContainEqual({
    step: "updater-runtime-retention",
    status: "completed",
  });
});

it("skips contended bookkeeping without claiming a committed worker receipt", () => {
  holdWriter(6_000);
  expect(recordUpdateRunMutationInWorker(retentionCommand(), options, vi.fn(), writer)).toEqual({
    kind: "bookkeeping-skipped",
  });
  expect(elapsed).toBe(1_000);
  expect(blocker.isTransaction).toBe(true);
  expect(
    getUpdateRun(runId, options)?.steps.some((step) => step.step === "updater-runtime-retention"),
  ).toBe(false);
});

it("warns and continues synchronous bookkeeping, then records the required outcome after contention", () => {
  holdWriter(6_000);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    recordUpdateRunStep(runId, { step: "updater-runtime-retention", status: "completed" }, options),
  ).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("The update will continue"));
  expect(finishUpdateRun(runId, { status: "succeeded" }, options).status).toBe("succeeded");
  expect(elapsed).toBeGreaterThanOrEqual(6_000);
  expect(getUpdateRun(runId, options)?.status).toBe("succeeded");
});

it("does not advance a phase when recovery evidence cannot be committed within the budget", () => {
  holdWriter(Infinity);
  expect(() => recordUpdateRunPhase(runId, "activating", {}, options)).toThrow(
    /database is locked by another writer after 120000 ms.*retry `openclaw update`/,
  );
  expect(elapsed).toBe(120_000);
  expect(getUpdateRun(runId, options)?.phase).toBe("requested");
});

it.each(["finalize:predecessor-stop:fixture", "openclaw doctor", "package rollback"])(
  "retains recovery-critical %s receipts after a prolonged lock",
  (step) => {
    holdWriter(6_000);
    expect(
      recordUpdateRunStep(runId, { step, status: "completed" }, options)?.steps,
    ).toContainEqual({ step, status: "completed" });
    expect(elapsed).toBeGreaterThanOrEqual(6_000);
  },
);

it("rechecks live authority after contention and rolls back a revoked write", () => {
  let revoked = false;
  holdWriter(6_000, () => {
    revoked = true;
  });
  expect(() =>
    recordUpdateRunMutationInWorker(
      retentionCommand(true),
      options,
      () => {
        if (revoked) {
          throw new Error("update authority revoked");
        }
      },
      writer,
    ),
  ).toThrow("update authority revoked");
  expect(getUpdateRun(runId, options)?.steps).toHaveLength(1);
});

it("does not swallow a non-contention failure as bookkeeping", () => {
  expect(() =>
    recordUpdateRunStep(
      "missing-run",
      { step: "updater-runtime-retention", status: "completed" },
      options,
    ),
  ).toThrow("Unknown update run");
});
