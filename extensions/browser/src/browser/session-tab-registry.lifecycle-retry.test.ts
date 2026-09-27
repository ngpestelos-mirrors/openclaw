import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  cdpMocks,
  clearProcessLocalTabState,
  installSessionTabRegistrySqliteHarness,
  setBrowserProfileConfig,
} from "./session-tab-registry.sqlite.test-harness.js";
import { durableOwnership as ownership } from "./session-tab-registry.sqlite.test-helpers.js";

describe("session tab lifecycle cleanup", () => {
  const { freshRegistry, openStore, installRuntime } = installSessionTabRegistrySqliteHarness();

  it.each(["successful", "failed"] as const)(
    "closes a durable tab after reopening with a %s initial store read",
    async (initialRead) => {
      setBrowserProfileConfig();
      const first = await freshRegistry("first");
      await first.trackSessionBrowserTab({
        sessionKey: "Agent:Main:Main",
        targetId: "interaction-target",
        profile: "Remote",
        profileAliases: ["remote-alias"],
        ownership: ownership("NATIVE-1"),
        now: 1_000,
      });
      expect(openStore().entries()).toHaveLength(1);

      resetPluginStateStoreForTests();
      clearProcessLocalTabState();
      if (initialRead === "failed") {
        const error = new Error("initial worker read failed");
        let failed = false;
        await expect(
          installRuntime((options) => {
            const store = createPluginStateKeyedStoreForTests("browser", options);
            return {
              ...store,
              withCurrent: (authority) => {
                const bound = store.withCurrent!(authority);
                return {
                  ...bound,
                  entries: async () => {
                    if (!failed) {
                      failed = true;
                      throw error;
                    }
                    return await bound.entries();
                  },
                };
              },
            };
          }),
        ).rejects.toBe(error);
      } else {
        await installRuntime();
      }
      const restarted = await freshRegistry("restarted");
      await restarted.touchSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "NATIVE-1",
        profile: "remote-alias",
        now: 2_000,
      });
      expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 2_000 });

      await expect(
        restarted.closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
      ).resolves.toBe(1);
      expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith({
        profileName: "remote",
        cdpUrl: "http://127.0.0.1:9222",
        nativeTargetId: "NATIVE-1",
        timeoutMs: expect.any(Number),
        ssrfPolicy: expect.any(Object),
        expectedProfileFingerprint: "test-profile-fingerprint",
        expectedBrowserInstanceFingerprint: "test-browser-instance-fingerprint",
        closeIfCurrent: expect.any(Function),
      });
      expect(openStore().entries()).toEqual([]);
    },
  );

  it.each(["durable", "volatile"] as const)(
    "settles admitted %s cleanup but stops claiming tabs when its caller changes",
    async (kind) => {
      const registry = await freshRegistry(`caller-generation-${kind}`);
      const sessionKey = "agent:subagent:ended";
      for (const targetId of ["tab-a", "tab-b"]) {
        await registry.trackSessionBrowserTab({
          sessionKey,
          targetId,
          profile: "remote",
          ...(kind === "durable"
            ? { ownership: ownership(targetId) }
            : { route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const }),
        });
      }
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      let current = true;
      const closeTab = vi.fn(async (_tab: { targetId: string }) => {
        started.resolve();
        await finish.promise;
      });
      const closeDurableTab: NonNullable<
        Parameters<typeof registry.closeTrackedBrowserTabsForSessions>[0]["closeDurableTab"]
      > = async (tab, options) => {
        return await options.closeIfCurrent(async () => {
          await closeTab({ targetId: tab.nativeTargetId });
          return { status: "closed" };
        });
      };
      const cleanup = registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        isCurrent: () => current,
        closeTab,
        closeDurableTab,
      });
      try {
        await started.promise;
        current = false;
        finish.resolve();
        await expect(cleanup).resolves.toBe(1);
        expect(closeTab).toHaveBeenCalledOnce();
        if (kind === "durable") {
          expect(openStore().entries()).toHaveLength(1);
          expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
        }
        await expect(
          registry.closeTrackedBrowserTabsForSessions({
            sessionKeys: [sessionKey],
            closeTab,
            closeDurableTab,
          }),
        ).resolves.toBe(1);
        expect(closeTab.mock.calls.map(([tab]) => tab.targetId).toSorted()).toEqual([
          "tab-a",
          "tab-b",
        ]);
        expect(openStore().entries()).toEqual([]);
      } finally {
        finish.resolve();
        await cleanup;
      }
    },
  );

  it.each([true, false])(
    "retries pending lifecycle cleanup with ordinary cleanup %s",
    async (ordinaryCleanup) => {
      const registry = await freshRegistry("lifecycle-retry");
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:subagent:ended",
        targetId: "opaque",
        profile: "remote",
        ownership: ownership("NATIVE-PENDING"),
        now: 1_000,
      });
      await expect(
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: ["agent:subagent:ended"],
          now: 2_000,
          closeDurableTab: async () => ({
            status: "unavailable",
            reason: "target-lookup-failed",
          }),
        }),
      ).resolves.toBe(0);
      expect(openStore().entries()[0]?.value).toMatchObject({
        nativeTargetId: "NATIVE-PENDING",
        cleanupKind: "lifecycle",
        cleanupAttemptToken: expect.any(String),
      });
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:main:active",
        targetId: "active",
        profile: "remote",
        ownership: ownership("NATIVE-ACTIVE"),
        now: 1_000,
      });

      await expect(
        registry.sweepTrackedBrowserTabs({
          now: 10_000,
          ordinaryCleanup,
          sessionFilter: () => false,
          closeDurableTab: async (_tab, options) =>
            await options.closeIfCurrent(async () => ({ status: "closed" })),
        }),
      ).resolves.toBe(1);
      expect(
        openStore()
          .entries()
          .map((entry) => entry.value),
      ).toEqual([expect.objectContaining({ nativeTargetId: "NATIVE-ACTIVE" })]);
    },
  );
});
