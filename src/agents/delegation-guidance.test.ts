import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDelegationGuidanceSection,
  resolveMainSessionDelegationMode,
} from "./delegation-guidance.js";

describe("resolveMainSessionDelegationMode", () => {
  it.each([
    ["canonical main session", {}, "main", "agent:main:main", "prefer"],
    ["non-main session", {}, "main", "agent:main:slack:channel:C01234567", "suggest"],
    ["custom main key", { session: { mainKey: "inbox" } }, "main", "agent:main:inbox", "prefer"],
    ["global session scope", { session: { scope: "global" } }, "main", "global", "prefer"],
    [
      "explicit default prefer outside main",
      { agents: { defaults: { subagents: { delegationMode: "prefer" } } } },
      "main",
      "agent:main:dashboard:project",
      "prefer",
    ],
    [
      "explicit default suggest in main",
      { agents: { defaults: { subagents: { delegationMode: "suggest" } } } },
      "main",
      "agent:main:main",
      "suggest",
    ],
    [
      "per-agent prefer overrides default suggest",
      {
        agents: {
          defaults: { subagents: { delegationMode: "suggest" } },
          entries: { coordinator: { subagents: { delegationMode: "prefer" } } },
        },
      },
      "coordinator",
      "agent:coordinator:dashboard:project",
      "prefer",
    ],
    [
      "per-agent suggest overrides default prefer",
      {
        agents: {
          defaults: { subagents: { delegationMode: "prefer" } },
          entries: { main: { subagents: { delegationMode: "suggest" } } },
        },
      },
      "main",
      "agent:main:main",
      "suggest",
    ],
  ] as const)("resolves %s", (_name, config, agentId, sessionKey, expected) => {
    expect(
      resolveMainSessionDelegationMode({
        config: config as OpenClawConfig,
        agentId,
        sessionKey,
      }),
    ).toBe(expected);
  });
});

describe("buildDelegationGuidanceSection", () => {
  const buildSection = (
    overrides: Partial<Parameters<typeof buildDelegationGuidanceSection>[0]> = {},
  ) =>
    buildDelegationGuidanceSection({
      mode: "prefer",
      isMinimal: false,
      hiddenDelegationTool: "native `spawn_agent`",
      hasVisibleSessionSpawn: true,
      hasSessionsYield: true,
      hasSubagentsList: true,
      hasSessionsSend: true,
      ...overrides,
    });

  it.each([
    { hiddenDelegationTool: "`sessions_spawn`", expected: "delegate via `sessions_spawn`" },
    {
      hiddenDelegationTool: "native `spawn_agent`",
      expected: "delegate via native `spawn_agent`",
    },
  ])("injects $hiddenDelegationTool", ({ hiddenDelegationTool, expected }) => {
    expect(buildSection({ hiddenDelegationTool }).join("\n")).toContain(expected);
  });

  it.each([
    { flag: "hasVisibleSessionSpawn", marker: "`sessions_spawn` with `visible=true`" },
    { flag: "hasSessionsSend", marker: "`sessions_send`" },
    { flag: "hasSessionsYield", marker: "`sessions_yield`" },
    { flag: "hasSubagentsList", marker: "`subagents(action=list)`" },
  ] as const)("mentions $marker only when $flag", ({ flag, marker }) => {
    expect(buildSection().join("\n")).toContain(marker);
    expect(buildSection({ [flag]: false }).join("\n")).not.toContain(marker);
  });

  it.each([
    {
      name: "minimal prompts, even with session creation",
      overrides: {
        isMinimal: true,
        sessionsCreateToolName: "sessions_create",
        suggestTaskToolName: "suggest_task",
      },
    },
    { name: "suggest mode without session routing tools", overrides: { mode: "suggest" as const } },
    {
      name: "no usable delegation tool",
      overrides: { hiddenDelegationTool: "", hasVisibleSessionSpawn: false },
    },
  ])("omits the section for $name", ({ overrides }) => {
    expect(buildSection(overrides)).toEqual([]);
  });
});
