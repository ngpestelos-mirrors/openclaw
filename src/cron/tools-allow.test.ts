import { describe, expect, it } from "vitest";
import { resolveCronRunToolsAllow } from "./tools-allow.js";

type Job = Parameters<typeof resolveCronRunToolsAllow>[0];
const toolsAllow = ["read", "exec"];
const owner = {
  agentId: "main",
  sessionKey: "agent:main:slack:channel:team",
  accountId: "default",
};
const runtimeAuthority = {
  version: 1 as const,
  runtimeId: "codex",
  namespace: "codex.apps",
  payload: { version: 1, apps: [] },
  allowOwnerToolDefaults: true as const,
};
const job: Job = {
  owner,
  scheduledToolPolicy: {
    version: 1,
    mode: "account",
    ownerSessionKey: owner.sessionKey,
    ownerAccountId: owner.accountId,
  },
  payload: {
    kind: "agentTurn",
    message: "Read a DevBox skill and its MCP",
    toolsAllow,
    toolsAllowIsDefault: true,
  },
  runtimeAuthority,
};

describe("runtime-authorized cron owner defaults", () => {
  it("uses current owner tools while retaining the persisted snapshot and runtime cap", () => {
    expect(resolveCronRunToolsAllow(job)).toEqual(["*"]);
    expect(job.payload.toolsAllow).toEqual(toolsAllow);
    expect(job.runtimeAuthority).toBe(runtimeAuthority);
  });

  it.each<{ name: string; overrides: Partial<Job> }>([
    {
      name: "a runtime that did not opt in",
      overrides: {
        runtimeAuthority: { version: 1, runtimeId: "codex", namespace: "codex.apps", payload: {} },
      },
    },
    { name: "runtime recovery", overrides: { runtimeAuthorityRecoveryRequired: true } },
    { name: "a condition script", overrides: { trigger: { script: "return { fire: true }" } } },
    { name: "a mismatched owner", overrides: { owner: { ...owner, accountId: "other" } } },
    {
      name: "an accountless owner",
      overrides: { owner: { agentId: "main", sessionKey: owner.sessionKey } },
    },
    { name: "a missing owner policy", overrides: { scheduledToolPolicy: undefined } },
    {
      name: "an explicit finite cap",
      overrides: { payload: { kind: "agentTurn", message: "Read only", toolsAllow } },
    },
    {
      name: "a script payload",
      overrides: {
        payload: { kind: "script", script: "return 'done'", toolsAllow, toolsAllowIsDefault: true },
      },
    },
  ])("keeps the finite cap for $name", ({ overrides }) => {
    expect(resolveCronRunToolsAllow({ ...job, ...overrides })).toEqual(toolsAllow);
  });

  it("keeps an explicit empty cap empty", () => {
    expect(
      resolveCronRunToolsAllow({
        ...job,
        payload: { kind: "agentTurn", message: "No tools", toolsAllow: [] },
      }),
    ).toEqual([]);
  });
});
