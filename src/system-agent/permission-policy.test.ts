import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { changesPermissionPolicy } from "./permission-policy.js";

describe("changesPermissionPolicy", () => {
  const before: OpenClawConfig = {
    tools: { profile: "coding", exec: { mode: "ask", notifyOnExit: true } },
    agents: { entries: { research: { name: "Research", tools: { exec: { mode: "deny" } } } } },
    gateway: { auth: { mode: "token", token: "fixture-inbound-token" }, port: 18789 },
    approvals: { exec: { enabled: true, targets: [{ channel: "slack", to: "fixture-approver" }] } },
  };

  it("ignores key order, unchanged policy and non-authority siblings in parent replacements", () => {
    const after: OpenClawConfig = {
      ...before,
      tools: { exec: { notifyOnExit: false, timeoutSeconds: 60, mode: "ask" }, profile: "coding" },
      agents: { entries: { research: { ...before.agents!.entries!.research, name: "Renamed" } } },
      gateway: { port: 19001, auth: { token: "fixture-inbound-token", mode: "token" } },
    };
    expect(changesPermissionPolicy(before, after)).toBe(false);
  });

  it.each([
    { tools: { exec: { mode: "full" } } },
    { tools: { exec: { mode: "deny" } } },
    { tools: {} },
    { agents: { entries: { research: { name: "Research" } } } },
    { gateway: { port: 19001 } },
    { gateway: { auth: { mode: "token", token: "fixture-rotated-token" } } },
    { gateway: { allowRealIpFallback: true } },
    { approvals: { exec: { enabled: false } } },
    { commands: { ownerAllowFrom: ["fixture-new-owner"] } },
    { tools: { exec: { safeBins: ["fixture-binary"] } } },
    { tools: { fs: { workspaceOnly: true } } },
  ] satisfies OpenClawConfig[])(
    "detects authority changes, tightening and removals: %j",
    (patch) => {
      expect(changesPermissionPolicy(before, { ...before, ...patch })).toBe(true);
    },
  );

  it("distinguishes equivalent exec syntax from a different reviewer", () => {
    const legacy: OpenClawConfig = { tools: { exec: { security: "allowlist", ask: "on-miss" } } };
    expect(changesPermissionPolicy(legacy, { tools: { exec: { mode: "ask" } } })).toBe(false);
    expect(changesPermissionPolicy(legacy, { tools: { exec: { mode: "auto" } } })).toBe(true);
  });

  it("compares inherited exec and sandbox policy when an agent override is removed", () => {
    const inherited: OpenClawConfig = {
      tools: { exec: { mode: "ask" }, sandbox: { tools: { allow: ["read"] } } },
      agents: {
        defaults: { sandbox: { mode: "all" } },
        entries: { research: { name: "Research" } },
      },
    };
    const same: OpenClawConfig = {
      ...inherited,
      agents: {
        ...inherited.agents,
        entries: {
          research: {
            tools: { exec: { mode: "ask" }, sandbox: { tools: { allow: ["read"] } } },
            sandbox: { mode: "all" },
          },
        },
      },
    };
    expect(changesPermissionPolicy(same, inherited)).toBe(false);
    const different: OpenClawConfig = {
      ...inherited,
      agents: {
        ...inherited.agents,
        entries: { research: { tools: { exec: { mode: "deny" } }, sandbox: { mode: "off" } } },
      },
    };
    expect(changesPermissionPolicy(different, inherited)).toBe(true);
  });

  it("keeps unresolved exec defaults meaningful while normalizing known filesystem/sandbox defaults", () => {
    expect(
      changesPermissionPolicy(
        {},
        {
          tools: { fs: { workspaceOnly: false } },
          agents: { defaults: { sandbox: { mode: "off" } } },
        },
      ),
    ).toBe(false);
    // Missing security can inherit a host approval floor or sandbox deny.
    expect(changesPermissionPolicy({ tools: { exec: { mode: "full" } } }, {})).toBe(true);
  });

  it("does not confuse outgoing credential rotation with inbound authentication", () => {
    const ref = { source: "env", provider: "default", id: "FIXTURE_API_KEY" } as const;
    expect(changesPermissionPolicy({}, { gateway: { remote: { token: ref } } })).toBe(false);
    expect(changesPermissionPolicy({}, { gateway: { auth: { token: ref } } })).toBe(true);
  });

  it("ignores operational exec and sandbox retention changes without inventing policy", () => {
    expect(
      changesPermissionPolicy(
        {},
        {
          tools: {
            exec: {
              timeoutSeconds: 60,
              backgroundMs: 500,
              cleanupMs: 1000,
              notifyOnExit: false,
              commandHighlighting: true,
            },
          },
          agents: {
            entries: { research: { name: "Research", tools: { exec: { notifyOnExit: true } } } },
            defaults: { sandbox: { prune: { idleHours: 2 } } },
          },
        },
      ),
    ).toBe(false);
  });
  it("protects inbound credential dependencies without gating unrelated outgoing providers", () => {
    const ref = { source: "file", provider: "fixture", id: "/token" } as const;
    const inbound: OpenClawConfig = {
      gateway: { auth: { token: ref } },
      secrets: { providers: { fixture: { source: "file", path: "/fixture/old.json" } } },
    };
    const secrets: OpenClawConfig["secrets"] = {
      providers: { fixture: { source: "file", path: "/fixture/new.json" } },
    };
    expect(changesPermissionPolicy(inbound, { ...inbound, secrets })).toBe(true);
    const outgoing: OpenClawConfig = { ...inbound, gateway: { remote: { token: ref } } };
    expect(changesPermissionPolicy(outgoing, { ...outgoing, secrets })).toBe(false);
  });

  it("retains unresolved sandbox SSH credential refs in the authority projection", () => {
    const sshBefore: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            ssh: {
              target: "fixture-host",
              identityData: { source: "env", provider: "default", id: "FIXTURE_SSH_OLD" },
            },
          },
        },
      },
    };
    const after: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            ssh: {
              target: "fixture-host",
              identityData: { source: "env", provider: "default", id: "FIXTURE_SSH_NEW" },
            },
          },
        },
      },
    };
    expect(changesPermissionPolicy(sshBefore, after)).toBe(true);
  });
});
