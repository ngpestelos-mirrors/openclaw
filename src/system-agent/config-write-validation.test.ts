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
