import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayCronReconciliation } from "./server-cron-reconciled.js";

type RunHook = Parameters<typeof createGatewayCronReconciliation>[0]["runHook"];

function createReconciliation(runHook: RunHook, isClosing = () => false) {
  const reconciliation = createGatewayCronReconciliation({
    port: 18789,
    workspaceDir: "/tmp/openclaw-workspace",
    isClosing,
    runHook,
  });
  return {
    ...reconciliation,
    arm(reason: "startup" | "reload", id: string = reason, enabled = true) {
      return reconciliation.arm({ reason, config: {}, cronState: createCronState(id, enabled) });
    },
    armSnapshot: reconciliation.arm,
  };
}

describe("gateway cron reconciliation lifecycle", () => {
  it("emits only the public snapshot fields and captures the reconciled service", async () => {
    const runHook = vi.fn<RunHook>(async () => undefined);
    const cron = { id: "startup-cron" };
    const config = { cron: { enabled: true } } as OpenClawConfig;
    const reconciliation = createReconciliation(runHook);
    const cronState = {
      cron,
      storePath: "/private/cron.json",
      cronEnabled: false,
    };
    const armed = reconciliation.armSnapshot({
      reason: "startup",
      config,
      cronState: cronState as never,
    });
    cronState.cron = { id: "replacement-cron" };
    await armed.complete();
    await armed.complete();

    expect(runHook).toHaveBeenCalledTimes(1);
    const [event, ctx] = runHook.mock.calls[0] ?? [];
    expect(event).toEqual({ reason: "startup", enabled: false });
    expect(Object.keys(event ?? {}).toSorted()).toEqual(["enabled", "reason"]);
    expect(ctx).toMatchObject({
      port: 18789,
      workspaceDir: "/tmp/openclaw-workspace",
      config,
    });
    expect(ctx?.getCron?.()).toBe(cron);
    expect(ctx?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(ctx?.abortSignal.aborted).toBe(false);
  });

  it("suppresses a startup completion superseded by reload", async () => {
    const runHook = vi.fn<RunHook>(async () => undefined);
    const reconciliation = createReconciliation(runHook);
    const startup = reconciliation.arm("startup");
    const reload = reconciliation.arm("reload");

    await startup.complete();
    await reload.complete();

    expect(runHook).toHaveBeenCalledTimes(1);
    expect(runHook.mock.calls[0]?.[0]).toEqual({ reason: "reload", enabled: true });
  });

  it("suppresses invalidated and shutdown completions", async () => {
    let closing = false;
    const runHook = vi.fn<RunHook>(async () => undefined);
    const reconciliation = createReconciliation(runHook, () => closing);
    const invalidated = reconciliation.arm("reload", "invalidated", true);
    reconciliation.invalidate();
    await invalidated.complete();

    const shutdown = reconciliation.arm("reload", "shutdown", false);
    closing = true;
    await shutdown.complete();

    expect(runHook).not.toHaveBeenCalled();
  });

  it("aborts a superseded snapshot without blocking the replacement", async () => {
    const startupGate = createDeferred();
    let startupSignal: AbortSignal | undefined;
    const order: string[] = [];
    const runHook = vi.fn<RunHook>(async (event, ctx) => {
      order.push(`${event.reason}:start`);
      if (event.reason === "startup") {
        startupSignal = ctx.abortSignal;
        await startupGate.promise;
      }
      order.push(`${event.reason}:end`);
    });
    const reconciliation = createReconciliation(runHook);
    const startup = reconciliation.arm("startup");
    const startupCompletion = startup.complete();
    await vi.waitFor(() => expect(order).toEqual(["startup:start"]));
    const reload = reconciliation.arm("reload");
    expect(startupSignal?.aborted).toBe(true);
    await reload.complete();

    expect(order).toEqual(["startup:start", "reload:start", "reload:end"]);
    startupGate.resolve();
    await startupCompletion;

    expect(order).toEqual(["startup:start", "reload:start", "reload:end", "startup:end"]);
  });

  it("aborts an active snapshot when reconciliation is invalidated", async () => {
    const hookGate = createDeferred();
    let activeSignal: AbortSignal | undefined;
    const runHook = vi.fn<RunHook>(async (_event, ctx) => {
      activeSignal = ctx.abortSignal;
      await hookGate.promise;
    });
    const reconciliation = createReconciliation(runHook);
    const armed = reconciliation.arm("startup");
    const completion = armed.complete();
    await vi.waitFor(() => expect(runHook).toHaveBeenCalledTimes(1));

    reconciliation.invalidate();
    expect(activeSignal?.aborted).toBe(true);
    hookGate.resolve();
    await completion;
  });
});

function createCronState(id: string, cronEnabled: boolean) {
  return {
    cron: { id },
    storePath: `/tmp/${id}.json`,
    cronEnabled,
  } as never;
}
