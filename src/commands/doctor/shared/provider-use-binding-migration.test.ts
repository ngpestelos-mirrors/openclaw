import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderUseAdmission } from "../../../agents/provider-model-auth-source-plan.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveProviderBindingEnvVarCandidates } from "../../../secrets/provider-env-vars.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  completeProviderUseBindingMigration,
  prepareProviderUseBindingMigration,
} from "./provider-use-binding-migration.js";

vi.mock("./active-tool-schema-warnings.js", () => ({
  collectActiveToolSchemaProjectionWarnings: async () => [],
}));

const bundledPlugins = fileURLToPath(new URL("../../../../extensions/", import.meta.url));
const selectedPlan: OpenClawConfig = {
  agents: {
    defaults: { model: "byteplus-plan/ark-code-latest" },
    entries: { main: {} },
  },
};
const byteplusRef = { source: "env", provider: "default", id: "BYTEPLUS_API_KEY" };
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "provider-binding-migration",
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPlugins,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      BYTEPLUS_API_KEY: "fixture-byteplus-key",
      VOLCANO_ENGINE_API_KEY: "fixture-volcengine-key",
      MINIMAX_API_KEY: "fixture-minimax-shared-key",
      MINIMAX_CODE_PLAN_KEY: undefined,
      MINIMAX_CODING_API_KEY: undefined,
      MINIMAX_OAUTH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      MODEL_API_KEY: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
      AWS_PROFILE: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
    },
  });
});

afterEach(async () => {
  await state.cleanup();
});

function prepare(config: OpenClawConfig) {
  return prepareProviderUseBindingMigration({
    config,
    configPath: state.configPath,
    env: state.env,
  });
}

function admitted(config: OpenClawConfig) {
  return resolveProviderUseAdmission({
    config,
    env: state.env,
    providerEnvVars: resolveProviderBindingEnvVarCandidates({ config, env: state.env }),
  });
}

