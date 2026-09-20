import type {
  ChannelIngressRouteAccess,
  ChannelIngressRouteDescriptor,
  ResolveChannelMessageIngressParams,
  ResolvedChannelMessageIngress,
} from "./runtime-types.js";
import type {
  AccessGraphGate,
  RedactedIngressMatch,
  RouteGateFacts,
  RouteSenderPolicy,
} from "./types.js";

type RouteFactDefaults = {
  id: string;
  kind?: RouteGateFacts["kind"];
  precedence?: number;
  senderPolicy?: RouteSenderPolicy;
  senderAllowFrom?: Array<string | number>;
  senderAllowFromSource?: RouteGateFacts["senderAllowFromSource"];
  match?: RedactedIngressMatch;
};

function routeDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): ChannelIngressRouteDescriptor[] {
  if (!route) {
    return [];
  }
  return [route].flat();
}

/**
 * Collect optional route descriptors while dropping false, null, and undefined
 * entries.
 */
export function channelIngressRoutes(
  ...routes: Array<ChannelIngressRouteDescriptor | false | null | undefined>
): ChannelIngressRouteDescriptor[] {
  return routes.filter((route): route is ChannelIngressRouteDescriptor => Boolean(route));
}

function routeDescriptorMatch(descriptor: ChannelIngressRouteDescriptor) {
  const matched = descriptor.matched ?? descriptor.allowed ?? descriptor.enabled !== false;
  return {
    matched,
    matchedEntryIds: matched && descriptor.matchId ? [descriptor.matchId] : [],
  };
}

function routeFact(
  params: RouteFactDefaults & Pick<RouteGateFacts, "gate" | "effect">,
): RouteGateFacts {
  return {
    id: params.id,
    kind: params.kind ?? "route",
    gate: params.gate,
    effect: params.effect,
    precedence: params.precedence ?? 0,
    senderPolicy: params.senderPolicy ?? "inherit",
    senderAllowFrom: params.senderAllowFrom,
    senderAllowFromSource: params.senderAllowFromSource,
    match: params.match,
  };
}

function routeFactDefaults(descriptor: ChannelIngressRouteDescriptor) {
  return {
    id: descriptor.id,
    ...(descriptor.kind ? { kind: descriptor.kind } : {}),
    ...(descriptor.precedence !== undefined ? { precedence: descriptor.precedence } : {}),
    ...(descriptor.senderPolicy ? { senderPolicy: descriptor.senderPolicy } : {}),
    ...(descriptor.senderAllowFrom != null
      ? { senderAllowFrom: [...descriptor.senderAllowFrom] }
      : {}),
    ...(descriptor.senderAllowFromSource
      ? { senderAllowFromSource: descriptor.senderAllowFromSource }
      : {}),
    match: routeDescriptorMatch(descriptor),
  };
}

export function routeFactsFromDescriptors(
  route: ResolveChannelMessageIngressParams["route"],
): RouteGateFacts[] {
  return routeDescriptors(route).flatMap((descriptor) => {
    if (descriptor.configured === false) {
      return [];
    }
    const defaults = routeFactDefaults(descriptor);
    if (descriptor.enabled === false) {
      return [routeFact({ ...defaults, gate: "disabled", effect: "block-dispatch" })];
    }
    if (descriptor.allowed !== undefined) {
      return [
        routeFact({
          ...defaults,
          gate: descriptor.allowed ? "matched" : "not-matched",
          effect: descriptor.allowed ? "allow" : "block-dispatch",
        }),
      ];
    }
    if (
      descriptor.senderPolicy !== "deny-when-empty" &&
      descriptor.senderAllowFrom == null &&
      descriptor.senderAllowFromSource == null
    ) {
      return [];
    }
    return [
      routeFact({
        ...defaults,
        kind: descriptor.senderPolicy === "deny-when-empty" ? defaults.kind : "routeSender",
        gate: "matched",
        effect: "allow",
        senderPolicy:
          descriptor.senderPolicy === "deny-when-empty" ? "deny-when-empty" : defaults.senderPolicy,
      }),
    ];
  });
}

function routeDescriptorForGate(params: {
  descriptors: readonly ChannelIngressRouteDescriptor[];
  gate: AccessGraphGate;
}): ChannelIngressRouteDescriptor | undefined {
  const senderSuffix = ":sender";
  const baseGateId = params.gate.id.endsWith(senderSuffix)
    ? params.gate.id.slice(0, -senderSuffix.length)
    : params.gate.id;
  return params.descriptors.find(
    (descriptor) => descriptor.id === params.gate.id || descriptor.id === baseGateId,
  );
}

export function projectRouteAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  route: ResolveChannelMessageIngressParams["route"];
}): ChannelIngressRouteAccess {
  const descriptors = routeDescriptors(params.route);
  const routeBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "route" && entry.effect === "block-dispatch",
  );
  if (routeBlock) {
    const descriptor = routeDescriptorForGate({ descriptors, gate: routeBlock });
    return {
      allowed: routeBlock.allowed,
      reasonCode: routeBlock.reasonCode,
      ...(descriptor?.blockReason ? { reason: descriptor.blockReason } : {}),
      gate: routeBlock,
    };
  }
  const routeSenderReplacement = descriptors.find(
    (descriptor) => descriptor.senderPolicy === "replace" && descriptor.blockReason,
  );
  const senderBlock = params.ingress.graph.gates.find(
    (entry) => entry.phase === "sender" && entry.effect === "block-dispatch",
  );
  if (routeSenderReplacement && senderBlock) {
    return {
      allowed: false,
      reasonCode: senderBlock.reasonCode,
      reason: routeSenderReplacement.blockReason,
      gate: senderBlock,
    };
  }
  const gate = params.ingress.graph.gates.find((entry) => entry.phase === "route");
  if (gate) {
    return {
      allowed: gate.allowed,
      reasonCode: gate.reasonCode,
      gate,
    };
  }
  return { allowed: true };
}
