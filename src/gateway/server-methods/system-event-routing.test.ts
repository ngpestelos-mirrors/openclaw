/** Targeted system-event routing and wake behavior. */

import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG,
  SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
} from "../../../packages/gateway-protocol/src/schema.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
  loadGatewaySessionEntryReadOnly: vi.fn(),
}));

vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionEntryReadOnlyAsync: mocks.loadGatewaySessionEntryReadOnly,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    mocks.loadGatewaySessionEntryReadOnly(params.key, { agentId: params.agentId }),
}));

import { systemHandlers } from "./system.js";

const eventHandler = expectDefined(systemHandlers["system-event"], "system-event handler");
function eventRequest(
  params: GatewayRequestHandlerOptions["params"],
  respond = vi.fn(),
  config: OpenClawConfig = { agents: { entries: { main: {} } } },
): GatewayRequestHandlerOptions {
  return {
    params,
    respond,
    context: { publishPresence: vi.fn(), getRuntimeConfig: () => config },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("system-event routing", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    mocks.requestHeartbeat.mockReset();
    mocks.loadGatewaySessionEntryReadOnly.mockReset();
  });

  it("queues and immediately wakes the requested session", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({ entry: { sessionId: "session" } });
    const request = eventRequest(
      {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
    );

    await eventHandler(request);

    expect(peekSystemEvents(sessionKey)).toEqual(["OpenClaw updated. Welcome the user back."]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("wakes an unbound memory session and observes its next committed archive", async () => {
    const env = { OPENCLAW_STATE_DIR: "/synthetic/system-event-memory" };
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const sessionKey = "agent:main:dashboard:incognito-wake";
    const authority = { assertCurrent() {}, authorize() {} };
    const binding = await acquireSessionActorStorage(
      {
        agentId: "main",
        sessionKey,
        env,
        storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
      },
      { authority, lifetime: { assertCurrent() {}, assertReadable() {} }, create: true },
    );
    if (!binding) {
      throw new Error("Memory session fixture was not acquired");
    }
    try {
      expect(
        await binding.actor.storage.mutate(
          {
            type: "session.entry.create",
            input: {
              entry: { sessionId: "memory-wake", updatedAt: 1, incognito: true },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "committed" });
      const respond = vi.fn();
      const request = eventRequest(
        { text: "Synthetic memory wake", sessionKey, wake: true },
        respond,
      );
      const handler = eventHandler;
      await handler(request);
      expect(respond).toHaveBeenLastCalledWith(true, { ok: true }, undefined);
      expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
      expect(mocks.loadGatewaySessionEntryReadOnly).not.toHaveBeenCalled();
      expect(
        await binding.actor.storage.mutate(
          {
            type: "session.entry.patch",
            input: {
              operation: { kind: "fields", patch: { archivedAt: 2 } },
            },
          },
          authority,
        ),
      ).toMatchObject({ kind: "committed" });
      await handler(request);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: `Unknown or archived session "${sessionKey}"`,
        }),
      );
      expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      await binding.actor.release();
      memorySessionActorOwners.reset();
      vi.unstubAllEnvs();
    }
  });
  it("keeps ambient explicit-owner events on the global session queue", async () => {
    const respond = vi.fn();
    const request = eventRequest({ text: "Wake the system owner.", wake: true }, respond, {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, molty: {} },
      },
    });

    await eventHandler(request);

    expect(peekSystemEvents("agent:main:global")).toEqual(["Wake the system owner."]);
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      agentId: "main",
      sessionKey: "global",
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("rejects immediate wakes for unconfigured agents", async () => {
    const respond = vi.fn();
    const request = eventRequest(
      {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey: "agent:bogus:main",
        wake: true,
      },
      respond,
    );

    await eventHandler(request);

    expect(peekSystemEvents("agent:bogus:main")).toEqual([]);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'Unknown agent id "bogus"' }),
    );
  });

  it.each([undefined, 0, 1])(
    "rejects immediate wakes for missing or archived sessions (%s)",
    async (archivedAt) => {
      const respond = vi.fn();
      const sessionKey = "agent:main:missing";
      mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({
        entry: archivedAt === undefined ? undefined : { sessionId: "archived-session", archivedAt },
      });
      const request = eventRequest(
        {
          text: "OpenClaw updated. Welcome the user back.",
          sessionKey,
          wake: true,
        },
        respond,
      );

      await eventHandler(request);

      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: `Unknown or archived session "${sessionKey}"` }),
      );
    },
  );

  it("rejects wake requests mixed with node presence events", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    const request = eventRequest(
      {
        text: "Node: Operator Mac",
        deviceId: "device-1",
        sessionKey,
        wake: true,
      },
      respond,
    );

    await eventHandler(request);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.loadGatewaySessionEntryReadOnly).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "wake is not supported for node presence events" }),
    );
  });

  it("passes explicit input activity clearing into system presence", async () => {
    const instanceId = `presence-clear-${randomUUID()}`;

    await eventHandler(
      eventRequest({
        text: "Node: Operator Mac",
        instanceId,
        host: "Operator Mac",
        mode: "ui",
        lastInputSeconds: 5,
      }),
    );
    await eventHandler(
      eventRequest({
        text: "Node: Operator Mac",
        instanceId,
        host: "Operator Mac",
        mode: "ui",
        lastInputSeconds: SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
        tags: [SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG],
      }),
    );

    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.lastInputSeconds).toBeUndefined();
  });
});
