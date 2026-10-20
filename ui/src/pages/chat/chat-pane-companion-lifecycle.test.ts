/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-companion-lifecycle.test/"} */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  createGatewayBrowserClientFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const companionThreads = (pane: TestChatPane) =>
  (pane as TestChatPane & { sessionCompanionThreads: ChatSessionCompanionThreads })
    .sessionCompanionThreads;

describe("chat pane companion connection lifecycle", () => {
  it("preserves threads while a same-client reconnect settles a pending answer", async () => {
    const consoleError = vi.spyOn(console, "error");
    onTestFinished(() => consoleError.mockRestore());
    const models: ModelCatalogEntry[] = [
      { id: "fixture-model", name: "Fixture model", provider: "test", available: true },
    ];
    const historyReady = createDeferred<void>();
    onTestFinished(() => historyReady.resolve());
    const replies: Record<string, () => unknown> = {
      "agents.list": () => ({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      }),
      "sessions.subscribe": () => ({ subscribed: true, list: sessionsResult([], 1) }),
      "sessions.messages.subscribe": () => ({ subscribed: true, key: "agent:main:current" }),
      "sessions.messages.unsubscribe": () => ({ subscribed: false, key: "agent:main:current" }),
      "models.authStatus": () => ({ ts: 1, providers: [] }),
      "models.list": () => ({ commands: [], models, swarmEnabled: false }),
      "chat.metadata": () => ({ commands: [], models, swarmEnabled: false }),
    };
    const request = createGatewayRequestMock(async (method) => {
      if (method === "chat.startup") {
        await historyReady.promise;
        return { messages: [], sessionId: "session-current", hasMore: false, totalMessages: 0 };
      }
      const reply = replies[method];
      if (Object.hasOwn(replies, method) && reply) {
        return reply();
      }
      throw new Error(`Unexpected gateway request: ${method}`);
    });
    const client = createGatewayBrowserClientFixture({ request });
    const { pane, state } = createTestChatPane({ client });
    state.loadAssistantIdentity = vi.fn(async () => undefined);
    onTestFinished(() => {
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        phase: "stopped",
        hello: null,
      });
      pane.disconnectedCallback();
    });
    const answer = createDeferred<{ answer: string; ts: number }>();
    const threads = companionThreads(pane);
    const earlier = { question: "Earlier question", answer: "Earlier answer", ts: 1 };
    await threads.hydrate(
      "agent:main:current",
      async () => ({ exchanges: [{ ...earlier }] }),
      "main",
    );
    const pending = threads.submit(
      "agent:main:current",
      "current question",
      () => answer.promise,
      "main",
    );
    threads.setDraft("agent:main:other", "other draft", "main");

    // GatewayProtocolClient flushes pending requests before publishing the
    // reconnecting snapshot; Promise rejection settles on the next microtask.
    answer.reject(new Error("gateway closed"));
    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });

    expect(threads.view("agent:main:current", "main").turns).toMatchObject([
      { ...earlier, status: "answered" },
      { question: "current question", status: "pending" },
    ]);
    expect(threads.view("agent:main:other", "main").draft).toBe("other draft");
    await pending;
    expect(threads.view("agent:main:current", "main")).toMatchObject({
      turns: [
        { ...earlier, status: "answered" },
        { question: "current question", status: "failed", hint: "unavailable", retryable: true },
      ],
    });

    pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "connected" });
    expect(state.chatModelsLoading).toBe(true);
    expect(threads.view("agent:main:other", "main").draft).toBe("other draft");
    await threads.hydrate(
      "agent:main:current",
      async () => ({
        exchanges: [
          { ...earlier },
          { question: "current question", answer: "Recovered answer", ts: 2 },
        ],
      }),
      "main",
    );
    expect(threads.view("agent:main:current", "main")).toMatchObject({
      turns: [
        { ...earlier, status: "answered" },
        { question: "current question", status: "answered", answer: "Recovered answer", ts: 2 },
      ],
    });
    await vi.waitFor(() => expect(state.chatModelsLoading).toBe(false));
    expect(consoleError).not.toHaveBeenCalled();
    expect(state.chatModelCatalog).toEqual(models);
    expect(state.chatModelCatalogError).toBeNull();
    const history = getChatHistoryLoadState(state);
    expect(history.phase).toBe("in-flight");
    historyReady.resolve();
    if (history.phase === "in-flight") {
      await history.promise;
    }
    expect(getChatHistoryLoadState(state).phase).toBe("committed");
    expect(state.chatError).toBeNull();
  });

  it("retires every thread and late answer when the Gateway client is replaced", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const replacement = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client });
    const threads = companionThreads(pane);
    const answer = createDeferred<{ answer: string; ts: number }>();
    const pending = threads.submit(
      "agent:main:current",
      "replace this question",
      () => answer.promise,
      "main",
    );
    threads.setDraft("agent:main:other", "replace this draft", "main");

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client: replacement,
      phase: "reconnecting",
      hello: null,
    });

    expect(threads.view("agent:main:current", "main")).toMatchObject({
      turns: [],
    });
    expect(threads.view("agent:main:other", "main").draft).toBe("");
    answer.resolve({ answer: "late answer", ts: 3 });
    await pending;
    expect(threads.view("agent:main:current", "main").turns).toMatchObject([]);
  });
});
