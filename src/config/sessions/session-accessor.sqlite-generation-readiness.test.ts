import "./session-accessor.sqlite-replacement-publication.test-support.js";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  resolveMemoryAudienceFromEntry,
  assertMemoryAudienceCurrent,
  prepareMemoryAudienceRead,
} from "../../plugins/memory-audience.js";
import { bindMemoryProvider } from "../../plugins/memory-provider-adapter.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";
import type { InternalSessionEntry } from "./types.js";

const { getReplacementPublicationDelivery } =
  await import("./session-accessor.sqlite-replacement-publication.test-support.js");
const delivery = getReplacementPublicationDelivery();

function sessionScope(name: string) {
  return {
    agentId: "main",
    storePath: openOpenClawAgentDatabase({ agentId: "main" }).path,
    sessionKey: `agent:main:${name}`,
  };
}

function replace(scope: ReturnType<typeof sessionScope>, entry: InternalSessionEntry) {
  return applySessionEntryExactReplacements({
    ...scope,
    sessionKeys: [scope.sessionKey],
    requireWriteSuccess: true,
    update: () => ({ result: undefined, replacements: [{ sessionKey: scope.sessionKey, entry }] }),
  });
}

function holdPublication() {
  const committed = createDeferred();
  const release = createDeferred();
  delivery.afterResult = async () => {
    committed.resolve();
    await release.promise;
  };
  const wait = (write: Promise<unknown>, signal: AbortSignal) =>
    withinTest(
      awaitGateBeforeSettlement(committed.promise, write, "write did not reach publication"),
      signal,
    );
  return { release, wait };
}

function memoryProvider(
  sessionKey: string,
  audience: Parameters<typeof assertMemoryAudienceCurrent>[0],
) {
  const health = vi.fn(async () => ({ status: "ready" as const }));
  const provider = bindMemoryProvider(
    {
      capabilities: {
        sources: ["memory"],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      health,
      search: async () => ({ hits: [] }),
      get: async () => ({ status: "not_found" }),
      close: async () => {},
    },
    "test",
    {
      authority: { kind: "session", sessionKey, sandboxed: false, audience },
      assertCurrent: () => {},
    },
  );
  return { health, provider };
}

it.for(["permissionMode", "toolOverrides"] as const)(
  "fences retained %s until same-generation policy publication settles",
  async (setting, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = sessionScope("permission-readiness");
      const original = {
        sessionId: "e1234567-1234-1234-1234-123456789abc",
        lifecycleRevision: "original-lifecycle",
        permissionMode: "full" as const,
        toolOverrides: { webSearch: true },
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, original);
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      const settings = {
        permissionMode:
          setting === "permissionMode" ? ("read-only" as const) : original.permissionMode,
        toolOverrides: setting === "toolOverrides" ? { webSearch: false } : original.toolOverrides,
      };
      const { release, wait } = holdPublication();
      const onAbort = () => release.resolve();
      signal.addEventListener("abort", onAbort, { once: true });

      const write = replace(scope, { ...original, ...settings });
      try {
        await wait(write, signal);
        // Main's generation-only readers stay current; policy consumers cannot reuse old grants.
        generation.assertCurrent();
        expect(generation.readSessionSettings).toThrow(
          expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
        );
        release.resolve();
        await withinTest(write, signal);
        generation.assertCurrent();
        expect(generation.readSessionSettings()).toEqual(settings);
      } finally {
        release.resolve();
        delivery.afterResult = undefined;
        await Promise.allSettled([write]);
        signal.removeEventListener("abort", onAbort);
        generation.release();
      }
    });
  },
);

