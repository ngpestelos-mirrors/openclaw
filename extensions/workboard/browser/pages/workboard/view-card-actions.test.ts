import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { render } from "@solidjs/web";
import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getWorkboardState } from "../../lib/workboard/runtime.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { CardDetailsPanel } from "./view-card-details.tsx";
import type { WorkboardProps } from "./view-helpers.tsx";

function renderDetails(card: WorkboardCard, overrides: Partial<WorkboardProps> = {}) {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  state.cards = [card];
  state.detailCardId = card.id;
  const [revision, setRevision] = createSignal(0);
  const props: WorkboardProps = {
    get revision() {
      return revision();
    },
    onRequestUpdate: () => setRevision((previous) => previous + 1),
    host,
    client: null,
    connected: true,
    canWrite: true,
    agentsList: null,
    sessions: [],
    onOpenSession: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  workboardTestHost().connection.connected = true;
  const dispose = render(() => createComponent(CardDetailsPanel, props), container);
  flush();
  onTestFinished(() => {
    dispose();
    container.remove();
  });
  const button = (selector: string) =>
    expectDefined(container.querySelector<HTMLButtonElement>(selector), selector);
  return { state, props, container, button };
}

describe("Workboard card execution actions", () => {
  it.each([
    ["agent:writer:existing", "unknown", true],
    ["agent:writer:existing", "unavailable", true],
    ["subagent:workboard-default-card-1", "unknown", false],
    ["subagent:workboard-default-card-1", "ambiguous", false],
    ["global", "unknown", false],
    ["unknown", "unknown", false],
  ] as const)(
    "keeps Edit recovery without replacement Start for %s (%s)",
    (key, status, canOpen) => {
      const card = createWorkboardCard({ sessionKey: key });
      const { container, state, props, button } = renderDetails(card, {
        sessionResolution: { key, status },
      });
      const open =
        Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
          (candidate) => candidate.textContent?.trim() === "Open session",
        ) ?? null;
      if (canOpen) {
        expectDefined(open, "canonical session action").click();
        expect(props.onOpenSession).toHaveBeenCalledWith({ sessionKey: key });
      } else {
        expect(open).toBeNull();
      }
      button('button[aria-label="Edit card"]').click();
      expect(state).toMatchObject({ draftOpen: true, draftSessionKey: key });
      expect(container.querySelectorAll(".workboard-card__start")).toHaveLength(0);
    },
  );

  it.each([
    {
      key: "subagent:workboard-default-card-1",
      sessionKey: "agent:writer:subagent:workboard-default-card-1",
    },
    { key: "agent:writer:existing", sessionKey: "agent:writer:existing", agentId: "writer" },
  ])(
    "stops the resolved $key owner after the card is reassigned",
    async ({ key, sessionKey, agentId }) => {
      const owner = { sessionKey, ...(agentId ? { agentId } : {}) };
      const session = createGatewaySession({ key: sessionKey, ...(agentId ? { agentId } : {}) });
      const card = createWorkboardCard({
        agentId: "main",
        sessionKey: key,
        status: "running",
        runId: "writer-run",
      });
      const blocked = { ...card, status: "blocked", updatedAt: 2 };
      let aborts = 0;
      const client = createWorkboardTestClient((method) => {
        if (method === "chat.abort") {
          aborts += 1;
          return { aborted: !agentId || aborts > 1 };
        }
        if (method === "workboard.cards.update") {
          return { card: blocked };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { button, state } = renderDetails(card, {
        client,
        sessionResolution: { key, status: "resolved", session },
      });

      button('button[aria-label="Stop session"]').click();
      await waitForFast(() => expect(state.cards[0]?.status).toBe("blocked"));

      expect(client.request).toHaveBeenNthCalledWith(1, "chat.abort", {
        ...owner,
        runId: "writer-run",
      });
      if (agentId) {
        expect(client.request).toHaveBeenNthCalledWith(2, "chat.abort", owner);
      }
      expect(state.error).toBeNull();
    },
  );

  it.each(["start", "stop"] as const)(
    "rejects a retained %s action after the card link changes",
    async (action) => {
      const session = createGatewaySession({ key: "agent:writer:original" });
      const card = createWorkboardCard(
        action === "stop" ? { sessionKey: session.key, status: "running" } : {},
      );
      const client = createWorkboardTestClient(() => {
        throw new Error("A retained action cannot operate on the replacement card");
      });
      const { button, state } = renderDetails(card, { client, sessions: [session] });
      const retained = button(
        action === "start" ? ".workboard-card__start--manual" : 'button[aria-label="Stop session"]',
      );
      const successor = {
        ...card,
        updatedAt: card.updatedAt + 1,
        sessionKey: "agent:writer:replacement",
      };
      state.cards = [successor];
      retained.click();
      await waitForFast(() => expect(state.error).toBeTruthy());

      expect(client.request).not.toHaveBeenCalled();
      expect(state.cards).toEqual([successor]);
      expect(state.busyCardIds.size).toBe(0);
    },
  );
});
