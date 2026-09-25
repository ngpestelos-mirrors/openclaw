// Verifies session descriptions stay with the selected TUI conversation.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiBackend } from "./tui-backend.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import { resolveRememberedTuiSessionKey } from "./tui-last-session.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";

describe("TUI session description ownership", () => {
  it("includes the global row when refreshing a global session", async () => {
    const describeSession = vi.fn().mockResolvedValue({
      defaults: {},
      session: { key: "global", updatedAt: 1 },
    });
    const state = createBaseState({
      currentSessionKey: "global",
      sessionScope: "global",
    });

    const { refreshSessionInfo } = createTestSessionActions({
      client: makeTuiBackend({ describeSession }),
      state,
    });

    await refreshSessionInfo();

    expect(describeSession).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "main",
    });
  });

  it.each([
    { selectedKey: "global", returnedKey: "global", accepted: true },
    { selectedKey: "global", returnedKey: "agent:work:global", accepted: true },
    { selectedKey: "agent:work:global", returnedKey: "agent:work:global", accepted: true },
    { selectedKey: "global", returnedKey: "agent:main:global", accepted: false },
    { selectedKey: "agent:work:global", returnedKey: "agent:main:global", accepted: false },
  ])(
    "keeps the selected owner when describing $selectedKey as $returnedKey",
    async ({ selectedKey, returnedKey, accepted }) => {
      const describeSession = vi.fn().mockResolvedValue({
        defaults: {},
        session: {
          key: returnedKey,
          sessionId: "described-session",
          displayName: "Updated conversation",
          updatedAt: 1,
        },
      });
      const state = createBaseState({
        currentAgentId: "work",
        currentSessionKey: selectedKey,
        currentSessionId: "selected-session",
        sessionScope: "global",
        sessionInfo: { displayName: "Selected conversation" },
      });
      const { refreshSessionInfo } = createTestSessionActions({
        client: makeTuiBackend({ describeSession }),
        state,
      });

      await refreshSessionInfo();

      expect(describeSession).toHaveBeenCalledWith({
        sessionKey: selectedKey,
        ...(selectedKey === "global" ? { agentId: "work" } : {}),
      });
      expect(state).toMatchObject({
        currentAgentId: "work",
        currentSessionKey: accepted ? returnedKey : selectedKey,
        currentSessionId: accepted ? "described-session" : "selected-session",
        sessionInfo: {
          displayName: accepted ? "Updated conversation" : "Selected conversation",
        },
      });
    },
  );
});

describe("TUI ownership through the next submission", () => {
  it("retires a late previous-agent lookup and rejects a conflicting owner before sending", async () => {
    const submit = createTuiCommandHandlersHarness();
    const state = Object.assign(
      submit.state,
      createBaseState({ currentSessionKey: "agent:main:topic", currentAgentId: "main" }),
    );
    const previous = createDeferred<Awaited<ReturnType<TuiBackend["describeSession"]>>>();
    const describeSession = vi
      .fn<TuiBackend["describeSession"]>()
      .mockImplementationOnce(() => previous.promise)
      .mockResolvedValue({
        defaults: {},
        session: { key: "agent:main:topic", sessionId: "wrong-owner", updatedAt: 1 },
      });
    const actions = createTestSessionActions({
      state,
      client: makeTuiBackend({ describeSession }),
      resolveSessionSelection: (raw) => ({
        key: raw ?? "agent:work:topic",
        agentId: parseAgentSessionKey(raw)?.agentId ?? "work",
      }),
    });
    const refresh = actions.refreshSessionInfo();
    const switched = actions.setSession("agent:work:topic");
    previous.resolve({
      defaults: {},
      session: { key: "agent:main:topic", sessionId: "retired-owner", updatedAt: 1 },
    });
    await Promise.all([refresh, switched]);
    expect(state.currentAgentId).toBe("work");
    expect(state.currentSessionKey).toBe("agent:work:topic");
    await submit.sendMessage("owner selection proof");
    expect(submit.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:work:topic", message: "owner selection proof" }),
    );
  });

  it("restores only the current agent's saved suffix before the next submission", async () => {
    const submit = createTuiCommandHandlersHarness();
    const state = Object.assign(
      submit.state,
      createBaseState({ currentSessionKey: "agent:work:main", currentAgentId: "work" }),
    );
    const restored = resolveRememberedTuiSessionKey({
      rememberedKey: "topic",
      currentAgentId: "work",
      sessions: [
        { key: "agent:main:topic", updatedAt: 2 },
        { key: "agent:work:topic", updatedAt: 1 },
      ],
    });
    const actions = createTestSessionActions({
      state,
      client: makeTuiBackend({
        describeSession: async ({ sessionKey }) => ({
          defaults: {},
          session: { key: sessionKey, updatedAt: 1 },
        }),
      }),
      resolveSessionSelection: (raw) => ({
        key: raw ?? "agent:work:main",
        agentId: parseAgentSessionKey(raw)?.agentId ?? "work",
      }),
    });
    expect(restored).toBe("agent:work:topic");
    if (!restored) {
      throw new Error("expected current-owner restore");
    }
    await actions.setSession(restored);
    await submit.sendMessage("remembered owner proof");
    expect(state.currentAgentId).toBe("work");
    expect(submit.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:work:topic",
        message: "remembered owner proof",
      }),
    );
  });
});
