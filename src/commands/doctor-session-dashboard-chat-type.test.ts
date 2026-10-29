import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  listSessionEntriesCore,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

import { repairLegacyDashboardChatTypes } from "./doctor-session-dashboard-chat-type.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const dashboardKey = (suffix: number) =>
  `agent:main:dashboard:7d3c1f00-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ROOT_KEY = dashboardKey(1);

// The durable shape v2026.10.6 wrote for a dashboard chat created without a message.
const legacyRoot = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "legacy-root",
  updatedAt: 1,
  createdVia: "operator",
  createdAt: 1,
  spawnDepth: 0,
  parentSessionKey: "agent:main:main",
  ...overrides,
});

const discordDelivery: SessionEntry["delivery"] = {
  kind: "external",
  route: { channel: "discord", accountId: "default", target: { to: "channel:1" } },
  context: { channel: "discord", accountId: "default", to: "channel:1" },
  origin: { provider: "discord", accountId: "default", to: "channel:1", chatType: "channel" },
};

describe("doctor dashboard chat type eligibility", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    note.mockClear();
    await state?.cleanup();
    state = undefined;
  });

  // Eligibility is observed at the repair boundary: only the single eligible root is stamped.
  it.each<[string, OpenClawConfig, Record<string, SessionEntry>, string]>([
    [
      "default main key",
      { agents: { entries: { main: {}, ops: {} } } },
      {
        [ROOT_KEY]: legacyRoot({ sessionId: "eligible" }),
        [dashboardKey(2)]: legacyRoot({ sessionId: "existing-type", chatType: "group" }),
        [dashboardKey(3)]: legacyRoot({ sessionId: "channel-created", createdVia: "channel" }),
        [dashboardKey(4)]: legacyRoot({ sessionId: "spawn-created", createdVia: "spawn" }),
        [dashboardKey(5)]: legacyRoot({ sessionId: "unstamped", createdVia: undefined }),
        [dashboardKey(6)]: legacyRoot({ sessionId: "spawned", spawnedBy: "agent:main:main" }),
        [dashboardKey(7)]: legacyRoot({
          sessionId: "fork",
          forkSource: { sessionKey: ROOT_KEY, sessionId: "source" },
        }),
        [dashboardKey(8)]: legacyRoot({ sessionId: "plugin-owned", pluginOwnerId: "workboard" }),
        [dashboardKey(9)]: legacyRoot({ sessionId: "incognito-row", incognito: true }),
        [dashboardKey(10)]: legacyRoot({ sessionId: "external", delivery: discordDelivery }),
        [dashboardKey(11)]: legacyRoot({
          sessionId: "explicit-child",
          parentSessionKey: "agent:main:discord:group:1",
        }),
        [dashboardKey(12)]: legacyRoot({ sessionId: "unparented", parentSessionKey: undefined }),
        "agent:main:discord:group:123": legacyRoot({ sessionId: "channel-key" }),
        "agent:main:main": legacyRoot({ sessionId: "main-key" }),
        "agent:main:dashboard:incognito-7d3c1f00": legacyRoot({ sessionId: "incognito-key" }),
        "agent:ops:dashboard:7d3c1f00": legacyRoot({ sessionId: "other-agent-parent" }),
      },
      ROOT_KEY,
    ],
    [
      "configured main key",
      { session: { mainKey: "home" } },
      {
        [dashboardKey(14)]: legacyRoot({ sessionId: "default-parent-under-custom-main" }),
        [dashboardKey(15)]: legacyRoot({
          sessionId: "custom-main-parent",
          parentSessionKey: "agent:main:home",
        }),
      },
      dashboardKey(15),
    ],
  ])("stamps only the eligible root with the %s", async (_name, cfg, rows, eligibleKey) => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-dashboard-eligibility-" });
    const env = state.env;
    setRuntimeConfigSnapshot(cfg);
    const agentOf = (sessionKey: string) => sessionKey.split(":")[1] ?? "main";
    for (const [sessionKey, entry] of Object.entries(rows)) {
      await replaceSessionEntry({ agentId: agentOf(sessionKey), env, sessionKey }, entry);
    }
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    repairLegacyDashboardChatTypes({ apply: true, cfg, env });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    const chatTypes = Object.fromEntries(
      [...new Set(Object.keys(rows).map(agentOf))].flatMap((agentId) =>
        listSessionEntriesCore({ agentId, env }).map((row) => [row.sessionKey, row.entry.chatType]),
      ),
    );
    expect(chatTypes).toEqual(
      Object.fromEntries(
        Object.entries(rows).map(([key, entry]) => [
          key,
          key === eligibleKey ? "direct" : entry.chatType,
        ]),
      ),
    );
  });
});

describe("doctor dashboard chat type backfill", () => {
  let state: OpenClawTestState | undefined;

  afterEach(async () => {
    note.mockClear();
    await state?.cleanup();
    state = undefined;
  });

  it("records only eligible dashboard roots as direct, and only under --fix", async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-doctor-dashboard-chat-type-" });
    const config: OpenClawConfig = { plugins: { enabled: false } };
    setRuntimeConfigSnapshot(config);
    const env = state.env;
    const rows: Record<string, SessionEntry> = {
      [ROOT_KEY]: legacyRoot(),
      "agent:main:discord:group:123": legacyRoot({ sessionId: "group", createdVia: "channel" }),
      "agent:main:dashboard:7d3c1f00-0000-4000-8000-000000000002": legacyRoot({
        sessionId: "plugin",
        pluginOwnerId: "workboard",
      }),
    };
    for (const [sessionKey, entry] of Object.entries(rows)) {
      await replaceSessionEntry({ agentId: "main", env, sessionKey }, entry);
    }
    const settle = async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
    };
    const read = () =>
      Object.fromEntries(
        listSessionEntriesCore({ agentId: "main", env }).map((row) => [
          row.sessionKey,
          row.entry.chatType,
        ]),
      );

    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: false });
    await settle();
    expect(read()[ROOT_KEY]).toBeUndefined();
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Would record 1"),
      expect.any(String),
    );
    note.mockClear();

    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: true });
    await settle();
    expect(read()).toEqual({
      [ROOT_KEY]: "direct",
      "agent:main:discord:group:123": undefined,
      "agent:main:dashboard:7d3c1f00-0000-4000-8000-000000000002": undefined,
    });
    const repaired = listSessionEntriesCore({ agentId: "main", env }).find(
      (row) => row.sessionKey === ROOT_KEY,
    )?.entry;
    // The stamp is the only change: the incarnation a linked job captured stays current.
    expect(repaired).toMatchObject({ ...legacyRoot(), chatType: "direct" });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Recorded 1 dashboard chat(s)`),
      "Session chat type",
    );

    note.mockClear();
    await noteSessionTranscriptHealth({ cfg: config, env, shouldRepair: true });
    expect(note).not.toHaveBeenCalledWith(expect.anything(), "Session chat type");
  });
});
