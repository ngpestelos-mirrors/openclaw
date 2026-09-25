// Gateway node subscription manager.
// Maintains bidirectional node/session fanout indexes.
import {
  serializeEventPayload,
  type NodeEventPayloadPreparation,
  type SerializedEventPayload,
} from "./node-registry.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

// Node subscription manager keeps bidirectional node/session indexes so gateway
// events can fan out by session and all node cleanup paths remove reverse links.
type NodeSendEventFn = (opts: {
  nodeId: string;
  pairingGeneration: string;
  event: string;
  payloadJSON?: SerializedEventPayload | null;
  preparePayload?: NodeEventPayloadPreparation;
}) => void | Promise<unknown>;

type NodeSubscriptionManager = {
  subscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribeAll: (nodeId: string, pairingGeneration?: string) => void;
  hasSubscribers: (sessionKey: string) => boolean;
  updatePairingGeneration: (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => void;
  sendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
    opts?: GatewayBroadcastOpts,
  ) => Promise<void>;
  sendToAllSubscribed: (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => Promise<void>;
};

/** Manages node subscriptions to gateway session events. */
export function createNodeSubscriptionManager(): NodeSubscriptionManager {
  type Subscription = { pairingGeneration: string };
  type Publication = { version: unknown };
  type Receipt = { connId: string; publication: Publication };
  const nodeSubscriptions = new Map<
    string,
    { pairingGeneration: string; sessionKeys: Map<string, Subscription> }
  >();
  const sessionSubscribers = new Map<string, Map<string, Subscription>>();
  const liveTextGroups = new WeakMap<
    AbortSignal,
    {
      publications: Map<string, Publication>;
      receipts: WeakMap<Subscription, Map<string, Receipt>>;
    }
  >();

  const toPayloadJSON = (payload: unknown): SerializedEventPayload | null | undefined => {
    try {
      return serializeEventPayload(payload);
    } catch {
      return undefined;
    }
  };

  const settleFanout = async <Entry>(
    entries: Iterable<Entry>,
    createSend: (entry: Entry) => () => ReturnType<NodeSendEventFn>,
  ): Promise<void> => {
    // Build sender closures before yielding without retaining iterator tuples.
    // Settle failures because public Gateway callers fire-and-forget this fanout.
    await Promise.allSettled(
      Array.from(entries, (entry) => Promise.resolve().then(createSend(entry))),
    );
  };

  const subscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    let nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      unsubscribeAll(normalizedNodeId);
      nodeEntry = undefined;
    }
    if (!nodeEntry) {
      nodeEntry = {
        pairingGeneration: normalizedPairingGeneration,
        sessionKeys: new Map(),
      };
      nodeSubscriptions.set(normalizedNodeId, nodeEntry);
    }
    if (nodeEntry.sessionKeys.has(normalizedSessionKey)) {
      return;
    }
    const subscription = { pairingGeneration: normalizedPairingGeneration };
    nodeEntry.sessionKeys.set(normalizedSessionKey, subscription);

    let sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (!sessionMap) {
      sessionMap = new Map();
      sessionSubscribers.set(normalizedSessionKey, sessionMap);
    }
    sessionMap.set(normalizedNodeId, subscription);
  };

  const unsubscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      return;
    }
    nodeEntry.sessionKeys.delete(normalizedSessionKey);
    if (nodeEntry.sessionKeys.size === 0) {
      nodeSubscriptions.delete(normalizedNodeId);
    }

    const sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (sessionMap?.get(normalizedNodeId)?.pairingGeneration === normalizedPairingGeneration) {
      sessionMap.delete(normalizedNodeId);
    }
    if (sessionMap?.size === 0) {
      sessionSubscribers.delete(normalizedSessionKey);
    }
  };

  function unsubscribeAll(nodeId: string, pairingGeneration?: string) {
    const normalizedNodeId = nodeId.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      (pairingGeneration !== undefined && nodeEntry.pairingGeneration !== pairingGeneration.trim())
    ) {
      return;
    }
    // Remove reverse session indexes before deleting the node index so session
    // fanout cannot retain disconnected node ids.
    for (const sessionKey of nodeEntry.sessionKeys.keys()) {
      const sessionMap = sessionSubscribers.get(sessionKey);
      if (sessionMap?.get(normalizedNodeId)?.pairingGeneration === nodeEntry.pairingGeneration) {
        sessionMap.delete(normalizedNodeId);
      }
      if (sessionMap?.size === 0) {
        sessionSubscribers.delete(sessionKey);
      }
    }
    nodeSubscriptions.delete(normalizedNodeId);
  }

  const updatePairingGeneration = (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => {
    const normalizedNodeId = params.nodeId.trim();
    const previousPairingGeneration = params.previousPairingGeneration.trim();
    const nextPairingGeneration = params.nextPairingGeneration.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      !previousPairingGeneration ||
      nodeEntry.pairingGeneration !== previousPairingGeneration
    ) {
      return;
    }
    if (!params.preserveSubscriptions || !nextPairingGeneration) {
      unsubscribeAll(normalizedNodeId, previousPairingGeneration);
      return;
    }
    nodeEntry.pairingGeneration = nextPairingGeneration;
    for (const subscription of nodeEntry.sessionKeys.values()) {
      subscription.pairingGeneration = nextPairingGeneration;
    }
  };

  const sendToSession = async (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
    opts?: GatewayBroadcastOpts,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !sendEvent) {
      return;
    }
    const subscribers = sessionSubscribers.get(normalizedSessionKey);
    const liveText = opts?.liveText;
    if (!liveText?.projection) {
      if (!subscribers?.size) {
        return;
      }
      const payloadJSON = toPayloadJSON(payload);
      if (payloadJSON === undefined) {
        return;
      }
      return settleFanout(subscribers, ([nodeId, subscription]) => {
        const pairingGeneration = subscription.pairingGeneration;
        return () => sendEvent({ nodeId, pairingGeneration, event, payloadJSON });
      });
    }
    if (liveText.group.aborted) {
      return;
    }
    const projection = liveText.projection;
    const streamKey = `${normalizedSessionKey}\0${projection.key}`;
    let group = liveTextGroups.get(liveText.group);
    if (!group) {
      group = { publications: new Map(), receipts: new WeakMap() };
      liveTextGroups.set(liveText.group, group);
      const retiredGroup = group;
      liveText.group.addEventListener(
        "abort",
        () => {
          retiredGroup.publications.clear();
          retiredGroup.receipts = new WeakMap();
          liveTextGroups.delete(liveText.group);
        },
        { once: true },
      );
    }
    const previousPublication = group.publications.get(streamKey);
    const publication = { version: projection.version };
    group.publications.set(streamKey, publication);
    if (!subscribers?.size) {
      return;
    }

    // Each representation is serialized only if a current recipient needs it.
    let snapshotJSON: SerializedEventPayload | null | undefined;
    let deltaJSON: SerializedEventPayload | null | undefined;
    await settleFanout(subscribers, ([nodeId, subscription]) => {
      const pairingGeneration = subscription.pairingGeneration;
      return () =>
        sendEvent({
          nodeId,
          pairingGeneration,
          event,
          preparePayload: (connId) => {
            if (
              sessionSubscribers.get(normalizedSessionKey)?.get(nodeId) !== subscription ||
              subscription.pairingGeneration !== pairingGeneration ||
              liveText.group.aborted ||
              liveText.isCurrent?.() === false
            ) {
              return undefined;
            }
            const receipt = group.receipts.get(subscription)?.get(streamKey);
            const append =
              !projection.snapshot &&
              receipt?.connId === connId &&
              receipt.publication === previousPublication &&
              Object.is(previousPublication?.version, publication.version);
            const payloadJSON = append
              ? (deltaJSON ??= toPayloadJSON(projection.delta(payload)))
              : (snapshotJSON ??= toPayloadJSON(payload));
            if (payloadJSON === undefined) {
              return undefined;
            }
            return {
              payloadJSON,
              onSent: () => {
                if (!liveText.group.aborted) {
                  let receipts = group.receipts.get(subscription);
                  if (!receipts) {
                    receipts = new Map();
                    group.receipts.set(subscription, receipts);
                  }
                  receipts.set(streamKey, { connId, publication });
                }
              },
            };
          },
        });
    });
  };

  const sendToAllSubscribed = async (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    await settleFanout(
      nodeSubscriptions,
      ([nodeId, subscription]) =>
        () =>
          sendEvent({
            nodeId,
            pairingGeneration: subscription.pairingGeneration,
            event,
            payloadJSON,
          }),
    );
  };

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    hasSubscribers: (sessionKey) => sessionSubscribers.has(sessionKey.trim()),
    updatePairingGeneration,
    sendToSession,
    sendToAllSubscribed,
  };
}
