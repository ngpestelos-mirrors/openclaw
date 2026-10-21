/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import * as uuid from "../../lib/uuid.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext as createCustodianContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import "./custodian-page.tsx";

const roster = {
  defaultId: "main",
  mainKey: "main",
  scope: "global",
  agents: ["main", "researcher"].map((id) => ({ id, model: { primary: "openai/gpt-5.5" } })),
} satisfies NonNullable<ApplicationContext["agents"]["state"]["agentsList"]>;

function createContext(request: Parameters<typeof createCustodianContext>[0]) {
  const calls: string[] = [];
  const setSessionKey = vi.fn((sessionKey: string) => calls.push(`session:${sessionKey}`));
  const setAgent = vi.fn((agentId: string | null) => calls.push(`agent:${agentId}`));
  const refreshList = vi.fn().mockResolvedValue({
    ...roster,
    agents: roster.agents.map(({ id }) => ({ id })),
  });
  const harness = createCustodianContext(request, ["openclaw.chat"], {
    agentsList: roster,
  });
  const context = {
    ...harness.context,
    gateway: { ...harness.context.gateway, setSessionKey },
    agents: { ...harness.context.agents, refreshList },
    agentSelection: { ...harness.context.agentSelection, set: setAgent },
  } satisfies ApplicationContext;
  return { calls, context, refreshList, setAgent, setSessionKey };
}

async function mountPage(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page");
  page.store = new CustodianSessionStore();
  page.onboarding = false;
  page.newAgentIntent = true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

describe("custodian new-agent flow", () => {
  let request: ReturnType<typeof vi.fn>;
  let harness: ReturnType<typeof createContext>;
  const response = {
    sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
    action: "none",
  };
  beforeEach(() => {
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    request = vi.fn();
    harness = createContext(request);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("explains the missing capability and scope before sending an agent creation request", async () => {
    const { context } = harness;
    context.gateway.snapshot.hello = {
      ...context.gateway.snapshot.hello!,
      auth: { role: "operator", scopes: ["operator.read"] },
    };

    const page = await mountPage(context);
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    const error = page.querySelector('[role="alert"]')?.textContent;
    expect(error).toContain("openclaw.chat");
    expect(error).toContain("operator.admin");
    expect(error).toContain("Pair");
    expect(error).toContain("reconnect");
    expect(error).not.toContain("Update the Gateway");
  });

  it("refreshes the roster and opens the created agent hatch session", async () => {
    request.mockResolvedValue({
      ...response,
      reply: "Your agent is hatching.",
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
    const { calls, context, refreshList, setAgent, setSessionKey } = harness;
    await mountPage(context);

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "new-agent" });
    expect(refreshList).toHaveBeenCalledOnce();
    expect(setAgent).toHaveBeenCalledWith("researcher");
    expect(setSessionKey).toHaveBeenCalledWith("agent:researcher:main");
    expect(calls).toEqual(["agent:researcher", "session:agent:researcher:main"]);
    expect(context.navigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/researcher",
      search: "?draft=Wake%20up%2C%20my%20friend!",
    });
  });

  it("hands model-account setup to the existing human Profile controls", async () => {
    request.mockResolvedValue({
      ...response,
      reply: "Open Settings → Profile → Connected accounts to connect your account.",
      handoff: { kind: "model-accounts" },
    });
    const { context, refreshList, setAgent, setSessionKey } = harness;
    const client = context.gateway.snapshot.client;
    await mountPage(context);

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("profile"));
    expect(context.gateway.snapshot.client).toBe(client);
    expect(refreshList).not.toHaveBeenCalled();
    expect(setAgent).not.toHaveBeenCalled();
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat"]);
  });
});
