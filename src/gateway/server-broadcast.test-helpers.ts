import { vi } from "vitest";
import { WebSocket } from "ws";
import type { GatewayWsClient } from "./server/ws-types.js";

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  events: string[];
  frames: Array<{ event: string; seq: number }>;
};

export function makeClient(
  connId: string,
  role: "node" | "operator" = "operator",
  scopes: string[] = ["operator.read"],
): { client: GatewayWsClient; socket: RecordingSocket } {
  const events: string[] = [];
  const frames: Array<{ event: string; seq: number }> = [];
  const socket: RecordingSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload) as { event: string; seq: number };
      events.push(frame.event);
      frames.push({ event: frame.event, seq: frame.seq });
    }),
    events,
    frames,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role, scopes } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}
