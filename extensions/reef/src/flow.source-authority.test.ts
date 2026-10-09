import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateIdentity } from "../protocol/index.js";
import { MemoryAuditStore, MemoryReplayStore } from "../protocol/memory-stores.test-support.js";
import { ReefMessageFlow } from "./flow.js";
import {
  allow,
  config,
  envelope,
  flowStores,
  guard,
  peerTrust,
  reefKeys,
  resetFlowStoresForTests,
} from "./flow.test-helpers.js";
import { ReefTransportClient } from "./transport.js";
import { openReefTrustStore } from "./trust-store.js";

const directories: string[] = [];
beforeEach(resetFlowStoresForTests);
afterEach(async () => {
  await resetFlowStoresForTests();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runtime(env: NodeJS.ProcessEnv) {
  const value = createPluginRuntimeMock();
  value.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("reef", { ...options, env });
  value.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", { ...options, env });
  return value;
}

describe("Reef captured source authority", () => {
  it.each(["outbound", "inbound", "recovery"] as const)(
    "refuses %s effects after the original database revokes trust and routing changes",
    async (direction) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reef-source-authority-"));
      directories.push(directory);
      const originalEnv = { OPENCLAW_STATE_DIR: path.join(directory, "original") };
      const alternateEnv = { OPENCLAW_STATE_DIR: path.join(directory, "alternate") };
      const movingEnv = { ...originalEnv };
      const cfg = config();
      const peer = generateIdentity();
      const keys = reefKeys();
      const original = openReefTrustStore(runtime(originalEnv), cfg);
      const alternate = openReefTrustStore(runtime(alternateEnv), cfg);
      await original.set("alice", peerTrust(peer));
      await alternate.set("alice", peerTrust(peer));
      const trust = openReefTrustStore(runtime(movingEnv), cfg);
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("unexpected relay request"));
      const ingress = vi.fn(async () => {});
      const stores = flowStores();
      const revokeAndReroute = async () => {
        await original.remove("alice");
        movingEnv.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
      };
      const flow = new ReefMessageFlow({
        config: cfg,
        trust,
        keys,
        transport: new ReefTransportClient(cfg.relayUrl, cfg.handle!, keys, fetcher),
        guard: guard(allow),
        audit: new MemoryAuditStore(new Uint8Array(32).fill(8)),
        replay: new MemoryReplayStore(),
        ...stores,
        onIngress: async (_message, assertCurrent) => {
          assertCurrent();
          await ingress();
        },
        onOwnerNotice: async () => {},
      });
      if (direction === "recovery") {
        const id = "01JZ0000000000000000000161";
        const preparation = (await trust.prepareOutboundDelivery("alice", id))!;
        await preparation.record({
          bodyHash: "a".repeat(64),
          recipient: {
            ed25519PublicKey: peer.signing.publicKey,
            x25519PublicKey: peer.encryption.publicKey,
            keyEpoch: 1,
          },
        });
        const delivery = (await trust.readOutboundDelivery("alice", id))!;
        await delivery.reject("guard_deny");
        const { recovery } = delivery;
        movingEnv.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
        const notice = { lastRejectionAt: 10_000 };
        await expect(recovery.reserve(notice)).resolves.toEqual({ kind: "reserved" });
        expect(
          (await original.readOutboundDelivery("alice", id))?.delivery.rejection?.notice,
        ).toEqual(notice);
        expect(await recovery.complete(notice)).toBe(true);
        expect(await original.readOutboundDelivery("alice", id)).toBeUndefined();
        await expect(
          flow.send("alice", "rephrased coordination", {
            prepareDelivery: recovery.prepareOutboundDelivery.bind(recovery),
            onPlatformSendDispatch: revokeAndReroute,
          }),
        ).rejects.toThrow("changed trust before dispatch");
      } else if (direction === "outbound") {
        await expect(
          flow.send("alice", "private coordination", { onPlatformSendDispatch: revokeAndReroute }),
        ).rejects.toThrow("changed trust before dispatch");
      } else {
        vi.spyOn(stores.delivered, "status").mockImplementationOnce(async () => {
          await revokeAndReroute();
          return undefined;
        });
        const message = await envelope(
          peer,
          keys,
          "01JZ0000000000000000000160",
          "private coordination",
        );
        await expect(
          flow.processEntries([
            { seq: 1, peer: "alice", id: message.id, kind: "message", envelope: message, ts: 1 },
          ]),
        ).rejects.toThrow("changed trust before dispatch");
      }
      expect(await alternate.get("alice")).toBeDefined();
      expect(fetcher).not.toHaveBeenCalled();
      expect(ingress).not.toHaveBeenCalled();
    },
  );
});