describe("selected shared-provider upgrade", () => {
  it.each(["entries", "list"] as const)(
    "preserves default, fallback and per-agent selections from the %s roster",
    async (roster) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "byteplus-plan/ark-code-latest",
              fallbacks: ["volcengine-plan/ark-code-latest"],
            },
          },
          ...(roster === "entries"
            ? { entries: { main: {}, worker: { model: "minimax/MiniMax-M2.7" } } }
            : { list: [{ id: "main" }, { id: "worker", model: "minimax/MiniMax-M2.7" }] }),
        },
      };
      const original = structuredClone(config);

      const result = await prepare(config);

      expect(result.pending).toBe(true);
      expect(result.config.models?.providers).toEqual({
        "byteplus-plan": { apiKey: byteplusRef, baseUrl: "", models: [] },
        "volcengine-plan": {
          apiKey: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
          baseUrl: "",
          models: [],
        },
        minimax: {
          apiKey: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
          baseUrl: "",
          models: [],
        },
      });
      expect(config).toEqual(original);
      expect(admitted(result.config).has("byteplus-plan")).toBe(true);
      expect(admitted(result.config).has("volcengine-plan")).toBe(true);
      expect(admitted(result.config).has("minimax-portal")).toBe(false);
      const second = await prepare(result.config);
      expect(second.config).toBe(result.config);
      expect(second.changes).toEqual([]);
    },
  );

  it("preserves persisted user and legacy pins without promoting automatic fallbacks", async () => {
    const config: OpenClawConfig = { agents: { entries: { main: {}, worker: {} } } };
    const pins: Array<{ agentId: string; name: string; entry: SessionEntry }> = [
      {
        agentId: "main",
        name: "user",
        entry: {
          sessionId: "pin-user",
          updatedAt: 1,
          providerOverride: "byteplus-plan",
          modelOverride: "ark-code-latest",
          modelOverrideSource: "user",
        },
      },
      {
        agentId: "worker",
        name: "legacy",
        entry: {
          sessionId: "pin-legacy",
          updatedAt: 2,
          providerOverride: "volcengine-plan",
          modelOverride: "volcengine-plan/ark-code-latest",
        },
      },
      {
        agentId: "main",
        name: "automatic",
        entry: {
          sessionId: "pin-auto",
          updatedAt: 3,
          providerOverride: "minimax",
          modelOverride: "MiniMax-M2.7",
          modelOverrideSource: "auto",
        },
      },
      {
        agentId: "worker",
        name: "default",
        entry: {
          sessionId: "pin-default",
          updatedAt: 4,
          providerOverride: "minimax-portal",
          modelOverride: "MiniMax-M2.7",
          modelOverrideSource: "default",
        },
      },
      {
        agentId: "worker",
        name: "legacy-automatic",
        entry: {
          sessionId: "pin-legacy-auto",
          updatedAt: 5,
          providerOverride: "minimax-portal",
          modelOverride: "MiniMax-M2.7",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "fixture-model",
        },
      },
    ];
    const scopes = pins.map(({ agentId, name }) => ({
      agentId,
      storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
      sessionKey: `agent:${agentId}:${name}`,
      env: state.env,
    }));
    for (let index = 0; index < pins.length; index += 1) {
      await replaceSessionEntry(scopes[index]!, pins[index]!.entry);
    }
    const before = scopes.map((scope) => loadSessionEntry(scope));

    const result = await prepare(config);

    expect(Object.keys(result.config.models?.providers ?? {}).toSorted()).toEqual([
      "byteplus-plan",
      "volcengine-plan",
    ]);
    expect(result.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(scopes.map((scope) => loadSessionEntry(scope))).toEqual(before);
    expect(admitted(result.config).has("minimax")).toBe(false);
    expect(admitted(result.config).has("minimax-portal")).toBe(false);
  });

  it("does not bind unselected siblings or selected generic credential providers", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "github-copilot/gpt-4o",
            fallbacks: ["amazon-bedrock/fixture", "google-vertex/fixture"],
          },
        },
      },
    };
    const env = {
      ...state.env,
      GITHUB_TOKEN: "fixture-github-token",
      GH_TOKEN: "fixture-gh-token",
      MODEL_API_KEY: "fixture-generic-key",
      AWS_PROFILE: "default",
      AWS_ACCESS_KEY_ID: "fixture-access",
      AWS_SECRET_ACCESS_KEY: "fixture-secret",
      GOOGLE_APPLICATION_CREDENTIALS: state.path("fixture-adc.json"),
    };
    await fs.writeFile(
      env.GOOGLE_APPLICATION_CREDENTIALS,
      JSON.stringify({ type: "authorized_user" }),
    );

    const result = await prepareProviderUseBindingMigration({
      config,
      configPath: state.configPath,
      env,
    });

    expect(result.config).toBe(config);
    expect(result.changes).toEqual([]);
    expect(result.pending).toBe(true);
    expect(result.config.models?.providers).toBeUndefined();
  });

  it("preserves an existing selected account instead of replacing it with a shared env key", async () => {
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "byteplus-plan:work": {
          type: "api_key",
          provider: "byteplus-plan",
          key: "fixture-account-key",
        },
      },
    });

    const result = await prepare(selectedPlan);

    expect(result.config).toBe(selectedPlan);
    expect(result.changes).toEqual([]);
    expect(result.config.models?.providers?.["byteplus-plan"]).toBeUndefined();
  });

  it.each([
    '{"models":null}',
    '{"models":{"providers":[]}}',
    '{"agents":{"defaults":{"model":{"primary":9,"fallbacks":[null,3,{}]}},"entries":{"broken":null}}}',
  ])("leaves malformed operator shapes intact: %s", async (serialized) => {
    const config: OpenClawConfig = JSON.parse(serialized);
    const result = await prepare(config);
    expect(result.config).toEqual(config);
    expect(result.changes).toEqual([]);
  });

  it("does not reopen a completed upgrade after binding removal or a later selection", async () => {
    const migrated = await prepare(selectedPlan);
    expect(migrated.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);

    for (const model of ["byteplus-plan/ark-code-latest", "volcengine-plan/ark-code-latest"]) {
      const config: OpenClawConfig = { agents: { defaults: { model } } };
      const result = await prepare(config);
      expect(result).toEqual({ config, changes: [], pending: false });
      expect(admitted(result.config).has(model.split("/")[0]!)).toBe(false);
    }
  });

  it("closes an empty successful upgrade before a new shared-key selection appears", async () => {
    const empty = await prepare({ agents: { entries: { main: {} } } });
    expect(empty.changes).toEqual([]);
    expect(empty.pending).toBe(true);
    expect(completeProviderUseBindingMigration(state.configPath, state.env)).toEqual([]);

    const result = await prepare(selectedPlan);
    expect(result).toEqual({ config: selectedPlan, changes: [], pending: false });
    expect(admitted(result.config).has("byteplus-plan")).toBe(false);
  });

  it("defers an incomplete recovered session inventory without binding or completing", async () => {
    const scope = {
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:damaged",
      env: state.env,
    };
    await replaceSessionEntry(scope, {
      sessionId: "damaged",
      updatedAt: 1,
      providerOverride: "byteplus-plan",
      modelOverride: "ark-code-latest",
      modelOverrideSource: "user",
    });
    // Deliberate corruption bypasses the normal writer so Doctor sees a recoverable row.
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
          "{",
          scope.sessionKey,
        );
      },
      { agentId: "main", env: state.env },
    );

    const result = await prepare(selectedPlan);

    expect(result).toMatchObject({ config: selectedPlan, changes: [], pending: false });
    expect(result.warnings).toEqual([expect.stringContaining("Rerun")]);
  });

  it("defers unreadable receipt state without creating a provider binding", async () => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    await fs.writeFile(databasePath, "not a SQLite database");

    const result = await prepare(selectedPlan);

    expect(result).toMatchObject({ config: selectedPlan, changes: [], pending: false });
    expect(result.warnings).toEqual([expect.stringContaining("Rerun")]);
  });
});

