import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop, type SignalStatusSink } from "./sse-reconnect.js";

function withRejectingServer(
  status: number,
  statusMessage: string,
  run: (baseUrl: string, requestCount: () => number) => Promise<void>,
  onRequest?: (requestCount: number) => void,
) {
  let requests = 0;
  return withServer(
    (_request, response) => {
      requests += 1;
      onRequest?.(requests);
      response.statusMessage = statusMessage;
      response.writeHead(status, { "content-type": "text/plain" });
      response.end("rejected\n");
    },
    (baseUrl) => run(baseUrl, () => requests),
  );
}

function runStream(
  baseUrl: string,
  abortSignal: AbortSignal,
  statusSink: SignalStatusSink,
  policy?: Parameters<typeof runSignalSseLoop>[0]["policy"],
) {
  return runSignalSseLoop({
    baseUrl,
    abortSignal,
    statusSink,
    policy,
    account: "+15555550100",
    runtime: createRuntimeSpies(),
    onEvent: vi.fn(),
  });
}

it("publishes one terminal status and stops after a permanent rejection", async () => {
  const abort = new AbortController();
  await withRejectingServer(
    400,
    "Account Selection Required",
    async (baseUrl, requestCount) => {
      const statusSink = vi.fn<SignalStatusSink>();
      await runStream(baseUrl, abort.signal, statusSink);
      expect(requestCount()).toBe(1);
      expect(statusSink).toHaveBeenCalledTimes(1);
      expect(statusSink).toHaveBeenCalledWith({
        lifecycle: "blocked",
        terminalDisconnect: true,
        connected: false,
        lastError:
          "Signal daemon rejected the event stream: Signal SSE failed (400 Account Selection Required). Check the configured account and daemon URL, fix the daemon or proxy response, then restart the channel.",
      });
    },
    (requestCount) => {
      if (requestCount === 2) {
        abort.abort();
      }
    },
  );
});

it("keeps reconnecting after a transient HTTP rejection", async () => {
  await withRejectingServer(503, "Try Again Later", async (baseUrl, requestCount) => {
    const abort = new AbortController();
    const statusSink = vi.fn<SignalStatusSink>(() => {
      if (requestCount() === 2) {
        abort.abort();
      }
    });
    await runStream(baseUrl, abort.signal, statusSink, {
      initialMs: 1,
      maxMs: 1,
      factor: 1,
      jitter: 0,
    });

    expect(requestCount()).toBe(2);
    const patches = statusSink.mock.calls.map(([patch]) => patch);
    expect(patches).toEqual([
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    ]);
    expect(patches).not.toContainEqual(expect.objectContaining({ terminalDisconnect: true }));
  });
});