it.for(["metadata", "replacement"] as const)(
  "joins admitted %s publication before checking the retained session generation",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = sessionScope("generation-readiness");
      const original = {
        sessionId: "a1234567-1234-1234-1234-123456789abc",
        chatType: "direct" as const,
        lifecycleRevision: "original-lifecycle",
        updatedAt: 1,
      };
      replaceSessionEntrySync(scope, original);
      const generation = await prepareSessionGenerationFacts({ ...scope, ...original });
      const releasedGeneration = await prepareSessionGenerationFacts({ ...scope, ...original });
      const grant = await resolveMemoryAudienceFromEntry(
        { ...scope, sessionId: original.sessionId, senderIsOwner: true },
        original,
      );
      if (grant.status !== "granted") {
        throw new Error(grant.reason);
      }
      const { health, provider } = memoryProvider(scope.sessionKey, grant.audience);
      const writes: Promise<unknown>[] = [];
      const readiness: Promise<unknown>[] = [];
      let releaseReply = () => {};
      const onAbort = () => releaseReply();
      signal.addEventListener("abort", onAbort, { once: true });
      const replaceLabel = (label: string) =>
        replace(scope, {
          ...original,
          label,
          lifecycleRevision:
            kind === "replacement" ? "replacement-lifecycle" : original.lifecycleRevision,
        });
      try {
        for (const round of kind === "metadata" ? [0, 1] : [0]) {
          const { release, wait } = holdPublication();
          releaseReply = () => release.resolve();

          const write = replaceLabel(`metadata-${round}`);
          writes.push(write);
          await wait(write, signal);
          // Synchronous reads stay available for an identity-preserving publication; a
          // replacement fences them. Prepared reads still join either publication.
          if (kind === "metadata") {
            generation.assertCurrent();
            assertMemoryAudienceCurrent(grant.audience);
          } else {
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE" }),
            );
            expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow(
              "currency is unavailable",
            );
          }
          const priorCalls = health.mock.calls.length;
          const providerRead = provider.health().catch((error: unknown) => error);
          readiness.push(providerRead);
          expect(health).toHaveBeenCalledTimes(priorCalls);
          const pending = generation.prepareRead();
          expect(pending).toBeInstanceOf(Promise);
          if (!pending) {
            throw new Error("The admitted replacement must expose publication completion");
          }
          readiness.push(pending);
          let prepared = false;
          void pending.then(
            () => {
              prepared = true;
            },
            () => {},
          );
          let releasedRead: Promise<unknown> | undefined;
          if (round === 0) {
            releasedRead = releasedGeneration.prepareRead()?.catch((error: unknown) => error);
            expect(releasedRead).toBeInstanceOf(Promise);
            if (releasedRead) {
              readiness.push(releasedRead);
            }
            releasedGeneration.release();
          }
          await Promise.resolve();
          expect(prepared).toBe(false);
          release.resolve();
          await withinTest(write, signal);
          await withinTest(pending, signal);
          if (releasedRead) {
            await expect(releasedRead).resolves.toMatchObject({
              code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE",
            });
          }
          expect(generation.prepareRead()).toBeUndefined();
          if (kind === "replacement") {
            expect(await providerRead).toBeInstanceOf(Error);
            expect(health).toHaveBeenCalledTimes(priorCalls);
            expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow("no longer current");
            expect(generation.assertCurrent).toThrow(
              expect.objectContaining({ code: "SESSION_DELIVERY_GENERATION_REVOKED" }),
            );
          } else {
            await expect(providerRead).resolves.toEqual({ status: "ready" });
            expect(health).toHaveBeenCalledTimes(priorCalls + 1);
            generation.assertCurrent();
            assertMemoryAudienceCurrent(grant.audience);
          }
        }
        delivery.afterResult = undefined;
        if (kind === "metadata") {
          // A queued successor has not published an admission and cannot make its owner wait.
          let successor: Promise<unknown> | undefined;
          await runOpenClawAgentWriteAdmission(
            { agentId: scope.agentId, path: scope.storePath },
            () => {
              successor = replaceLabel("queued-successor");
              writes.push(successor);
              expect(generation.prepareRead()).toBeUndefined();
              generation.assertCurrent();
            },
          );
          if (!successor) {
            throw new Error("The admitted owner must start its queued successor");
          }
          await withinTest(successor, signal);
          generation.assertCurrent();
        }
      } finally {
        releaseReply();
        delivery.afterResult = undefined;
        await Promise.allSettled([...writes, ...readiness]);
        signal.removeEventListener("abort", onAbort);
        releasedGeneration.release();
        generation.release();
        grant.release();
        await provider.close();
      }
    });
  },
);

it.for(["metadata", "reset"] as const)(
  "waits on a parent %s publication before a retained child audience reaches the provider",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const parentScope = sessionScope("generation-parent");
      const childScope = { ...parentScope, sessionKey: "agent:main:subagent:generation-child" };
      const parent = {
        sessionId: "b1234567-1234-1234-1234-123456789abc",
        chatType: "direct" as const,
        lifecycleRevision: "parent-lifecycle",
        updatedAt: 1,
      };
      const child = {
        sessionId: "c1234567-1234-1234-1234-123456789abc",
        lifecycleRevision: "child-lifecycle",
        spawnedBy: parentScope.sessionKey,
        spawnedBySessionId: parent.sessionId,
        spawnedBySenderIsOwner: true,
        parentSessionLifecycleRevision: parent.lifecycleRevision,
        updatedAt: 1,
      };
      replaceSessionEntrySync(parentScope, parent);
      replaceSessionEntrySync(childScope, child);
      // The child's audience is minted through the real lineage walk and leases its parent.
      const grant = await resolveMemoryAudienceFromEntry(
        { ...childScope, sessionId: child.sessionId, senderIsOwner: false },
        child,
      );
      if (grant.status !== "granted") {
        throw new Error(grant.reason);
      }
      const { health, provider } = memoryProvider(childScope.sessionKey, grant.audience);
      const { release, wait } = holdPublication();
      const onAbort = () => release.resolve();
      signal.addEventListener("abort", onAbort, { once: true });

      // Hold the parent publication mid-flight; a reset keeps the session id but changes its revision.
      const reset = replace(parentScope, {
        ...parent,
        label: "parent-metadata",
        lifecycleRevision: kind === "reset" ? "parent-reset-lifecycle" : parent.lifecycleRevision,
        updatedAt: 2,
      });
      try {
        await wait(reset, signal);
        // The child audience waits on its parent's admitted publication instead of failing.
        const waiting = prepareMemoryAudienceRead(grant.audience)?.then(
          () => "current",
          (error: unknown) => error,
        );
        expect(waiting).toBeInstanceOf(Promise);
        if (kind === "metadata") {
          assertMemoryAudienceCurrent(grant.audience);
        }
        const providerRead = provider.health().catch((error: unknown) => error);
        expect(health).not.toHaveBeenCalled();
        release.resolve();
        await withinTest(reset, signal);
        if (kind === "reset") {
          expect(await waiting).toBeInstanceOf(Error);
          expect(await providerRead).toBeInstanceOf(Error);
          expect(health).not.toHaveBeenCalled();
          expect(() => assertMemoryAudienceCurrent(grant.audience)).toThrow("no longer current");
        } else {
          await expect(waiting).resolves.toBe("current");
          await expect(providerRead).resolves.toEqual({ status: "ready" });
          expect(health).toHaveBeenCalledTimes(1);
          assertMemoryAudienceCurrent(grant.audience);
        }
      } finally {
        release.resolve();
        delivery.afterResult = undefined;
        await Promise.allSettled([reset]);
        signal.removeEventListener("abort", onAbort);
        grant.release();
        await provider.close();
      }
    });
  },
);
