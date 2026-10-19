import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventManagerHarness } from "../manager.test-harness.js";
import { PlivoProvider } from "../providers/plivo.js";
import type { InitiateCallResult } from "../types.js";
import { processEvent } from "./events.js";
import { initiateCall, speak } from "./outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./store.js";

const { cleanup, createContext, createProvider, setup } = createEventManagerHarness();
beforeEach(setup);
afterEach(cleanup);

function delayedOperation<T>() {
  const result = createDeferred<T>();
  const started = createDeferred<void>();
  const invoke = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  return { ...result, started: started.promise, invoke };
}

const contextWith = (overrides: Parameters<typeof createProvider>[0]) =>
  createContext({
    provider: createProvider(overrides),
    webhookUrl: "https://example.com/voice/webhook",
  });

it.each([
  { phase: "active", requestUuid: undefined, payload: "CallUUID-only parser control" },
  { phase: "active", requestUuid: "request-uuid", payload: "complete callback" },
  { phase: "ended", requestUuid: "request-uuid", payload: "complete callback" },
])(
  "preserves callback-owned identity when initiation settles after the call is $phase ($payload)",
  async ({ phase, requestUuid }) => {
    const placement = delayedOperation<InitiateCallResult>();
    const playback = vi.fn(async () => {});
    const ctx = contextWith({ initiateCall: placement.invoke, playTts: playback });
    const parser = new PlivoProvider({ authId: "MA-fixture", authToken: "synthetic-token" });
    const pending = initiateCall(ctx, "+15550000001");
    try {
      await Promise.race([placement.started, pending]);
      const call = expectDefined([...ctx.activeCalls.values()][0], "pending outbound call");
      const deliver = async (fields: Record<string, string>) => {
        const parsed = parser.parseWebhookEvent({
          headers: {},
          method: "POST",
          url: `https://example.com/voice/webhook?callId=${call.callId}`,
          query: { callId: call.callId },
          rawBody: new URLSearchParams({
            CallUUID: "canonical-call-uuid",
            ...(requestUuid ? { RequestUUID: requestUuid } : {}),
            Direction: "outbound",
            ...fields,
          }).toString(),
        });
        expect(parsed.events).toHaveLength(1);
        for (const event of parsed.events) {
          await processEvent(ctx, event);
        }
      };
      await deliver({ CallStatus: "in-progress" });
      expect(call.providerCallId).toBe("canonical-call-uuid");
      if (phase === "ended") {
        await deliver({ CallStatus: "completed" });
      }
      const beforeResult = await getCallHistoryFromStore(ctx.storePath);

      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await expect(pending).resolves.toEqual({ callId: call.callId, success: true });
      expect(call.providerCallId).toBe("canonical-call-uuid");

      if (phase === "active") {
        await deliver({ CallStatus: "in-progress", Speech: "Continue the connected call." });
        await expect(speak(ctx, call.callId, "Still connected.")).resolves.toEqual({
          success: true,
        });
        expect(playback).toHaveBeenCalledWith(
          expect.objectContaining({ callId: call.callId, providerCallId: "canonical-call-uuid" }),
        );
        expect(ctx.providerCallIdMap).toEqual(new Map([["canonical-call-uuid", call.callId]]));
      } else {
        expect(await getCallHistoryFromStore(ctx.storePath)).toEqual(beforeResult);
        expect([ctx.activeCalls.size, ctx.providerCallIdMap.size]).toEqual([0, 0]);
      }
    } finally {
      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await pending;
    }
  },
);

it("keeps outbound capacity available after storage failure without dialing", async () => {
  const placement = delayedOperation<InitiateCallResult>();
  const ctx = contextWith({ initiateCall: placement.invoke });
  ctx.config.maxConcurrentCalls = 1;
  const statePath = path.join(ctx.storePath, "state");
  fs.writeFileSync(statePath, "block the database directory");

  await expect(initiateCall(ctx, "+15550000001")).rejects.toMatchObject({
    code: "PLUGIN_STATE_OPEN_FAILED",
  });
  expect(placement.invoke).not.toHaveBeenCalled();
  expect([ctx.activeCalls.size, ctx.providerCallIdMap.size]).toEqual([0, 0]);

  fs.unlinkSync(statePath);
  const recovered = initiateCall(ctx, "+15550000001");
  try {
    await expect(initiateCall(ctx, "+15550000002")).resolves.toMatchObject({
      success: false,
      error: "Maximum concurrent calls (1) reached",
    });
    await Promise.race([placement.started, recovered]);
    expect(placement.invoke).toHaveBeenCalledOnce();
  } finally {
    placement.resolve({ providerCallId: "provider-recovered", status: "initiated" });
    await recovered;
  }
  const result = await recovered;
  expect(result.success).toBe(true);
  expect(ctx.activeCalls.size).toBe(1);
  expect(ctx.providerCallIdMap.get("provider-recovered")).toBe(result.callId);
  expect(
    (await loadActiveCallsFromStore(ctx.storePath)).activeCalls.get(result.callId),
  ).toMatchObject({
    providerCallId: "provider-recovered",
    state: "initiated",
  });
});

it.each([
  { phase: "terminal", playbackFails: false },
  { phase: "terminal", playbackFails: true },
  { phase: "replaced", playbackFails: false },
  { phase: "replaced", playbackFails: true },
] as const)(
  "does not rewrite a $phase call after delayed playback (failure=$playbackFails)",
  async ({ phase, playbackFails }) => {
    const playback = delayedOperation<void>();
    const ctx = contextWith({ playTts: playback.invoke });
    const started = await initiateCall(ctx, "+15550000001");
    expect(started.success).toBe(true);
    const call = expectDefined(ctx.activeCalls.get(started.callId), "connected outbound call");
    const pending = speak(ctx, call.callId, "Pending playback");
    const replacement = { ...structuredClone(call), state: "active" as const };
    let historyBeforeSettlement: Awaited<ReturnType<typeof getCallHistoryFromStore>>;
    try {
      await Promise.race([playback.started, pending]);
      if (phase === "terminal") {
        await processEvent(ctx, {
          id: "ended-during-playback",
          type: "call.ended",
          callId: call.callId,
          providerCallId: call.providerCallId,
          timestamp: Date.now(),
          reason: "completed",
        });
      } else {
        ctx.activeCalls.set(call.callId, replacement);
      }
      historyBeforeSettlement = await getCallHistoryFromStore(ctx.storePath);
    } finally {
      if (playbackFails) {
        playback.reject(new Error("playback interrupted"));
      } else {
        playback.resolve();
      }
      await pending;
    }
    await expect(pending).resolves.toEqual({
      success: false,
      error: playbackFails ? "playback interrupted" : "Call has ended",
    });
    expect(await getCallHistoryFromStore(ctx.storePath)).toEqual(historyBeforeSettlement);
    if (phase === "terminal") {
      expect(ctx.activeCalls.has(call.callId)).toBe(false);
      expect(call.state).toBe("completed");
    } else {
      expect(ctx.activeCalls.get(call.callId)).toBe(replacement);
      expect(replacement.state).toBe("active");
      expect(replacement.transcript).toEqual([]);
    }
  },
);
