import { createComponent, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { selectWorkingClawSurprise } from "./chat-working-indicator-surprise.ts";
import { ChatWorkingIndicator } from "./chat-working-indicator.tsx";

const bubbleSelector = ".chat-bubble.chat-reading-indicator";
const variants = (bubble: Element) =>
  [...bubble.classList].filter((name) => name.startsWith("chat-reading-indicator--"));

type ChatWorkingIndicatorOptions = Parameters<typeof ChatWorkingIndicator>[0]["options"];

function mountIndicator(key: string, initial: ChatWorkingIndicatorOptions = {}) {
  const [options, setOptions] = createSignal(initial);
  const view = mountSolid(() =>
    createComponent(ChatWorkingIndicator, {
      part: { kind: "reading-indicator", key, startedAt: 1 },
      get options() {
        return options();
      },
    }),
  );
  flush();
  return {
    ...view,
    find: (selector: string) => view.container.querySelector(selector),
    draw: (next: ChatWorkingIndicatorOptions) => {
      setOptions(next);
      flush();
    },
  };
}

function findRenderKey(wantSurprise: boolean): string {
  for (let index = 0; index < 10_000; index++) {
    const key = `probe:${index}`;
    if (Boolean(selectWorkingClawSurprise(key)) === wantSurprise) {
      return key;
    }
  }
  throw new Error(`no render key with surprise=${String(wantSurprise)}`);
}

describe("ChatWorkingIndicator", () => {
  it("pops in for new work but continues a claw that another one just handed off", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const isContinued = (container: Element) =>
      container
        .querySelector(".chat-working-indicator")
        ?.classList.contains("chat-working-indicator--continued");
    const preview = mountIndicator("handoff");
    expect(isContinued(preview.container)).toBe(false);
    preview.unmount();
    now.mockReturnValue(10_200);
    const chat = mountIndicator("handoff");
    expect(isContinued(chat.container)).toBe(true);
  });

  it("promotes child activity above supporting totals and restores the standalone glyph", async () => {
    const { draw, find } = mountIndicator("task-first", { outputTokens: 4_100 });
    expect(find(bubbleSelector)).not.toBeNull();
    const session: GatewaySessionRow = {
      key: "agent:main:subagent:x",
      kind: "direct",
      updatedAt: 1,
    };
    draw({
      outputTokens: 4_100,
      subagentActivity: {
        rows: [{ key: session.key, label: "Task", status: "running", listed: true, session }],
      },
    });
    await vi.dynamicImportSettled();
    flush();
    const task = find(".chat-subagent-activity");
    const status = find(".chat-working-indicator");
    expect(task).not.toBeNull();
    expect(status?.classList.contains("chat-working-indicator--supporting")).toBe(true);
    expect(task!.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(find(bubbleSelector)).toBeNull();
    expect(status?.textContent).toContain("4.1k output tokens");
    draw({ outputTokens: 4_100 });
    expect(find(".chat-subagent-activity")).toBeNull();
    expect(find(".chat-working-indicator--supporting")).toBeNull();
    expect(find(bubbleSelector)).not.toBeNull();
  });

  it("selects the working glyph independently of the mascot and keeps text when hidden", () => {
    const { container, draw, find } = mountIndicator("brand-test", {
      mascot: "claw",
      workingIndicator: "dots",
    });
    expect(container.querySelectorAll(".chat-reading-indicator--neutral > span")).toHaveLength(3);
    draw({ mascot: "none", workingIndicator: "claw" });
    expect(find(".chat-reading-indicator svg")).not.toBeNull();
    draw({ workingIndicator: "brand" });
    expect(find(".chat-reading-indicator--brand")).not.toBeNull();
    draw({ workingIndicator: "none", workingPhrases: [] });
    expect(find(bubbleSelector)).toBeNull();
    expect(find(".chat-working-indicator__status > span")?.classList.contains("sr-only")).toBe(
      false,
    );
    expect(container.textContent).toContain("Working");
  });

  it("renders neutral dots without claw surprises and forwards authored phrases", () => {
    const workingPhrases = ["Building"];
    const { find } = mountIndicator(findRenderKey(true), {
      mascot: "none",
      workingPhrases,
    });
    const bubble = find(".chat-reading-indicator--neutral");
    expect(bubble?.querySelectorAll("span")).toHaveLength(3);
    expect(bubble?.querySelector("svg")).toBeNull();
    expect(variants(bubble!)).toEqual(["chat-reading-indicator--neutral"]);
    expect(find("openclaw-working-phrase")).toHaveProperty("phrases", workingPhrases);
  });

  it("keeps approval waits on the default claw even for surprising keys", () => {
    const { find } = mountIndicator(findRenderKey(true), { waitingApproval: true });
    const bubble = find(bubbleSelector);
    expect(bubble).not.toBeNull();
    expect(variants(bubble!)).toEqual([]);
  });

  it("retains an open activity disclosure and its animation when usage updates", () => {
    const { container, draw, find } = mountIndicator("steady-run", {
      bubbleMode: true,
      outputTokens: 12,
    });
    const details = find("details")!;
    details.open = true;
    const glyph = find(bubbleSelector)!;
    draw({ bubbleMode: true, outputTokens: 27 });
    expect(find("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(find(bubbleSelector)).toBe(glyph);
    expect(container.textContent).toContain("27 output tokens");
  });
});
