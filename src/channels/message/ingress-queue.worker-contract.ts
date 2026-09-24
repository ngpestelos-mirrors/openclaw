import type * as kernel from "./ingress-queue.kernel.js";

type Operation<Fn extends (...args: never[]) => unknown> = {
  input: Parameters<Fn>[1];
  output: ReturnType<Fn>;
};

export type ChannelIngressWorkerOperations = {
  "channelIngress.enqueue": Operation<typeof kernel.enqueueChannelIngressInDatabase>;
  "channelIngress.claim": Operation<typeof kernel.claimChannelIngressInDatabase>;
  "channelIngress.claimNext": Operation<typeof kernel.claimNextChannelIngressInDatabase>;
  "channelIngress.recover": Operation<typeof kernel.recoverChannelIngressClaimInDatabase>;
  "channelIngress.refresh": Operation<typeof kernel.refreshChannelIngressClaimInDatabase>;
  "channelIngress.complete": Operation<typeof kernel.completeChannelIngressInDatabase>;
  "channelIngress.release": Operation<typeof kernel.releaseChannelIngressInDatabase>;
  "channelIngress.fail": Operation<typeof kernel.failChannelIngressInDatabase>;
  "channelIngress.delete": Operation<typeof kernel.deleteChannelIngressInDatabase>;
  "channelIngress.resubmit": Operation<typeof kernel.resubmitChannelIngressInDatabase>;
  "channelIngress.prune": Operation<typeof kernel.pruneChannelIngressInDatabase>;
};
