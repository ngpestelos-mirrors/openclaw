// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showToast } from "../lib/toast.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture as updateRunFixture } from "../test-helpers/update-run.ts";
import { flushMicrotasks, type RequestFn } from "./overlays-access.test-support.ts";
import { disposeTestOverlays, runTest } from "./overlays-update.test-support.ts";

vi.mock("../lib/toast.ts", () => ({ showToast: vi.fn() }));

const calls = (request: ReturnType<typeof acceptedRun>, method: string) =>
  request.mock.calls.filter(([name]) => name === method);
const acceptedRun = (getRun: () => ReturnType<typeof updateRunFixture>, status = () => ({})) =>
  vi.fn<RequestFn>(async (method) => {
    const run = getRun();
    return method === "update.run"
      ? { ok: true, runId: run.runId }
      : method === "update.runs.get"
        ? { run }
        : method === "update.status"
          ? status()
          : {};
  });
const finishedRun = (patch: Parameters<typeof updateRunFixture>[0]) =>
  updateRunFixture({
    ...patch,
    phase: "finished",
    status: "succeeded",
    after: { version: "2.0.0" },
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(async () => {
  await disposeTestOverlays();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads an accepted run and follows events through restart to a visible success row", async () => {
  let run = updateRunFixture();
  const request = acceptedRun(
    () => run,
    () => (run.status === "succeeded" ? { updateAvailable: null } : {}),
  );
  const { harness, overlays } = runTest(request);
  await flushMicrotasks();
  await overlays.runUpdate();
  expect(request).toHaveBeenCalledWith("update.runs.get", { runId: run.runId });
  expect(overlays.snapshot.updateRun).toEqual(run);
  expect(overlays.snapshot.updateRunning || overlays.snapshot.updateReconciliationPending).toBe(
    true,
  );

  for (const phase of ["activating", "restarting"] as const) {
    run = updateRunFixture({ phase, updatedAtMs: run.updatedAtMs + 1 });
    harness.emitEvent("update.run.changed", run);
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun?.phase).toBe(phase);
  }
  const hello = harness.gateway.snapshot.hello;
  harness.update({ phase: "reconnecting", hello: null });
  await vi.advanceTimersByTimeAsync(40 * 60_000);
  expect(overlays.snapshot.updateRun?.phase).toBe("restarting");
  expect(overlays.snapshot.updateReconciliationPending || overlays.snapshot.updateRunning).toBe(
    true,
  );
  expect(overlays.snapshot.recordedUpdateAttempt).toBeNull();

  run = { ...run, phase: "verifying", updatedAtMs: run.updatedAtMs + 1 };
  harness.update({ phase: "connected", hello });
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun?.phase).toBe("verifying");
  run = finishedRun({
    ...run,
    updatedAtMs: run.updatedAtMs + 1,
    finishedAtMs: Date.now(),
    verification: { serviceRunning: true, versionMatch: true, channelsReady: true },
  });
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun).toEqual(run);
  expect(overlays.snapshot).toMatchObject({
    updateRunning: false,
    updateReconciliationPending: false,
    updateStatusBanner: null,
    updateAvailable: null,
  });
  expect(showToast).not.toHaveBeenCalled();
  expect(calls(request, "update.run")).toHaveLength(1);
  expect(sessionStorage.length).toBe(0);
});

it("does not fetch an unchanged event, but fetches changed step details in the same phase", async () => {
  let run = updateRunFixture();
  const request = vi.fn<RequestFn>(async (method) =>
    method === "update.runs.get" ? { run } : { activeRun: run },
  );
  const { harness, overlays } = runTest(request);
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun).toEqual(run);
  harness.emitEvent("update.run.changed", run);
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(calls(request, "update.runs.get")).toHaveLength(0);
  run = {
    ...run,
    updatedAtMs: run.updatedAtMs + 1,
    steps: [
      ...run.steps,
      { step: "download", status: "in_progress", detail: "Downloading package" },
    ],
  };
  harness.emitEvent("update.run.changed", run);
  await flushMicrotasks();
  expect(calls(request, "update.runs.get")).toHaveLength(1);
  expect(overlays.snapshot.updateRun?.steps.at(-1)?.detail).toBe("Downloading package");
});

it.each(["activeRun", "lastRun"] as const)(
  "discovers %s after a document reload without browser run storage",
  async (field) => {
    const run = field === "lastRun" ? finishedRun({ finishedAtMs: 5_000 }) : updateRunFixture();
    const request = vi.fn<RequestFn>(async (method) =>
      method === "update.status" ? { [field]: run } : {},
    );
    const fixture = runTest(request);
    let overlays = fixture.overlays;
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    overlays = fixture.remount();
    await flushMicrotasks();
    expect(overlays.snapshot.updateRun).toEqual(run);
    expect(calls(request, "update.status")).toHaveLength(2);
    expect(calls(request, "update.run")).toHaveLength(0);
    expect(sessionStorage.length).toBe(0);
  },
);

it("keeps a known run on reconnect even when status retains another attempt", async () => {
  let run = updateRunFixture();
  const request = acceptedRun(() => run);
  const { harness, overlays } = runTest(request);
  await overlays.runUpdate();
  const statusReads = calls(request, "update.status").length;
  harness.update({ phase: "reconnecting" });
  run = { ...run, phase: "verifying", updatedAtMs: 3_000 };
  harness.update({ phase: "connected" });
  await flushMicrotasks();
  expect(overlays.snapshot.updateRun).toEqual(run);
  expect(calls(request, "update.status")).toHaveLength(statusReads);
  expect(calls(request, "update.runs.get")).toHaveLength(2);
});
