import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CompactResult, ContextEngine } from "../context-engine/types.js";
import {
  compactContextEngineWithSafetyTimeout as compactEngine,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./embedded-agent-runner/compaction-safety-timeout.js";

type CompactFn = ContextEngine["compact"];
const baseParams: Parameters<CompactFn>[0] = {
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
};
const result: CompactResult = { ok: true, compacted: true };
function startCompaction(acceptedHostParams?: string[], abortSignal?: AbortSignal) {
  const completion = createDeferred<CompactResult>();
  const compact = vi.fn<CompactFn>(() => completion.promise);
  const engine = {
    compact,
    info: { id: "test", name: "Test", ownsCompaction: false, acceptedHostParams },
  };
  const pending = compactEngine(engine, baseParams, 30, abortSignal);
  return { completion, compact, pending, params: () => compact.mock.calls[0]?.[0] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  const timers = vi.getTimerCount();
  vi.clearAllTimers();
  vi.useRealTimers();
  expect(timers).toBe(0);
});

it.each([
  { acceptedHostParams: ["onProgress"], reporting: true },
  { acceptedHostParams: [], reporting: false },
  { acceptedHostParams: undefined, reporting: false },
])("keeps progress opt-in for $acceptedHostParams", async ({ acceptedHostParams, reporting }) => {
  const { completion, pending, params } = startCompaction(acceptedHostParams);
  if (reporting) {
    expect(params()?.onProgress).toBeTypeOf("function");
  } else {
    expect(params()).not.toHaveProperty("onProgress");
  }
  const assertion = reporting
    ? expect(pending).resolves.toBe(result)
    : expect(pending).rejects.toThrow("Compaction timed out");

  for (let tick = 0; tick < 2; tick++) {
    await vi.advanceTimersByTimeAsync(20);
    params()?.onProgress?.();
  }
  await vi.advanceTimersByTimeAsync(20);
  completion.resolve(result);
  await assertion;
});

it("bounds reporting plugins at the existing overall ceiling", async () => {
  const { pending, params } = startCompaction(["onProgress"]);
  const signal = params()?.abortSignal;
  const assertion = expect(pending).rejects.toThrow("Compaction timed out");
  for (let elapsed = 0; elapsed < 280; elapsed += 20) {
    await vi.advanceTimersByTimeAsync(20);
    params()?.onProgress?.();
  }
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  await assertion;
  expect(signal?.aborted).toBe(true);
  params()?.onProgress?.();
});

it("retains the default timeout when cancellation cleanup throws", async () => {
  const onCancel = vi.fn(() => {
    throw new Error("abortCompaction failed");
  });
  const pending = compactWithSafetyTimeout(() => new Promise<never>(() => {}), undefined, {
    onCancel,
  });
  const assertion = expect(pending).rejects.toThrow("Compaction timed out");
  await vi.advanceTimersByTimeAsync(180_000);
  await assertion;
  expect(onCancel).toHaveBeenCalledOnce();
});

it.each([
  { seconds: undefined, expected: 180_000 },
  { seconds: 1800.7, expected: 1_800_000 },
])("resolves configured timeout seconds $seconds", ({ seconds, expected }) => {
  expect(
    resolveCompactionTimeoutMs(
      seconds === undefined
        ? undefined
        : { agents: { defaults: { compaction: { timeoutSeconds: seconds } } } },
    ),
  ).toBe(expected);
});

it("does not start an engine after caller cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("run aborted before compaction");
  controller.abort(reason);
  const { compact, pending } = startCompaction(undefined, controller.signal);
  await expect(pending).rejects.toBe(reason);
  expect(compact).not.toHaveBeenCalled();
});

it.each(["caller", "timeout"] as const)(
  "threads %s cancellation into the plugin compactor",
  async (source) => {
    const controller = new AbortController();
    const reason = new Error("run aborted");
    const { compact, pending, params } = startCompaction(
      undefined,
      source === "caller" ? controller.signal : undefined,
    );
    const signal = params()?.abortSignal;
    const assertion =
      source === "caller"
        ? expect(pending).rejects.toBe(reason)
        : expect(pending).rejects.toThrow("Compaction timed out");
    expect(compact).toHaveBeenCalledOnce();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    if (source === "caller") {
      controller.abort(reason);
    } else {
      await vi.advanceTimersByTimeAsync(30);
    }
    await assertion;
    expect(signal?.aborted).toBe(true);
    if (source === "caller") {
      expect(signal?.reason).toBe(reason);
    } else {
      expect(signal?.reason).toEqual(new Error("Compaction timed out"));
    }
  },
);
