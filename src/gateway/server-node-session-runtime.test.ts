import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED } from "./events.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TestSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
};

function makeGatewayWsClient(connId: string, socket: TestSocket): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connId,
    usesSharedGatewayAuth: false,
    connect: {
      role: "node",
      scopes: [],
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "1.0.0",
        platform: "macos",
        mode: "node",
      },
      device: { id: "node-a" },
    } as unknown as GatewayWsClient["connect"],
  };
}

function createRuntime(
  resolveCurrentPairingGeneration: () => Promise<string>,
  broadcast = vi.fn(),
  isPairingStateCurrent: NonNullable<
    Parameters<typeof createGatewayNodeSessionRuntime>[0]["isPairingStateCurrent"]
  > = (_nodeId, expected) =>
    expected.identity === "identity-a" && expected.generation === "generation-a",
  onRunnerStateChanged?: Parameters<
    typeof createGatewayNodeSessionRuntime
  >[0]["onRunnerStateChanged"],
) {
  return createGatewayNodeSessionRuntime({
    broadcast,
    resolveCurrentPairingState: async () => ({
      identity: "identity-a",
      generation: await resolveCurrentPairingGeneration(),
    }),
    isPairingStateCurrent,
    onRunnerStateChanged,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
}

function registerNode(
  runtime: ReturnType<typeof createRuntime>,
  connId: string,
  pairingGeneration: string,
  frames: string[],
) {
  const socket: TestSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((payload: string) => frames.push(payload)),
    close: vi.fn(),
  };
  runtime.nodeRegistry.register(makeGatewayWsClient(connId, socket), {
    pairingIdentity: "identity-a",
    pairingGeneration,
  });
  return socket;
}

function liveTextPublisher(runtime: ReturnType<typeof createRuntime>, event: "chat" | "agent") {
  const group = new AbortController();
  return {
    group,
    send: (
      text: string,
      delta: string,
      boundary: { version?: unknown; snapshot?: boolean; isCurrent?: () => boolean } = {},
    ) => {
      const payload =
        event === "chat"
          ? {
              runId: "run-a",
              state: "delta",
              deltaText: delta,
              message: { role: "assistant", content: [{ type: "text", text }] },
            }
          : { runId: "run-a", stream: "assistant", data: { text, delta } };
      const deltaPayload =
        event === "chat"
          ? { runId: "run-a", state: "delta", deltaText: delta }
          : { runId: "run-a", stream: "assistant", data: { delta } };
      const opts: GatewayBroadcastOpts = {
        liveText: {
          group: group.signal,
          isCurrent: boundary.isCurrent,
          projection: {
            key: event,
            delta: () => deltaPayload,
            version: boundary.version,
            snapshot: boundary.snapshot,
          },
        },
      };
      return runtime.nodeSendToSession("main", event, payload, opts);
    },
  };
}

describe("gateway node session runtime", () => {
  test.each(["chat", "agent"] as const)(
    "%s snapshots attach, resubscribe, and changed projections while preserving append ordering",
    async (event) => {
      const frames: string[] = [];
      const runtime = createRuntime(async () => "generation-a");
      registerNode(runtime, "conn-original", "generation-a", frames);
      const publisher = liveTextPublisher(runtime, event);
      await publisher.send("before", "before");
      runtime.nodeSubscribe("node-a", "main", "conn-original");
      const first = publisher.send("before attach", " attach");
      const append = publisher.send("before attach append", " append");
      const tool = runtime.nodeSendToSession("main", "agent", { stream: "tool" });
      await Promise.all([first, append, tool]);
      runtime.nodeUnsubscribe("node-a", "main", "conn-original");
      runtime.nodeSubscribe("node-a", "main", "conn-original");
      await publisher.send("before attach append again", " again");
      await publisher.send("canvas changed", " changed", { version: "canvas-1" });
      await publisher.send("canvas changed more", " more", { version: "canvas-1" });
      await publisher.send("rewrite", "rewrite", { version: "canvas-1", snapshot: true });
      publisher.group.abort();
      await publisher.send("stale", "stale");
      await runtime.nodeSendToSession(
        "main",
        "chat",
        {
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "rewrite" }] },
        },
        { liveText: { group: publisher.group.signal } },
      );

      const payloads = frames.map((frame) => JSON.parse(frame).payload);
      const snapshot = (index: number) =>
        event === "chat" ? payloads[index].message?.content[0].text : payloads[index].data?.text;
      expect(payloads).toHaveLength(8);
      expect(snapshot(0)).toBe("before attach");
      expect(snapshot(1)).toBeUndefined();
      expect(event === "chat" ? payloads[1].deltaText : payloads[1].data.delta).toBe(" append");
      expect(payloads[2]).toEqual({ stream: "tool" });
      expect(snapshot(3)).toBe("before attach append again");
      expect(snapshot(4)).toBe("canvas changed");
      expect(snapshot(5)).toBeUndefined();
      expect(snapshot(6)).toBe("rewrite");
      expect(payloads[7]).toMatchObject({
        state: "final",
        message: { content: [{ text: "rewrite" }] },
      });
    },
  );

  test("re-baselines after a failed send or a skipped publication", async () => {
    const frames: string[] = [];
    const runtime = createRuntime(async () => "generation-a");
    const socket = registerNode(runtime, "conn-original", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const publisher = liveTextPublisher(runtime, "chat");
    await publisher.send("one", "one");
    vi.mocked(socket.send).mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    await publisher.send("one two", " two");
    await publisher.send("one two three", " three");
    await publisher.send("one two three four", " four", { isCurrent: () => false });
    await publisher.send("one two three four five", " five");

    expect(frames.map((frame) => JSON.parse(frame).payload.message.content[0].text)).toEqual([
      "one",
      "one two three",
      "one two three four five",
    ]);
  });

  test("does not inherit receipts when a connection is replaced during pairing verification", async () => {
    const entered = Promise.withResolvers<void>();
    const pairing = Promise.withResolvers<string>();
    let delayed = false;
    const runtime = createRuntime(() => {
      if (delayed) {
        entered.resolve();
        return pairing.promise;
      }
      return Promise.resolve("generation-a");
    });
    const originalFrames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", originalFrames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const publisher = liveTextPublisher(runtime, "chat");
    await publisher.send("one", "one");
    delayed = true;
    const pending = publisher.send("one two", " two");
    await entered.promise;
    const replacementFrames: string[] = [];
    registerNode(runtime, "conn-replacement", "generation-a", replacementFrames);
    pairing.resolve("generation-a");
    await pending;
    delayed = false;
    await publisher.send("one two three", " three");
    await publisher.send("one two three four", " four");

    expect(originalFrames).toHaveLength(1);
    expect(replacementFrames.map((frame) => JSON.parse(frame).payload)).toEqual([
      {
        runId: "run-a",
        state: "delta",
        deltaText: " three",
        message: { role: "assistant", content: [{ type: "text", text: "one two three" }] },
      },
      { runId: "run-a", state: "delta", deltaText: " four" },
    ]);
  });

  test("publishes pairing-generation transitions to lifecycle consumers", () => {
    const onPairingGenerationChanged = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast: vi.fn(),
      onPairingGenerationChanged,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    registerNode(runtime, "conn-original", "generation-a", []);
    registerNode(runtime, "conn-replacement", "generation-b", []);

    expect(onPairingGenerationChanged).toHaveBeenCalledWith({
      nodeId: "node-a",
      previousPairingGeneration: "generation-a",
      nextPairingGeneration: "generation-b",
      preserveSessionState: false,
    });
  });

  test("broadcasts and routes runner inventory changes from publication and replacement", () => {
    const order: string[] = [];
    const broadcast = vi.fn((event: string) => {
      order.push(`broadcast:${event}`);
    });
    const onRunnerStateChanged = vi.fn((_nodeId, change) => {
      if (change.availabilityChanged) {
        order.push("availability");
      }
      if (change.inventoryChanged) {
        order.push("inventory");
      }
    });
    const runtime = createRuntime(
      async () => "generation-a",
      broadcast,
      undefined,
      onRunnerStateChanged,
    );
    registerNode(runtime, "conn-original", "generation-a", []);

    expect(
      updateNodeRunnerInventory({
        registry: runtime.nodeRegistry,
        nodeId: "node-a",
        connId: "conn-original",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
        },
      }),
    ).toEqual({ changed: true });
    expect(broadcast).toHaveBeenNthCalledWith(
      1,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(true);
    expect(onRunnerStateChanged).toHaveBeenLastCalledWith("node-a", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
    expect(order).toEqual([
      "availability",
      "inventory",
      `broadcast:${GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED}`,
      "broadcast:sessions.changed",
    ]);

    registerNode(runtime, "conn-replacement", "generation-a", []);

    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(onRunnerStateChanged).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenNthCalledWith(
      3,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      4,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(false);
    expect(order.slice(4)).toEqual([
      "availability",
      "inventory",
      `broadcast:${GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED}`,
      "broadcast:sessions.changed",
    ]);
  });

  test("does not publish a session availability edge for a capacity-only update", () => {
    const broadcast = vi.fn();
    const onRunnerStateChanged = vi.fn();
    const runtime = createRuntime(
      async () => "generation-a",
      broadcast,
      undefined,
      onRunnerStateChanged,
    );
    registerNode(runtime, "conn-original", "generation-a", []);
    const publish = (available: number) =>
      updateNodeRunnerInventory({
        registry: runtime.nodeRegistry,
        nodeId: "node-a",
        connId: "conn-original",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available } },
        },
      });

    expect(publish(1)).toEqual({ changed: true });
    broadcast.mockClear();
    onRunnerStateChanged.mockClear();

    expect(publish(0)).toEqual({ changed: true });

    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(true);
    expect(onRunnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-a", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
  });

  test("forwards subscribed payload json without parsing it again", async () => {
    const frames: string[] = [];
    const runtime = createRuntime(async () => "generation-a");
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
    runtime.nodeSubscribe("node-a", "main", "conn-node-a");
    expect(runtime.nodeHasSessionSubscribers(" main ")).toBe(true);

    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      runtime.nodeSendToSession("main", "chat", { ok: true });
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
    }
    expect(JSON.parse(frames[0] ?? "{}")).toEqual({
      type: "event",
      event: "chat",
      payload: { ok: true },
    });

    runtime.nodeUnsubscribe("node-a", "main", "conn-retired");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    runtime.nodeUnsubscribe("node-a", "main", "conn-node-a");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
  });

  test("fences voice-wake updates by pairing generation while retaining operator broadcasts", async () => {
    let currentPairingGeneration = "generation-a";
    const resolveCurrentPairingGeneration = vi.fn(async () => currentPairingGeneration);
    const broadcast = vi.fn();
    const runtime = createRuntime(
      resolveCurrentPairingGeneration,
      broadcast,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");
    const routing = {
      version: 1 as const,
      defaultTarget: { mode: "current" as const },
      routes: [],
      updatedAtMs: 1,
    };

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    runtime.broadcastVoiceWakeRoutingChanged(routing);
    await vi.waitFor(() => expect(frames).toHaveLength(2));

    currentPairingGeneration = "generation-b";
    runtime.broadcastVoiceWakeChanged(["retired"]);
    runtime.broadcastVoiceWakeRoutingChanged({ ...routing, updatedAtMs: 2 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
      { type: "event", event: "voicewake.routing.changed", payload: { config: routing } },
    ]);
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  test("fences generation-less voice-wake updates by authenticated pairing identity", async () => {
    let pairingExists = true;
    const broadcast = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast,
      resolveCurrentPairingState: async () =>
        pairingExists ? { identity: "identity-a" } : undefined,
      isPairingStateCurrent: (_nodeId, expected) =>
        pairingExists && expected.identity === "identity-a",
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    const frames: string[] = [];
    const socket: TestSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((payload: string) => frames.push(payload)),
      close: vi.fn(),
    };
    const client = makeGatewayWsClient("conn-node-a", socket);
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-a" });
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    pairingExists = false;
    runtime.broadcastVoiceWakeChanged(["retired"]);
    await vi.waitFor(() => expect(client.invalidated).toBe(true));

    expect(send).not.toHaveBeenCalled();
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
    ]);
    expect(client.invalidated).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("does not inherit subscriptions across a replacement pairing generation", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(
      async () => currentPairingGeneration,
      undefined,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );

    const originalFrames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", originalFrames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    runtime.nodeSendToSession("main", "chat", { seq: 1 });
    await vi.waitFor(() => expect(originalFrames).toHaveLength(1));

    currentPairingGeneration = "generation-b";
    runtime.nodeSendToSession("main", "chat", { seq: 2 });
    await vi.waitFor(() => expect(runtime.nodeRegistry.get("node-a")).toBeUndefined());
    expect(originalFrames).toHaveLength(1);

    const replacementFrames: string[] = [];
    registerNode(runtime, "conn-replacement", "generation-b", replacementFrames);
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
    runtime.nodeSubscribe("node-a", "retired", "conn-original");
    expect(runtime.nodeHasSessionSubscribers("retired")).toBe(false);
    runtime.nodeSendToSession("retired", "chat", { seq: 3 });
    expect(replacementFrames).toHaveLength(0);

    runtime.nodeSubscribe("node-a", "main", "conn-replacement");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    runtime.nodeSendToSession("main", "chat", { seq: 4 });
    await vi.waitFor(() => expect(replacementFrames).toHaveLength(1));

    const reconnectFrames: string[] = [];
    registerNode(runtime, "conn-reconnect", "generation-b", reconnectFrames);
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    runtime.nodeSendToSession("main", "chat", { seq: 5 });
    await vi.waitFor(() => expect(reconnectFrames).toHaveLength(1));

    runtime.nodeUnsubscribeAll("node-a");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
  });

  test("preserves subscriptions for an exact live pairing generation promotion", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(
      async () => currentPairingGeneration,
      undefined,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-node-a");
    currentPairingGeneration = "generation-b";
    expect(
      runtime.nodeRegistry.updateSurface(
        "node-a",
        { commands: [] },
        {
          expectedConnId: "conn-node-a",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    runtime.nodeSendToSession("main", "chat", { ok: true });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
  });
});
