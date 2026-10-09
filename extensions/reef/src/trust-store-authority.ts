import type {
  PluginStateBatch,
  PluginStateBatchKey,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  matchesReefPeerIdentity,
  type ReefAutonomy,
  type ReefPeerIdentity,
} from "./friend-types.js";
import { ReefPeerStateSchema, ReefPeerTrustChangedError } from "./trust-store-format.js";

export function createReefPeerAssertion(
  batch: PluginStateBatch,
  key: PluginStateBatchKey,
  peer: string,
  expected: ReefPeerIdentity,
  autonomy?: ReefAutonomy,
): () => void {
  const identity = { ...expected };
  return () =>
    batch.assertCurrentValue(key, (value) => {
      const current = value === undefined ? undefined : ReefPeerStateSchema.parse(value).trust;
      if (
        !matchesReefPeerIdentity(current, identity) ||
        (autonomy !== undefined && current?.autonomy !== autonomy)
      ) {
        throw new ReefPeerTrustChangedError(peer);
      }
    });
}
