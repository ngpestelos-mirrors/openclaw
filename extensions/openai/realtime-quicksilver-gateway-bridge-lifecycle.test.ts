import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { delegation, turn } from "./realtime-quicksilver-events.test-support.js";
import {
  createGatewayHarness,
  type GatewayConfig,
} from "./realtime-quicksilver-gateway.test-support.js";
import { emitSideband, parseSent } from "./realtime-quicksilver.test-helpers.js";

function createBridge(params: Partial<GatewayConfig>) {
  const fetchImpl = vi.fn<NonNullable<GatewayConfig["fetchImpl"]>>();
  const createPeer = vi.fn<NonNullable<GatewayConfig["createPeer"]>>();
  const harness = createGatewayHarness({
    model: "gpt-live-test",
    ...params,
    createPeer,
    fetchImpl,
    startSession: { expires_at: Math.floor(Date.now() / 1000) + 60 },
  });
  onTestFinished(() => harness.bridge.close());
  return { ...harness, createPeer, fetchImpl };
}
const eventsOf = (socket: Parameters<typeof parseSent>[0], type: string) =>
  parseSent(socket).filter((event) => event.type === type);

describe("OpenAI Quicksilver gateway bridge lifecycle", () => {
  it("reports recoverable provider errors to the relay while preserving its connection", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const harness = createBridge({
      onError,
      onTranscript,
    });
    await harness.bridge.connect();
    const socket = harness.getSocket();
    emitSideband(socket, { type: "error", error: { message: "temporary voice failure" } });
    emitSideband(socket, turn("assistant", "Recovered"));
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "OpenAI GPT-Live provider error" }),
    );
    expect(onTranscript).toHaveBeenCalledWith("assistant", "Recovered", true);
    expect(harness.bridge.isConnected()).toBe(true);
  });

  it.each([
    { disposition: undefined, classified: false },
    { disposition: "detach", classified: false },
    { disposition: "detach", classified: true },
  ] as const)(
    "settles accepted delegation on close ($disposition, classified=$classified)",
    async ({ disposition, classified }) => {
      let consultSignal: AbortSignal | undefined;
      const { promise: consultResult, resolve: resolveConsult } = createDeferred<{
        text: string;
      }>();
      const runAgentConsult = vi.fn(
        async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
          consultSignal = signal;
          signal?.addEventListener(
            "abort",
            () => resolveConsult({ text: "must not be delivered" }),
            { once: true },
          );
          return await consultResult;
        },
      );
      const harness = createBridge({
        runAgentConsult,
        handleDelegationInput: classified ? () => "consult" : undefined,
      });

      try {
        await harness.bridge.connect();
        const socket = harness.getSocket();
        expect(parseSent(socket)[0]).toMatchObject({
          type: "session.update",
          session: { delegation: { type: "client", ack_filler: false } },
        });
        expect(harness.fetchImpl).not.toHaveBeenCalled();
        expect(harness.createPeer).not.toHaveBeenCalled();
        emitSideband(socket, delegation("delegation-detach", "Finish after disconnect"));
        await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
        expect(eventsOf(socket, "session.context.append")).toHaveLength(classified ? 1 : 0);

        await harness.bridge.close(disposition ? { disposition } : undefined);
        const sentAtClose = socket.sent.length;
        emitSideband(socket, delegation("late", "Do not acknowledge after detach"));
        expect(consultSignal?.aborted).toBe(disposition !== "detach");
        resolveConsult({ text: "finished after detach" });
        await nextEventLoopTurn();
        expect(eventsOf(socket, "delegation.context.append")).toEqual([]);
        expect(socket.sent).toHaveLength(sentAtClose);
        expect(runAgentConsult).toHaveBeenCalledOnce();
      } finally {
        resolveConsult({ text: "Finished" });
      }
    },
  );
});
