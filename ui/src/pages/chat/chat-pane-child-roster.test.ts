/* @vitest-environment jsdom */

import { expect, it, onTestFinished } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  createPaneHeaderWorkspaceFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { SubagentRoster } from "./chat-spawned-subagent.ts";

type ChildRosterPane = TestChatPane & {
  resolveChatReadTarget: () => { sessionKey: string; agentId?: string } | undefined;
  projectChildRoster: (
    target: { sessionKey: string; agentId?: string } | undefined,
  ) => SubagentRoster;
};

it("counts header subagents without projecting transcript history or child activity", () => {
  const { pane, state } = createTestChatPane({ client: createGatewayBrowserClientFixture() });
  const unread = () => {
    throw new Error("Header must not read history or child activity");
  };
  state.chatMessages = new Proxy([{ role: "user", content: "Delegate the check." }], {
    get: unread,
  });
  const child: GatewaySessionRow = {
    key: "agent:main:subagent:check",
    kind: "direct",
    spawnedBy: state.sessionKey,
    hasActiveRun: true,
    get observerDigest() {
      return unread();
    },
  };
  Reflect.set(pane.swarm, "hydrator", { rows: [child], hydrated: true, childrenRead: true });
  const header = pane.renderPaneHeader(
    createPaneHeaderWorkspaceFixture(state),
    { key: state.sessionKey, kind: "direct", hasActiveSubagentRun: true, startedAt: 1, endedAt: 2 },
    false,
    undefined,
    false,
    null,
  );
  Reflect.set(pane.swarm, "hydrator", null);
  expect(header.header.runningSubagentCount).toBe(1);
});

it.each([
  { routeKey: "global", mainKey: "main", scope: "global", parentKey: "agent:work:global" },
  { routeKey: "primary", mainKey: "primary", scope: "per-sender", parentKey: "agent:work:primary" },
] as const)(
  "projects children for admitted $routeKey ancestry",
  ({ routeKey, mainKey, scope, parentKey }) => {
    const { pane: host, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
    });
    const pane = host as ChildRosterPane;
    Object.assign(state, {
      sessionKey: routeKey,
      assistantAgentId: "work",
      agentsList: { defaultId: "work", mainKey, scope, agents: [] },
    });
    const child = {
      key: "agent:work:subagent:diagnostic",
      kind: "direct",
      spawnedBy: parentKey,
    } satisfies GatewaySessionRow;
    Reflect.set(pane.swarm, "hydrator", { rows: [child], hydrated: true, childrenRead: true });
    onTestFinished(() => void Reflect.set(pane.swarm, "hydrator", null));
    Reflect.set(pane.swarm, "enabled", false);
    const roster = pane.projectChildRoster(pane.resolveChatReadTarget());
    expect(roster).toMatchObject({
      subagentParentKey: parentKey,
      subagentSessions: [child],
      subagentSessionsHydrated: true,
      subagentSessionsRead: true,
    });
    expect(pane.projectChildRoster(undefined)).toMatchObject({
      subagentParentKey: undefined,
      subagentSessions: undefined,
      subagentSessionsHydrated: false,
      subagentSessionsRead: false,
    });
  },
);
