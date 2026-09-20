import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { UserChannelIdentity } from "../../state/user-channel-identities.js";
import type { ChannelIngressContextBinding } from "./runtime-types.js";

export type ChannelIngressHostOwner = Readonly<{
  channelId: string;
  record: object;
  epoch: object;
  isLive: () => boolean;
  resolveGatewayContext?: GatewayContextResolver;
}>;

export type ChannelParticipantInput = {
  identity: Extract<SessionParticipantIdentity, { type: "remote" | "observation" }>;
  binding: ChannelIngressContextBinding;
  promptedAt: number;
  owner: ChannelIngressHostOwner;
  gatewayContext: ReturnType<GatewayContextResolver>;
  verifiedPrincipal?: UserChannelIdentity;
};
