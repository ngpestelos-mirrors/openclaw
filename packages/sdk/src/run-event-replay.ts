import { mergeChatStreamMessage } from "@openclaw/gateway-client";
import {
  isTerminalRunEvent,
  projectAssistantRunEvent,
  readChatProjection,
  type AssistantProjection,
} from "./chat-projection.js";
import { EventHub } from "./event-hub.js";
import { normalizeGatewayEvent } from "./normalize.js";
import {
  matchesUnsubscribedSession,
  readUnsubscribedSession,
  type ReplaySessionScope,
} from "./replay-scope.js";
import {
  readGatewayEventConnectionEpoch,
  readGatewayEventReceipt,
  takeGatewayResponseReceipt,
  type GatewayEventReceipt,
} from "./transport.js";
import type { GatewayEvent, OpenClawEvent } from "./types.js";

const MAX_REPLAY_RUNS = 100;
const MAX_REPLAY_EVENTS_PER_RUN = 500;

/** Owns normalized event publication, retained run text, and delivery-lifetime retirement. */
export class SdkRunReplay {
  readonly events = new EventHub<OpenClawEvent>();
  private readonly replayByRunId = new Map<
    string,
    {
      events: OpenClawEvent[];
      chatMessage?: unknown;
      assistant?: AssistantProjection;
      scope?: ReplaySessionScope;
      textReceipt?: GatewayEventReceipt;
    }
  >();
  private readonly consumedEvents = new WeakSet<GatewayEvent>();
  private replayConnectionEpoch: object | undefined;

  publish(event: GatewayEvent): void {
    const connectionEpoch = readGatewayEventConnectionEpoch(event);
    if (connectionEpoch && connectionEpoch !== this.replayConnectionEpoch) {
      this.retireBaselines();
      this.replayConnectionEpoch = connectionEpoch;
    }
    const normalized = this.recordReplayEvent(normalizeGatewayEvent(event));
    this.consumedEvents.add(event);
    this.events.publish(normalized);
  }

  close(): void {
    this.events.close();
    this.replayByRunId.clear();
    this.replayConnectionEpoch = undefined;
  }

  private recordReplayEvent(event: OpenClawEvent): OpenClawEvent {
    const runId = event.runId;
    if (!runId) {
      return event;
    }
    let replay = this.replayByRunId.get(runId);
    let trimReplayRuns = !replay;
    if (!replay) {
      replay = { events: [] };
      this.replayByRunId.set(runId, replay);
    }
    const projection = readChatProjection(event);
    const assistant = projectAssistantRunEvent(event, replay.assistant);
    if (assistant) {
      replay.assistant = assistant.assistant;
      event = assistant.event;
    }
    if (projection?.state === "delta") {
      replay.chatMessage = mergeChatStreamMessage(replay.chatMessage, projection.payload);
      if (replay.chatMessage !== undefined) {
        // Retained normalized events keep a baseline even when the raw prefix is
        // evicted. `raw` and rawEvents() still describe the received wire frame.
        event = { ...event, data: { ...projection.payload, message: replay.chatMessage } };
      }
    } else if (projection || isTerminalRunEvent(event)) {
      delete replay.chatMessage;
      delete replay.assistant;
      this.replayByRunId.delete(runId);
      this.replayByRunId.set(runId, replay);
      trimReplayRuns = true;
    }
    if (
      (projection?.state === "delta" && replay.chatMessage !== undefined) ||
      assistant?.assistant
    ) {
      replay.scope = {
        sessionKey: event.sessionKey ?? replay.scope?.sessionKey,
        agentId: event.agentId ?? replay.scope?.agentId,
      };
      if (event.raw) {
        replay.textReceipt = readGatewayEventReceipt(event.raw);
      }
    }
    const { events } = replay;
    events.push(event);
    if (events.length > MAX_REPLAY_EVENTS_PER_RUN) {
      events.splice(0, events.length - MAX_REPLAY_EVENTS_PER_RUN);
    }
    if (trimReplayRuns) {
      this.trimReplayRuns();
    }
    return event;
  }

  retireBaselines(): void {
    this.replayConnectionEpoch = undefined;
    for (const replay of this.replayByRunId.values()) {
      delete replay.chatMessage;
      delete replay.assistant;
    }
    this.trimReplayRuns();
  }

  async retireUnsubscribedSession(params: unknown, response: unknown): Promise<void> {
    const subscription = readUnsubscribedSession(params, response);
    if (!subscription) {
      return;
    }
    const receipt = takeGatewayResponseReceipt(response);
    const watermark = receipt?.event;
    if (watermark && !this.consumedEvents.has(watermark)) {
      const events = this.events.stream((event) => event.raw === watermark)[Symbol.asyncIterator]();
      try {
        // Projection failure cannot undo an acknowledged unsubscribe.
        await events.next().catch(() => undefined);
      } finally {
        await events.return?.();
      }
    }
    if (receipt?.epoch.current && this.replayConnectionEpoch !== receipt.epoch) {
      this.retireBaselines();
      this.replayConnectionEpoch = receipt.epoch;
    }
    for (const replay of this.replayByRunId.values()) {
      if (!replay.scope || !matchesUnsubscribedSession(replay.scope, subscription)) {
        continue;
      }
      if (
        receipt &&
        (replay.textReceipt?.epoch !== receipt.epoch || replay.textReceipt.order > receipt.order)
      ) {
        continue;
      }
      delete replay.chatMessage;
      delete replay.assistant;
    }
    this.trimReplayRuns();
  }

  private trimReplayRuns(): void {
    if (this.replayByRunId.size <= MAX_REPLAY_RUNS) {
      return;
    }
    let retained = 0;
    // Active baselines cannot be evicted: later wire frames contain only suffixes.
    for (const [runId, candidate] of [...this.replayByRunId].reverse()) {
      if (
        candidate.chatMessage === undefined &&
        candidate.assistant === undefined &&
        ++retained > MAX_REPLAY_RUNS
      ) {
        this.replayByRunId.delete(runId);
      }
    }
  }

  snapshot(runId: string): OpenClawEvent[] {
    return [...(this.replayByRunId.get(runId)?.events ?? [])];
  }
}
