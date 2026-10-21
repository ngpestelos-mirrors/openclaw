import { PassThrough, Writable } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import { MemoryWatchPolicy } from "../memory/watch-policy.js";
import { serveMemoryFiles } from "./memory-files-worker.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("../memory/watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const cleanup: Array<() => void | Promise<void>> = [];
function barrier() {
  const deferred = createDeferred<void>();
  cleanup.push(deferred.resolve);
  return deferred;
}
function start(output: Writable = new PassThrough()) {
  const input = new PassThrough();
  const worker = serveMemoryFiles({ workspace: state.workspaceDir, input, output, watch: true });
  const finished = vi.fn();
  void worker.then(finished, finished);
  cleanup.push(async () => {
    input.end();
    await worker.catch(() => {});
    output.destroy();
  });
  return { input, worker, finished };
}
function observeClose() {
  const closing = createDeferred<void>();
  const retired = createDeferred<void>();
  // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
  const original = MemoryFileWatcher.prototype.close;
  vi.spyOn(MemoryFileWatcher.prototype, "close").mockImplementation(function (
    this: MemoryFileWatcher,
  ) {
    closing.resolve();
    const pending = original.call(this);
    void pending.then(retired.resolve, retired.reject);
    return pending;
  });
  return { closing, retired };
}
const request =
  JSON.stringify({
    agentId: "main",
    settings: {
      extraPaths: [],
      multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
      sync: { watchDebounceMs: 10 },
    },
  }) + "\n";
beforeEach(async () => {
  observer.reset();
  state = await createOpenClawTestState({ label: "memory-files-watch" });
  vi.useFakeTimers();
});
afterEach(async () => {
  // Release barriers before joining workers, including when an assertion fails.
  for (const release of cleanup.splice(0)) {
    await release();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  await state.cleanup();
});

it("revokes remote admission while startup is awaiting filesystem discovery", async () => {
  const output = new PassThrough();
  const entered = createDeferred<void>();
  const resume = barrier();
  const { closing } = observeClose();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted owner.
  const original = MemoryWatchPolicy.prototype.observations;
  let admissionSignal: AbortSignal | undefined;
  vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementation(async function (
    this: MemoryWatchPolicy,
    signal,
  ) {
    const groups = await original.call(this, signal);
    admissionSignal = signal;
    entered.resolve();
    await resume.promise;
    return groups;
  });
  const { input, worker, finished } = start(output);
  input.write(request);
  await entered.promise;
  input.end();
  await closing.promise;
  expect(admissionSignal?.aborted).toBe(true);
  await Promise.resolve();
  expect(finished).not.toHaveBeenCalled();
  resume.resolve();
  await worker;
  expect(observer.watch).not.toHaveBeenCalled();
  expect(output.read()).toBeNull();
});

it.each(["input end", "output error"] as const)(
  "joins observation and backpressured stdout after %s",
  async (ending) => {
    const ready = createDeferred<void>();
    const written = createDeferred<void>();
    const physical = barrier();
    const { closing, retired } = observeClose();
    observer.created = () => ready.resolve();
    observer.closeBarrier = physical.promise;
    let blocked = true;
    let events = "";
    const callbacks: Array<(error?: Error | null) => void> = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        events += chunk.toString("utf8");
        written.resolve();
        if (blocked) {
          callbacks.push(callback);
        } else {
          callback();
        }
      },
    });
    const drain = () => {
      blocked = false;
      callbacks.splice(0).forEach((callback) => callback());
    };
    cleanup.push(drain);
    const { input, worker, finished } = start(output);
    input.write(request);
    await ready.promise;
    observer.observations[0]!.dirty();
    expect(events).toBe("");
    await vi.advanceTimersByTimeAsync(10);
    await written.promise;
    expect(events).toBe('"change"\n');
    expect(output.writableNeedDrain).toBe(true);
    const failure = new Error("Memory stdout failed");
    if (ending === "output error") {
      output.destroy(failure);
    } else {
      input.end();
    }
    await closing.promise;
    expect(finished).not.toHaveBeenCalled();
    physical.resolve();
    await retired.promise;
    if (ending === "input end") {
      expect(finished).not.toHaveBeenCalled();
      drain();
      await worker;
      expect(output.writableLength).toBe(0);
    } else {
      await expect(worker).rejects.toMatchObject({ errors: [failure] });
    }
    expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
  },
);
