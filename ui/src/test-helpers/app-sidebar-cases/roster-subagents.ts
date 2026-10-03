import { describe, expect, it, vi } from "vitest";
import { mountRoster, roster, session, sessionKeys, settleRoster } from "./roster.test-support.ts";

describe("Sidebar Home subagents", () => {
  it.each(["chip", "roster"] as const)(
    "does not count unidentified Swarm children in %s mode",
    async (mode) => {
      const parentKey = "agent:main:dashboard:parallel-parent";
      const childKey = "agent:main:subagent:parallel-child";
      const { sidebar } = await mountRoster(
        roster,
        [session("main", 1, { key: parentKey, isMain: false, childSessions: [childKey] })],
        undefined,
        [],
        [],
        [
          session("main", 2, {
            key: childKey,
            isMain: false,
            spawnedBy: parentKey,
            swarmGroupId: "parallel-review",
          }),
        ],
      );
      sidebar.sidebarAgentsMode = mode;
      await settleRoster(sidebar);
      await vi.waitFor(() =>
        expect(sidebar.querySelector(`[data-session-key="${parentKey}"]`)).not.toBeNull(),
      );
      const parent = () => sidebar.querySelector(`[data-session-key="${parentKey}"]`)!;
      expect(parent().querySelector(".sidebar-child-session-toggle__count")).toBeNull();
      parent().querySelector<HTMLButtonElement>("[data-child-session-toggle]")!.click();
      await vi.waitFor(() =>
        expect(parent().querySelector("[data-child-session-toggle]")).toBeNull(),
      );
      expect(sidebar.querySelector(`[data-session-key="${childKey}"]`)).toBeNull();
    },
  );

  it.each(["chip", "roster"] as const)(
    "excludes unfiltered Home child details from involving-me navigation in %s mode",
    async (mode) => {
      const homeKey = "agent:main:main";
      const workerKey = "agent:main:subagent:unrelated-worker";
      const home = session("main", 2, { childSessions: [workerKey] });
      const worker = session("main", 1, {
        key: workerKey,
        isMain: false,
        spawnedBy: homeKey,
        label: "Unrelated worker",
        status: "failed",
        lastRunError: "Unrelated failure",
      });
      const { sidebar, gatewayHarness, sessions, result } = await mountRoster(
        roster,
        [home, worker],
        undefined,
        [],
        [],
        [worker],
      );
      gatewayHarness.publish({ selfUser: { id: "profile-ada", name: "Ada" } });
      sidebar.sidebarAgentsMode = mode;
      await settleRoster(sidebar);
      await vi.waitFor(() =>
        expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ spawnedBy: homeKey })),
      );
      result.sessions = [home];
      result.count = 1;
      sessions.publishList({ result, agentId: "main" });
      sidebar.setSessionOwnerFilter(null, true);
      await vi.waitFor(() =>
        expect(sessions.list).toHaveBeenCalledWith(expect.objectContaining({ involvingMe: true })),
      );
      await settleRoster(sidebar);
      expect(sidebar.querySelector(`[data-session-key="${workerKey}"]`)).toBeNull();
      expect(sidebar.querySelector(`[data-child-session-toggle="${homeKey}"]`)).toBeNull();
      expect(sidebar.querySelector('[data-session-attention="error"]')).toBeNull();
    },
  );

  it("expands quiet Home subagents without duplicating promoted conversation activity", async () => {
    const homeKey = "agent:main:main";
    const childKey = "agent:main:dashboard:continuation";
    const workerKeys = Array.from(
      { length: 6 },
      (_, index) => `agent:main:subagent:worker-${index}`,
    );
    const { sidebar } = await mountRoster(roster, [
      session("main", 10, { childSessions: workerKeys }),
      ...workerKeys.map((key, index) =>
        session("main", 9 - index, {
          key,
          isMain: false,
          spawnedBy: homeKey,
          label: `Review ${index}`,
          status: "done",
          hasActiveRun: false,
          ...(index === 0 ? { childSessions: [childKey] } : {}),
        }),
      ),
      session("main", 1, {
        key: childKey,
        isMain: false,
        spawnedBy: workerKeys[0],
        status: "running",
        hasActiveRun: true,
        unread: true,
      }),
    ]);
    sidebar.sidebarAgentsMode = "roster";
    await vi.waitFor(() => expect(sessionKeys(sidebar)).toContain(workerKeys[0]));
    expect(
      sessionKeys(sidebar).filter((key) => key !== undefined && workerKeys.includes(key)),
    ).toHaveLength(4);
    expect(
      sidebar.querySelector(`[data-session-key="${workerKeys[0]}"] .session-glyph__ring`),
    ).toBeNull();
    expect(
      sidebar.querySelector(`[data-session-key="${workerKeys[0]}"] [aria-label="Unread"]`),
    ).toBeNull();
    expect(sidebar.querySelectorAll(`[data-session-key="${childKey}"]`)).toHaveLength(1);
    expect(
      sidebar.querySelector(`[data-session-key="${childKey}"] .session-glyph__ring`),
    ).not.toBeNull();
    sidebar.querySelector<HTMLButtonElement>(`[data-show-more-children="${homeKey}"]`)!.click();
    await vi.waitFor(() =>
      expect(
        sessionKeys(sidebar).filter((key) => key !== undefined && workerKeys.includes(key)),
      ).toHaveLength(6),
    );
    expect(sidebar.querySelector(`[data-show-more-children="${homeKey}"]`)).toBeNull();
  });
});
