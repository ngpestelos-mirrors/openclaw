import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import {
  evaluateSystemAgentConfigChange,
  SystemAgentOperationExitError,
} from "./operations-execution-helpers.js";
import { executeSystemAgentOperation, type SystemAgentCommandDeps } from "./operations.js";
import { changesPermissionPolicy } from "./permission-policy.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

async function prepareConfig(raw = "{}\n") {
  const stateDir = tempDirs.make("openclaw-config-write-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await fs.writeFile(configPath, raw);
  return configPath;
}

describe("createSystemAgentTool.execute config writes", () => {
  it.each([
    ["agents.defaults.models.fixture/primary.agentRuntime.id", "openclaw"],
    ["agents.defaults.model.primary", "fixture/primary"],
    ["models.providers.fixture.baseUrl", "https://example.invalid/v1"],
    ["env.vars.FIXTURE_SETTING", "fixture-value"],
    ["plugins.entries.fixture.enabled", "true"],
  ])("offers approval without writing %s", async (configKey, value) => {
    const configPath = await prepareConfig();
    const result = await createSystemAgentTool({ surface: "cli" }).execute("proposal", {
      action: "config_set",
      path: configKey,
      value,
    });
    expect(result.details).toMatchObject({ needsApproval: true });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });
});

describe("executeSystemAgentOperation approved config writes", () => {
  it.each([
    {
      configKey: "agents.defaults.models.fixture/primary.agentRuntime.id",
      value: "openclaw",
      saved: {
        agents: {
          defaults: { models: { "fixture/primary": { agentRuntime: { id: "openclaw" } } } },
        },
      },
    },
    {
      configKey: "tools.exec.notifyOnExit",
      value: "false",
      saved: { tools: { exec: { notifyOnExit: false } } },
    },
  ])(
    "saves $configKey through the real writer without a live probe",
    async ({ configKey, value, saved }) => {
      const configPath = await prepareConfig(
        JSON.stringify({ agents: { defaults: { model: { primary: "fixture/primary" } } } }),
      );
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn<
        NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
      >(async () => {
        throw new Error("Unexpected config-write inference probe");
      });
      await expect(
        executeSystemAgentOperation({ kind: "config-set", path: configKey, value }, runtime, {
          approved: true,
          deps: { verifyInferenceConfig },
        }),
      ).resolves.toMatchObject({ applied: true });
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject(saved);
      expect(verifyInferenceConfig).not.toHaveBeenCalled();
      expect(lines).toContain("[openclaw] done: config.set");
    },
  );

  it("captures the real schema error and leaves the file unchanged", async () => {
    const raw = JSON.stringify({ gateway: { port: 18789 } });
    const configPath = await prepareConfig(raw);
    const { runtime, lines } = createSystemAgentTestRuntime();
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "gateway.port", value: "banana" },
        runtime,
        { approved: true },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain(
      "gateway.port: Invalid input: expected number, received string",
    );
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("keeps the writer's authority check after config validation", async () => {
    const configPath = await prepareConfig();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const beforePersistentApply = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("approving run closed");
      });
    await expect(
      executeSystemAgentOperation(
        { kind: "config-set", path: "tools.exec.notifyOnExit", value: "false" },
        runtime,
        { approved: true, beforePersistentApply },
      ),
    ).rejects.toBeInstanceOf(SystemAgentOperationExitError);
    expect(lines.join("\n")).toContain("approving run closed");
    expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
  });

  it.each(["env", "file"] as const)(
    "uses canonical SecretRef validation with an %s provider",
    async (source) => {
      const raw = JSON.stringify({
        secrets: {
          providers: {
            fixture:
              source === "env"
                ? { source }
                : { source, path: "/tmp/unused-fixture-secrets.json", mode: "json" },
          },
        },
      });
      const configPath = await prepareConfig(raw);
      const { runtime, lines } = createSystemAgentTestRuntime();
      const operation = executeSystemAgentOperation(
        {
          kind: "config-set-ref",
          path: "gateway.auth.token",
          source: "env",
          provider: "fixture",
          id: "FIXTURE_API_KEY",
        },
        runtime,
        { approved: true },
      );
      if (source === "env") {
        await expect(operation).resolves.toMatchObject({ applied: true });
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
          gateway: {
            auth: { token: { source: "env", provider: "fixture", id: "FIXTURE_API_KEY" } },
          },
        });
      } else {
        await expect(operation).rejects.toBeInstanceOf(SystemAgentOperationExitError);
        expect(lines.join("\n")).toContain(
          'provider "fixture" has source "file" but ref requests "env"',
        );
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      }
    },
  );
});

