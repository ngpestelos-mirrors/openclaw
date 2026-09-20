import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";

export type ChannelIngressHostOwner = Readonly<{
  channelId: string;
  record: object;
  epoch: object;
  isLive: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}>;
