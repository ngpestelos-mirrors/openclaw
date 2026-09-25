/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "./gateway-socket.test-support.ts";
import { GatewayBrowserClient } from "./gateway.ts";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";

describe("GatewayBrowserClient chat delivery", () => {
  beforeEach(() => {
    useNodeFakeTimers();
    wsInstances.length = 0;
    stubWindowGlobals();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconstructs chat once before delivering to existing and newly attached listeners", () => {
    const onEvent = vi.fn();
    const firstPane = vi.fn();
    const secondPane = vi.fn();
    const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL, onEvent });
    const canvas = { type: "canvas", url: "/__openclaw__/canvas/demo.html" };
    const snapshot = {
      role: "assistant",
      timestamp: 123,
      content: [{ type: "text", text: "Hello" }, canvas],
    };
    const payload = { sessionKey: "agent:main:chat", runId: "run-1", state: "delta" };
    try {
      client.addEventListener(firstPane);
      client.start();
      const ws = getLatestWebSocket();
      ws.emitMessage({ type: "event", event: "chat", payload: { ...payload, message: snapshot } });
      const firstEvent = firstPane.mock.calls[0]?.[0];
      client.addEventListener(secondPane);
      ws.emitMessage({
        type: "event",
        event: "chat",
        payload: { ...payload, deltaText: " world\n " },
      });

      const complete = {
        ...payload,
        deltaText: " world\n ",
        message: { ...snapshot, content: [{ type: "text", text: "Hello world\n " }, canvas] },
      };
      expect(secondPane).toHaveBeenCalledExactlyOnceWith({
        type: "event",
        event: "chat",
        payload: complete,
      });
      expect(firstPane.mock.lastCall?.[0]).toBe(secondPane.mock.lastCall?.[0]);
      expect(onEvent.mock.lastCall?.[0]).toBe(secondPane.mock.lastCall?.[0]);
      expect(firstEvent.payload.message).toEqual(snapshot);

      ws.emitMessage({
        type: "event",
        event: "chat",
        payload: { ...payload, deltaText: "", replace: true },
      });
      expect(secondPane.mock.lastCall?.[0].payload.message).toEqual({
        ...snapshot,
        content: [{ type: "text", text: "" }, canvas],
      });
      ws.emitMessage({
        type: "event",
        event: "chat",
        payload: { ...payload, deltaText: "New answer" },
      });
      expect(secondPane.mock.lastCall?.[0].payload.message).toEqual({
        ...snapshot,
        content: [{ type: "text", text: "New answer" }, canvas],
      });
    } finally {
      client.stop();
    }
  });

  it.each(["final", "error", "aborted", "disconnect", "unsubscribe"] as const)(
    "retires the chat baseline on %s and recovers an orphan append",
    async (boundary) => {
      const onEvent = vi.fn();
      const listener = vi.fn();
      const client = new GatewayBrowserClient({ url: DEFAULT_GATEWAY_URL, onEvent });
      const payload = { sessionKey: "agent:main:chat", runId: "run-1", state: "delta" };
      try {
        client.addEventListener(listener);
        client.start();
        let ws = getLatestWebSocket();
        ws.emitMessage({
          type: "event",
          event: "chat",
          payload: { ...payload, message: { role: "assistant", content: "Before" } },
        });
        if (boundary === "disconnect") {
          ws.emitClose(1006, "socket lost");
          await vi.advanceTimersByTimeAsync(800);
          ws = getLatestWebSocket();
        } else if (boundary === "unsubscribe") {
          const unsubscribe = client.request("sessions.messages.unsubscribe", {
            key: payload.sessionKey,
          });
          const request = JSON.parse(ws.sent.at(-1) ?? "{}");
          ws.emitMessage({
            type: "res",
            id: request.id,
            ok: true,
            payload: { subscribed: false, key: payload.sessionKey },
          });
          await unsubscribe;
        } else {
          ws.emitMessage({
            type: "event",
            event: "chat",
            payload: { ...payload, state: boundary },
          });
          expect(onEvent.mock.lastCall?.[0].payload.state).toBe(boundary);
        }
        onEvent.mockClear();
        listener.mockClear();
        ws.emitMessage({
          type: "event",
          event: "chat",
          payload: { ...payload, deltaText: "suffix" },
        });
        expect(onEvent).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(ws.lastClose).toEqual({ code: 4000, reason: "chat stream baseline missing" });
      } finally {
        client.stop();
      }
    },
  );
});
