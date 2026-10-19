import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalSseEvent } from "./client-adapter.js";
import { startSignalIngressMonitor } from "./signal-ingress.js";

type SignalIngressQueue = NonNullable<Parameters<typeof startSignalIngressMonitor>[0]["queue"]>;
type SignalIngressPayload = Parameters<SignalIngressQueue["enqueue"]>[1];
type SignalIngressDispatch = Parameters<typeof startSignalIngressMonitor>[0]["dispatch"];

function signalEvent(params?: {
  senderNumber?: string;
  senderUuid?: string;
  timestamp?: number;
  groupId?: string;
  message?: string;
}): SignalSseEvent {
  const timestamp = params?.timestamp ?? 1_700_000_000_001;
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: params?.senderNumber ?? "+15550001111",
        ...(params?.senderUuid ? { sourceUuid: params.senderUuid } : {}),
        timestamp,
        dataMessage: {
          timestamp,
          message: params?.message ?? "hello",
          ...(params?.groupId ? { groupInfo: { groupId: params.groupId } } : {}),
        },
      },
    }),
  };
}

type Monitor = Awaited<ReturnType<typeof startSignalIngressMonitor>>;
let stateDir: string;
let queue: SignalIngressQueue;
const monitors = new Set<Monitor>();

beforeEach(async () => {
  stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-signal-ingress-")),
  );
  queue = createChannelIngressQueueForTests<SignalIngressPayload>({
    channelId: "signal",
    accountId: "default",
    stateDir,
  });
});
afterEach(async () => {
  try {
    for (const monitor of monitors) {
      await monitor.stop();
    }
  } finally {
    monitors.clear();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
async function start(dispatch: SignalIngressDispatch, target = queue) {
  const monitor = await startSignalIngressMonitor({
    accountId: "default",
    queue: target,
    dispatch,
    runtime: { error: vi.fn(), log: vi.fn() },
  });
  monitors.add(monitor);
  return monitor;
}

describe("Signal durable ingress", () => {
  it("propagates durable append failure before dispatch scheduling", async () => {
    const appendError = new Error("sqlite unavailable");
    // An idle monitor admits a fresh singleton through the fused append-and-claim.
    const failingQueue = {
      ...queue,
      enqueue: vi.fn().mockRejectedValue(appendError),
      enqueueAndClaim: vi.fn().mockRejectedValue(appendError),
    } satisfies SignalIngressQueue;
    const dispatch = vi.fn();
    const monitor = await start(dispatch, failingQueue);
    await expect(monitor.receive(signalEvent())).rejects.toBe(appendError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("recovers an uncompleted append with a fresh drain and dispatches exactly once", async () => {
    const event = signalEvent();
    const interruptedDispatch = vi.fn((_event, lifecycle) => {
      lifecycle.onDeferred();
      return { kind: "deferred" } as const;
    });
    const interrupted = await start(interruptedDispatch);
    await interrupted.receive(event);
    await interrupted.waitForIdle();
    expect(await queue.listClaims()).toHaveLength(1);
    await interrupted.stop();
    monitors.delete(interrupted);

    const recoveredDispatch = vi.fn().mockResolvedValue(undefined);
    const recovered = await start(recoveredDispatch);
    await recovered.waitForIdle();
    expect(recoveredDispatch).toHaveBeenCalledTimes(1);
    const [recoveredEvent, recoveredLifecycle] = recoveredDispatch.mock.calls[0] ?? [];
    expect(recoveredEvent).toEqual(event);
    expect(recoveredLifecycle).toEqual(expect.any(Object));
  });

  it("completes only when deferred dispatch adoption becomes durable", async () => {
    const event = signalEvent();
    let adopt: (() => void | Promise<void>) | undefined;
    const dispatch = vi.fn((_event, lifecycle) => {
      adopt = lifecycle.onAdopted;
      lifecycle.onDeferred();
      return { kind: "deferred" } as const;
    });
    const started = await start(dispatch);
    await started.receive(event);
    await started.waitForIdle();
    expect(await queue.listClaims()).toHaveLength(1);
    await started.receive(event);
    await started.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(adopt).toBeDefined();
    await adopt?.();
    await started.receive(event);
    await started.waitForIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dead-letters malformed persisted payloads without retry", async () => {
    await queue.enqueue(
      "malformed-event",
      {
        version: 1,
        receivedAt: 1,
        event: { event: "receive", data: "{" },
      },
      { receivedAt: 1, laneKey: "direct:number:+15550001111" },
    );
    const dispatch = vi.fn();
    const started = await start(dispatch);
    await started.waitForIdle();
    expect((await queue.enqueue("malformed-event", {} as SignalIngressPayload)).kind).toBe(
      "failed",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps a pending dual-identity message dispatchable through redelivery", async () => {
    const sender = {
      senderNumber: "+15550002222",
      senderUuid: "123e4567-e89b-12d3-a456-426614174000",
    };
    const first = signalEvent({ ...sender, timestamp: 1_700_000_000_001, message: "first" });
    const second = signalEvent({ ...sender, timestamp: 1_700_000_000_002, message: "second" });
    let adoptFirst: (() => void | Promise<void>) | undefined;
    const dispatch = vi.fn<SignalIngressDispatch>((_event, lifecycle, payload) => {
      if (payload.envelope?.dataMessage?.message === "first") {
        adoptFirst = lifecycle.onAdopted;
        lifecycle.onDeferred();
        return { kind: "deferred" } as const;
      }
      return undefined;
    });
    const started = await start(dispatch);
    await started.receive(first);
    await started.receive(second);
    await started.waitForIdle();
    expect(await queue.listPending()).toHaveLength(1);
    await started.receive(second);
    await started.waitForIdle();
    expect(await queue.listPending()).toHaveLength(1);
    await adoptFirst?.();
    await started.waitForIdle();
    expect(dispatch.mock.calls.map((call) => call[2].envelope?.dataMessage?.message)).toEqual([
      "first",
      "second",
    ]);
  });

  it("uses a direct-sender or group-conversation lane and stores the raw event", async () => {
    const direct = signalEvent({ senderUuid: "123e4567-e89b-12d3-a456-426614174000" });
    const group = signalEvent({ groupId: "group-123", timestamp: 1_700_000_000_002 });
    const dispatch = vi.fn((_event, lifecycle) => {
      lifecycle.onDeferred();
      return { kind: "deferred" } as const;
    });
    const started = await start(dispatch);
    await started.receive(direct);
    await started.receive(group);
    await started.waitForIdle();
    expect(await queue.listClaims()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          laneKey: "direct:uuid:123e4567-e89b-12d3-a456-426614174000",
          payload: expect.objectContaining({ event: direct }),
        }),
        expect.objectContaining({
          laneKey: "group:group-123",
          payload: expect.objectContaining({ event: group }),
        }),
      ]),
    );
  });

  it.each([
    ["sync", { envelope: { sourceNumber: "+15550001111", timestamp: 1, syncMessage: {} } }],
    ["receipt", { envelope: { sourceNumber: "+15550001111", timestamp: 2, receiptMessage: {} } }],
  ])("does not journal %s envelopes", async (_label, payload) => {
    const dispatch = vi.fn();
    const started = await start(dispatch);
    await started.receive({ event: "receive", data: JSON.stringify(payload) });
    await started.waitForIdle();
    await expect(queue.listPending({ limit: "all" })).resolves.toHaveLength(0);
    await expect(queue.listClaims()).resolves.toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
