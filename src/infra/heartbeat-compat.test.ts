import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  applyLegacyHeartbeatPromptContribution,
  setLegacyHeartbeatsEnabled,
} from "./heartbeat-compat.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

const fixture = vi.hoisted(() => ({
  receipt: { phase: "complete", jobId: "converted" } as
    | { phase: string; jobId: string }
    | undefined,
  context: undefined as unknown,
  hook: vi.fn(),
  hasHooks: true,
  readReceipts: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("../agents/agent-scope.js", () => ({ listAgentIds: () => ["main"] }));
vi.mock("../cron/proactive-job-receipt.js", () => ({
  readDefaultProactiveJobReceiptsAsync: fixture.readReceipts,
}));
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () =>
    fixture.context ? { context: fixture.context } : undefined,
}));
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
  }),
  enqueueSessionEventForHost: fixture.enqueue,
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: () => fixture.hasHooks,
    runHeartbeatPromptContribution: fixture.hook,
  }),
}));

beforeEach(() => {
  fixture.receipt = { phase: "complete", jobId: "converted" };
  fixture.context = undefined;
  fixture.hook.mockReset();
  fixture.hasHooks = true;
  fixture.readReceipts
    .mockReset()
    .mockImplementation(async () => (fixture.receipt ? { main: fixture.receipt } : {}));
  fixture.enqueue.mockReset();
});

describe("deprecated heartbeat job adapters", () => {
  it("controls receipt-owned jobs only and never recreates a deleted job", async () => {
    const update = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValue([makeCronJob({ id: "converted" }), makeCronJob({ id: "unrelated" })]);
    const cron = {
      list,
      update,
    } as unknown as CronServiceContract;
    await setLegacyHeartbeatsEnabled({}, cron, false);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      "converted",
      { enabled: false },
      { commitGuard: undefined },
    );
    list.mockResolvedValue([]);
    await expect(setLegacyHeartbeatsEnabled({}, cron, true)).rejects.toThrow(
      "deleted jobs are not recreated",
    );
    expect(update).toHaveBeenCalledOnce();
  });

  it("reports this exact run's terminal failure instead of a latest-row success", async () => {
    const job = makeCronJob({ id: "converted", agentId: "main", state: { lastStatus: "ok" } });
    const run = vi.fn(async (_id, _mode, options) => {
      options.onSettledResult({ status: "error", error: "provider failed" });
      return { ok: true, ran: true };
    });
    fixture.context = { getRuntimeConfig: () => ({}), cron: { list: async () => [job], run } };
    await expect(runHeartbeatOnce({ agentId: "main" })).resolves.toEqual({
      status: "failed",
      reason: "provider failed",
    });
  });

  it("reports missing migrated jobs and unavailable Gateway without creating replacements", async () => {
    await expect(runHeartbeatOnce()).resolves.toMatchObject({ status: "failed" });
    expect(() => requestHeartbeat({ source: "manual", intent: "event" })).toThrow("live Gateway");
    fixture.context = { getRuntimeConfig: () => ({}), cron: { list: async () => [] } };
    await expect(runHeartbeatOnce({ heartbeat: { target: "last" } })).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("converted/default proactive automation"),
    });
  });

  it("routes immediate SDK wakes through an ordinary session-event receipt", async () => {
    fixture.context = { getRuntimeConfig: () => ({}) };
    const admitted = createDeferredCore();
    fixture.enqueue.mockImplementation(() => {
      admitted.resolve();
      return {
        id: "event-run",
        cancel: () => false,
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      };
    });
    requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "plugin completed",
      agentId: "main",
      sessionKey: "agent:main:main",
      heartbeat: { target: "none" },
    });
    await admitted.promise;
    expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith("plugin completed", {
      agentId: "main",
      sessionKey: "agent:main:main",
      source: "plugin",
      expectedTarget: expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: false,
      }),
      assertCurrent: expect.any(Function),
    });
  });

  it("invokes the historical prompt hook only for a converted/default job and caps its contribution", async () => {
    const params = {
      cfg: {},
      jobId: "unrelated",
      name: "check",
      agentId: "main",
      sessionKey: "agent:main:main",
      prompt: "check",
      assertCurrent: vi.fn(),
    };
    expect(await applyLegacyHeartbeatPromptContribution(params)).toBe("check");
    expect(fixture.hook).not.toHaveBeenCalled();
    fixture.hook.mockResolvedValue({ appendContext: "x".repeat(20_000) });
    const prompt = await applyLegacyHeartbeatPromptContribution({ ...params, jobId: "converted" });
    expect(fixture.hook).toHaveBeenCalledOnce();
    expect(prompt).toContain("check");
    expect(prompt.length).toBeLessThan(5000);

    fixture.hasHooks = false;
    fixture.readReceipts.mockReset().mockRejectedValue(new Error("receipt store unavailable"));
    expect(await applyLegacyHeartbeatPromptContribution(params)).toBe("check");
    expect(fixture.readReceipts).not.toHaveBeenCalled();
  });
});
