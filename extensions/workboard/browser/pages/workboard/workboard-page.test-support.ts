import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  ControlUiComponents,
  ControlUiSessionListResult,
} from "openclaw/plugin-sdk/control-ui";
import { afterEach, expect, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { createViewContext } from "../../test/host.ts";
import { afterWorkboardUpdate as settle } from "../../test/settle.ts";
import { createWorkboardPage } from "./workboard-page.tsx";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

export function mountPage(
  params: { boardId?: string; connected?: boolean; presented?: boolean } = {},
) {
  const fixture = workboardTestHost();
  const hostListeners = fixture.listeners.size;
  const workboard = createWorkboardCapability();
  fixture.connection.connected = params.connected ?? false;
  Object.assign(fixture.host.agents, { rows: [], defaultId: null });
  let agents: AgentsListResult["agents"] = [{ id: "main" }, { id: "writer" }];
  let cards = [createWorkboardCard({ title: "Initial card" })];
  const request = vi.fn(async (method: string, requestParams?: unknown): Promise<unknown> => {
    if (method === "agents.list") {
      return { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [...agents] };
    }
    if (method === "workboard.cards.list") {
      return { cards };
    }
    if (method === "workboard.boards.upsert") {
      return {
        board: { ...(requestParams as Record<string, unknown>), createdAt: 1, updatedAt: 1 },
      };
    }
    return {};
  });
  fixture.host.request = request as typeof fixture.host.request;
  fixture.host.agents.refresh = vi.fn(async () => {
    const result = await fixture.host.request<AgentsListResult>("agents.list", {});
    Object.assign(fixture.host.agents, { rows: result.agents, defaultId: result.defaultId });
    fixture.notify();
  });
  const container = document.createElement("div");
  document.body.append(container);
  let context = createViewContext<Readonly<Record<string, string>>>(
    fixture.host,
    params.boardId ? { boardId: params.boardId } : {},
    params.presented ?? true,
  );
  const registerBoardNavigation = vi.fn();
  const mounted = createWorkboardPage(workboard, registerBoardNavigation)(container, context);
  cleanup.push(() => {
    mounted?.dispose?.();
    workboard.dispose();
  });
  return {
    fixture,
    hostListeners,
    workboard,
    container,
    request,
    registerBoardNavigation,
    cards(next: typeof cards) {
      cards = next;
    },
    agents(next: typeof agents) {
      agents = next;
    },
    navigate(boardId: string) {
      context = { ...context, props: { boardId } };
      mounted?.update?.(context);
    },
    present(presented: boolean) {
      context = { ...context, presented };
      mounted?.update?.(context);
    },
    dispose() {
      mounted?.dispose?.();
    },
  };
}

function requiredElement<T extends Element>(container: Element, selector: string) {
  return expectDefined(container.querySelector<T>(selector), selector);
}

export async function openBoardEditor(page: ReturnType<typeof mountPage>) {
  await settle(() => expect(page.workboard.state.loaded).toBe(true));
  requiredElement<HTMLButtonElement>(page.container, 'button[aria-label="Edit board"]').click();
  return settle(() => requiredElement<HTMLFormElement>(page.container, ".workboard-board-draft"));
}

export async function openSessionTab(page: ReturnType<typeof mountPage>) {
  const tab = await settle(() =>
    expectDefined(
      [...page.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (candidate) => candidate.textContent?.trim() === "Session",
      ),
      "session tab",
    ),
  );
  tab.click();
}

export function observeSessions(
  page: ReturnType<typeof mountPage>,
  result: ControlUiSessionListResult,
) {
  return vi.mocked(page.fixture.host.sessions.observe).mockImplementation((_query, listener) => {
    listener({ result, loading: false, error: null });
    return { refresh: vi.fn(async () => undefined), dispose: vi.fn() };
  });
}

export function openSessionButton(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Open session",
  );
}

export function visibleToast(container: Element) {
  return container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])");
}

export function sessionPicker(container: Element) {
  type SelectProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];
  return [
    ...container.querySelectorAll<HTMLElement & SelectProps>(
      ".workboard-draft [data-test-select-picker]",
    ),
  ].find((picker) => picker.accessibleLabel === "Session");
}