describe("delegated config proposal evaluation", () => {
  it.each([
    ["tools.subagents.tools", '{"deny":["exec"]}'],
    ["tools.sandbox.tools", '{"deny":["exec"]}'],
    ["agents.entries.research.tools.sandbox.tools", '{"deny":["exec"]}'],
    ["channels.telegram.groups.-100.tools", '{"deny":["exec"]}'],
    ["channels.telegram.groups.-100.tools", "{}"],
    ["channels.telegram.direct.42.toolsBySender", '{"id:42":{}}'],
    ["channels.telegram.accounts.ops.groups.-100.toolsBySender", '{"id:42":{"allow":["read"]}}'],
    ["channels.telegram.direct.42.tools", '{"allow":["read"]}'],
    ["channels.telegram.accounts.ops.direct.42.toolsBySender", '{"id:42":{"deny":["exec"]}}'],
    ["channels.discord.accounts.ops.guilds.123.channels.456.tools", '{"deny":["exec"]}'],
    ["channels.slack.accounts.ops.channels.C123.toolsBySender", '{"id:U123":{"allow":["read"]}}'],
    ["gateway.controlUi.allowedOrigins", '["https://fixture.example"]'],
    ["gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback", "true"],
    ["gateway.controlUi.embedSandbox", "trusted"],
    ["gateway.controlUi.allowExternalEmbedUrls", "true"],
    ["channels.matrix.dm.enabled", "false"],
    ["channels.discord.dm.groupEnabled", "true"],
    ["channels.slack.allowBots", "true"],
    ["channels.discord.dangerouslyAllowNameMatching", "true"],
    ["channels.discord.guilds.123.roles", '["345678901234567890"]'],
    ["channels.discord.guilds.123", '{"slug":"fixture-guild"}'],
    ["channels.telegram.allowFrom", '["42"]'],
    ["channels.telegram.dmPolicy", "disabled"],
    ["channels.telegram.groupPolicy", "open"],
    ["channels.telegram.groupAllowFrom", '["42"]'],
    ["channels.telegram.groups.*", '{"systemPrompt":"Every group"}'],
    ["channels.telegram.accounts.ops.groups.-100", '{"systemPrompt":"One group"}'],
    ["channels.telegram.accounts.ops.allowFrom", '["42"]'],
    ["channels.telegram.accounts.ops.dmPolicy", "disabled"],
    ["channels.telegram.accounts.ops.groupPolicy", "open"],
    ["channels.telegram.accounts.ops.groupAllowFrom", '["42"]'],
  ])(
    "protects validated channel/browser authority at %s, including removal",
    async (configKey, value) => {
      const configPath = await prepareConfig();
      const change = await evaluateSystemAgentConfigChange({
        kind: "config-set",
        path: configKey,
        value,
      });
      expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
      expect(changesPermissionPolicy(change.after, change.before)).toBe(true);
      expect(changesPermissionPolicy(change.after, structuredClone(change.after))).toBe(false);
      expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
    },
  );

  it.each([
    [
      "channels.telegram.accounts.ops.groups.-100",
      '{"tools":{"deny":["exec"]},"topics":{"7":{"systemPrompt":"new topic guidance"}}}',
    ],
    [
      "channels.telegram.accounts.ops.direct.42",
      '{"toolsBySender":{"id:42":{"allow":["read"]}},"systemPrompt":"new DM guidance"}',
    ],
    ["channels.telegram.accounts.ops.name", "Renamed account"],
    ["gateway.controlUi", '{"allowedOrigins":["https://fixture.example"],"communityInvite":false}'],
  ])(
    "keeps policy-preserving parent and sibling changes automatic: %s",
    async (configKey, value) => {
      const raw = JSON.stringify({
        channels: {
          telegram: {
            accounts: {
              ops: {
                groups: { "-100": { tools: { deny: ["exec"] } } },
                direct: { "42": { toolsBySender: { "id:42": { allow: ["read"] } } } },
              },
            },
          },
        },
        gateway: { controlUi: { allowedOrigins: ["https://fixture.example"] } },
      });
      const configPath = await prepareConfig(raw);
      const change = await evaluateSystemAgentConfigChange({
        kind: "config-set",
        path: configKey,
        value,
      });
      expect(changesPermissionPolicy(change.before, change.after)).toBe(false);
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    },
  );

  it("detects an exact DM entry hiding wildcard tool policy, not ordinary topic edits", async () => {
    const raw = JSON.stringify({
      channels: {
        telegram: {
          accounts: {
            ops: {
              direct: { "*": { tools: { deny: ["exec"] } } },
            },
          },
        },
      },
    });
    await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "channels.telegram.accounts.ops.direct.42",
      value: '{"systemPrompt":"specific DM"}',
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
    expect(changesPermissionPolicy(change.after, change.before)).toBe(true);
  });

  it.each([
    ["channels.telegram.botToken", "fixture-bot-token"],
    ["channels.telegram.accounts.ops.botToken", "fixture-bot-token"],
    ["gateway.controlUi.embedSandbox", "scripts"],
    ["gateway.controlUi.allowExternalEmbedUrls", "false"],
  ])("does not invent a policy change for setup/default %s", async (configKey, value) => {
    await prepareConfig();
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: configKey,
      value,
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(false);
  });

  it("protects canonical nested DM admission despite a conflicting legacy account field", async () => {
    const raw = JSON.stringify({
      channels: {
        matrix: {
          accounts: {
            ops: {
              dmPolicy: "disabled",
              allowFrom: ["@legacy:example.invalid"],
              dm: { policy: "allowlist", allowFrom: ["@allowed:example.invalid"] },
            },
          },
        },
      },
    });
    const configPath = await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "channels.matrix.accounts.ops.dm",
      value: '{"policy":"open","allowFrom":["*"]}',
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it.each([
    ["channels.matrix.allowlistOnly", "false"],
    ['channels.matrix.groups["!fixture:example.invalid"].enabled', "true"],
    [
      'channels.matrix.groups["!fixture:example.invalid"].users',
      '["@allowed:example.invalid","@new:example.invalid"]',
    ],
  ])("protects existing Matrix admission at %s", async (configKey, value) => {
    const raw = JSON.stringify({
      channels: {
        matrix: {
          allowlistOnly: true,
          groupPolicy: "open",
          groupAllowFrom: ["@allowed:example.invalid"],
          groups: {
            "!fixture:example.invalid": { enabled: false, users: ["@allowed:example.invalid"] },
          },
        },
      },
    });
    const configPath = await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: configKey,
      value,
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("protects Matrix room alias membership", async () => {
    await prepareConfig();
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "channels.matrix.rooms",
      value: '{"!fixture:example.invalid":{"systemPrompt":"Room guidance"}}',
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
  });

  it("retains the shipped Matrix room allow alias at account scope", async () => {
    const raw = JSON.stringify({
      channels: {
        matrix: {
          accounts: {
            ops: {
              groups: { "!fixture:example.invalid": { allow: false } },
            },
          },
        },
      },
    });
    await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: 'channels.matrix.accounts.ops.groups["!fixture:example.invalid"].allow',
      value: "true",
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
  });

  it("protects removing a Discord group-DM channel restriction", async () => {
    await prepareConfig(
      JSON.stringify({
        channels: {
          discord: {
            dm: { groupEnabled: true, groupChannels: ["345678901234567890"] },
          },
        },
      }),
    );
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "channels.discord.dm.groupChannels",
      value: "[]",
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
  });

  it.each(["groups.-100", "direct.42"])(
    "rejects unsupported Telegram topic tool policy under %s",
    async (scope) => {
      const configPath = await prepareConfig();
      await expect(
        evaluateSystemAgentConfigChange({
          kind: "config-set",
          path: "channels.telegram.accounts.ops." + scope + ".topics.7.tools",
          value: '{"deny":["exec"]}',
        }),
      ).rejects.toThrow();
      expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
    },
  );

  it.each(["gateway.auth.token", "gateway.remote.token"])(
    "evaluates SecretRef effects at %s without resolving or writing credentials",
    async (configKey) => {
      const raw = JSON.stringify({ secrets: { providers: { fixture: { source: "env" } } } });
      const configPath = await prepareConfig(raw);
      const change = await evaluateSystemAgentConfigChange({
        kind: "config-set-ref",
        path: configKey,
        source: "env",
        provider: "fixture",
        id: "FIXTURE_UNSET_CREDENTIAL",
      });
      expect(changesPermissionPolicy(change.before, change.after)).toBe(
        configKey === "gateway.auth.token",
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    },
  );

  it("compares schema-normalized values rather than raw JSON representation", async () => {
    const raw = JSON.stringify({
      agents: { defaults: { sandbox: { docker: { setupCommand: "echo fixture" } } } },
    });
    const configPath = await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "agents.defaults.sandbox.docker.setupCommand",
      value: '["echo fixture"]',
    });
    expect(changesPermissionPolicy(change.before, change.after)).toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("evaluates legacy roster addressing against the canonical agent entry", async () => {
    const raw = JSON.stringify({
      agents: { entries: { research: { tools: { exec: { mode: "deny" } } } } },
    });
    const configPath = await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "agents.list[0].tools.exec.mode",
      value: "full",
    });
    expect(change.after.agents?.entries?.research?.tools?.exec?.mode).toBe("full");
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it("detects indirect policy changes through canonical environment interpolation", async () => {
    const raw = JSON.stringify({
      env: { vars: { FIXTURE_POLICY_MODE: "ask" } },
      tools: { exec: { mode: "${FIXTURE_POLICY_MODE}" } },
    });
    const configPath = await prepareConfig(raw);
    const change = await evaluateSystemAgentConfigChange({
      kind: "config-set",
      path: "env.vars.FIXTURE_POLICY_MODE",
      value: "full",
    });
    expect(change.before.tools?.exec?.mode).toBe("ask");
    expect(change.after.tools?.exec?.mode).toBe("full");
    expect(changesPermissionPolicy(change.before, change.after)).toBe(true);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
  });

  it.each([
    ["tools..exec", "{}"],
    ["tools.exec", "null"],
    ["tools.exec.mode", "banana"],
    ["agents.defaults.tools.profile", "full"],
  ])(
    "rejects invalid proposal %s instead of treating it as policy-free",
    async (configKey, value) => {
      const configPath = await prepareConfig();
      await expect(
        evaluateSystemAgentConfigChange({ kind: "config-set", path: configKey, value }),
      ).rejects.toThrow();
      expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
    },
  );
});