describe("Doctor provider-binding write composition", () => {
  it("persists a primary Plan env SecretRef and closes the upgrade after the actual write", async () => {
    const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    await state.writeConfig({
      ...selectedPlan,
      gateway: { mode: "local", auth: { mode: "token", token: "fixture-gateway-token" } },
      env: { vars: { BYTEPLUS_API_KEY: "fixture-byteplus-key" } },
    });

    const context = await prepareDoctorContext(state.configPath);
    expect(context.configResult.shouldWriteConfig).toBe(true);
    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    const persisted: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(persisted.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(context.configWriteRefusal).toBeUndefined();
    expect(await prepare(selectedPlan)).toEqual({
      config: selectedPlan,
      changes: [],
      pending: false,
    });
  });

  it("does not complete the upgrade when ambiguous include ownership blocks the config write", async () => {
    const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    const configDir = path.dirname(state.configPath);
    await fs.writeFile(
      path.join(configDir, "telemetry-a.json"),
      JSON.stringify({ otel: { protocol: "grpc" } }),
    );
    await fs.writeFile(
      path.join(configDir, "telemetry-b.json"),
      JSON.stringify({ otel: { enabled: true } }),
    );
    await state.writeConfig({
      ...selectedPlan,
      diagnostics: { $include: ["./telemetry-a.json", "./telemetry-b.json"] },
    });
    const original = await fs.readFile(state.configPath, "utf8");

    const context = await prepareDoctorContext(state.configPath);
    expect(context.configResult.shouldWriteConfig).toBe(false);
    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
    const retry = await prepare(selectedPlan);
    expect(retry.pending).toBe(true);
    expect(retry.config.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
  });

  it("records completion when the operator accepts a preview without repair flags", async () => {
    const { loadAndMaybeMigrateDoctorConfig } = await import("../../doctor-config-flow.js");
    const { createDoctorPrompter } = await import("../../doctor-prompter.js");
    const { runWriteConfigHealth } =
      await import("../../../flows/doctor-health-contribution-runners.config.js");
    await state.writeConfig(selectedPlan);
    const options = { json: true };
    const messages: string[] = [];
    const runtime = {
      log: () => {},
      error: () => {},
      exit: (code: number) => {
        throw new Error(`Unexpected Doctor exit ${code}`);
      },
    };
    const prompter = createDoctorPrompter({ runtime, options });
    const configResult = await loadAndMaybeMigrateDoctorConfig({
      options,
      runtime,
      prompter,
      confirm: async ({ message }) => {
        messages.push(message);
        return true;
      },
    });
    expect(messages).toContain("Apply recommended config repairs now?");
    expect(configResult.shouldWriteConfig).toBe(true);
    const context = {
      runtime,
      options,
      prompter,
      configResult,
      cfg: configResult.cfg,
      cfgForPersistence: structuredClone(configResult.cfg),
      sourceConfigValid: configResult.sourceConfigValid,
      configPath: state.configPath,
      env: state.env,
      runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
      invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
    };

    await runWriteConfigHealth(context, { runPostWriteRepairs: false });

    const persisted: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
    expect(persisted.models?.providers?.["byteplus-plan"]?.apiKey).toEqual(byteplusRef);
    expect(await prepare(selectedPlan)).toEqual({
      config: selectedPlan,
      changes: [],
      pending: false,
    });
  });
});
