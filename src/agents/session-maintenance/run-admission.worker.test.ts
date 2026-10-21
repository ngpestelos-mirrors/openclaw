import { copyFileSync, renameSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { waitForSessionMaintenance } from "./coordinator.js";
import { scheduleSessionMaintenance } from "./run.js";

const memory = vi.hoisted(() => ({
  runMemoryFlushIfNeeded: vi.fn(async () => ({})),
  runSessionCompactionIfNeeded: vi.fn(async () => {}),
}));
// mock-isolation: Admission uses real stores and workers; optional model/persistence effects stay inert.
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: async () => memory,
  loadSessionStoreRuntime: () => import("../command/session-store.runtime.js"),
}));

beforeEach(() => {
  memory.runMemoryFlushIfNeeded.mockReset();
  memory.runSessionCompactionIfNeeded.mockReset();
});

async function setup(env: NodeJS.ProcessEnv, sessionId: string) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const sessionKey = `agent:main:${sessionId}`;
  const entry = { sessionId, lifecycleRevision: "initial", updatedAt: 1 };
  writeSessionEntry(database, sessionKey, entry);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const scope = { agentId: "main", sessionKey, sessionId, storePath: database.path };
  const request = {
    prepared: { cfg: {}, sessionKey, storePath: database.path, timeoutMs: 60_000 },
    followupRun: createTestFollowupRun({ sessionKey, sessionId }),
    sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    startedAt: Date.now(),
  };
  const schedule = (
    afterOwnerSettles?: Promise<boolean>,
    resolveGatewayContext?: () => GatewayRequestContext | undefined,
  ) =>
    withPluginRuntimeGatewayRequestScope(
      {
        pluginRegistry: createEmptyPluginRegistry(),
        resolveGatewayContext,
        isWebchatConnect: () => false,
      },
      () => scheduleSessionMaintenance(request, afterOwnerSettles),
    );
  return { scope, entry, schedule };
}

it("rejects a replacement database while waiting for the foreground owner", async () => {
  await withOpenClawTestState({ label: "maintenance-worker-source" }, async ({ env, path }) => {
    const { scope, entry, schedule } = await setup(env, "maintenance-source");
    const replacementPath = path("replacement.sqlite");
    copyFileSync(scope.storePath, replacementPath);
    const predecessor = createDeferred<boolean>();
    try {
      schedule(predecessor.promise);
      renameSync(scope.storePath, path("original.sqlite"));
      renameSync(replacementPath, scope.storePath);
      expect(await entryReads.readSessionEntryReadOnlyInWorker({ ...scope, env })).toMatchObject(
        entry,
      );
      predecessor.resolve(true);
      await waitForSessionMaintenance(scope.sessionKey);
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      expect(memory.runSessionCompactionIfNeeded).not.toHaveBeenCalled();
      schedule();
      await waitForSessionMaintenance(scope.sessionKey);
      expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledOnce();
    } finally {
      predecessor.resolve(false);
      await waitForSessionMaintenance(scope.sessionKey);
    }
  });
});

it.each([
  "completed-owner",
  "unsuccessful-owner",
  "gateway-lifecycle-retired",
  "gateway-instance-retired",
  "session-replaced",
  "gateway-lifecycle-retired-during-flush",
  "gateway-instance-retired-during-flush",
] as const)("fences scheduled effects for %s", async (mode) => {
  await withOpenClawTestState({ label: `maintenance-${mode}` }, async ({ env }) => {
    const { scope, entry, schedule } = await setup(env, mode);
    const predecessor = createDeferred<boolean>();
    const flushStarted = createDeferred();
    const releaseFlush = createDeferred();
    const duringFlush = mode.endsWith("-during-flush");
    if (duringFlush) {
      memory.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
        flushStarted.resolve();
        await releaseFlush.promise;
        return {};
      });
    }
    let gatewayLive = true;
    const gatewayContext = {
      resolveGatewayContext: (): GatewayRequestContext | undefined =>
        gatewayLive ? gatewayContext : undefined,
    } as GatewayRequestContext;
    const retireGateway = () => {
      if (mode.startsWith("gateway-lifecycle-retired")) {
        rotateAgentEventLifecycleGeneration();
      } else if (mode.startsWith("gateway-instance-retired")) {
        gatewayLive = false;
      }
    };
    try {
      expect(gatewayContext.resolveGatewayContext?.()).toBe(gatewayContext);
      schedule(predecessor.promise, () => gatewayContext);
      await Promise.resolve();
      expect(memory.runMemoryFlushIfNeeded).not.toHaveBeenCalled();
      if (!duringFlush) {
        retireGateway();
      }
      if (mode === "session-replaced") {
        await replaceSessionEntry(scope, { ...entry, lifecycleRevision: "replacement" });
      }
      predecessor.resolve(mode !== "unsuccessful-owner");
      if (duringFlush) {
        await Promise.race([flushStarted.promise, waitForSessionMaintenance(scope.sessionKey)]);
        expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledOnce();
        retireGateway();
        releaseFlush.resolve();
      }
      await waitForSessionMaintenance(scope.sessionKey);
      expect(memory.runMemoryFlushIfNeeded).toHaveBeenCalledTimes(
        mode === "completed-owner" || duringFlush ? 1 : 0,
      );
      expect(memory.runSessionCompactionIfNeeded).toHaveBeenCalledTimes(
        mode === "completed-owner" ? 1 : 0,
      );
    } finally {
      predecessor.resolve(false);
      releaseFlush.resolve();
      await waitForSessionMaintenance(scope.sessionKey);
    }
  });
});

it("lets an admitted turn read before its queued maintenance, while external drains wait for cleanup", async () => {
  await withOpenClawTestState({ label: "maintenance-queued-read" }, async ({ env }) => {
    const { scope, schedule } = await setup(env, "maintenance-queued-read");
    const flushStarted = createDeferred();
    const releaseFlush = createDeferred();
    const events: string[] = [];
    memory.runMemoryFlushIfNeeded.mockImplementationOnce(async () => {
      events.push("flush");
      flushStarted.resolve();
      await releaseFlush.promise;
      return {};
    });
    memory.runSessionCompactionIfNeeded.mockImplementationOnce(async () => {
      events.push("compaction");
    });
    try {
      await withSessionTurn(scope, async () => {
        schedule();
        const checkpoint = waitForSessionMaintenance(scope.sessionKey).then(() => {
          events.push("read");
        });
        // Both admission and the checkpoint have only no-I/O continuations before blocking.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(events).toEqual(["read"]);
        await checkpoint;
      });
      const drained = waitForSessionMaintenance(scope.sessionKey).then(() =>
        events.push("drained"),
      );
      await flushStarted.promise;
      expect(events).toEqual(["read", "flush"]);
      releaseFlush.resolve();
      await drained;
      expect(events).toEqual(["read", "flush", "compaction", "drained"]);
    } finally {
      releaseFlush.resolve();
      await waitForSessionMaintenance(scope.sessionKey);
    }
  });
});
