import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mutateConfigFileWithRetry, readConfigFileSnapshotForWrite } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAgent } from "./agent-create.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  ensureAgentWorkspace,
  isWorkspaceBootstrapPending,
} from "./workspace.js";

it("preserves env references from guided staging when preparation changes the environment", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "guided-stage-env",
  });
  const oldToken = process.env.GUIDED_STAGE_TOKEN;
  try {
    process.env.GUIDED_STAGE_TOKEN = "synthetic-read-value";
    const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    await state.writeConfig({
      ...config,
      gateway: { ...config.gateway, auth: { mode: "token", token: "${GUIDED_STAGE_TOKEN}" } },
    });
    const writeSnapshot = await readConfigFileSnapshotForWrite();
    const staged = writeSnapshot.snapshot.sourceConfig;
    expect(staged.gateway?.auth?.token).toBe("synthetic-read-value");
    await Promise.resolve();
    process.env.GUIDED_STAGE_TOKEN = "synthetic-after-guided-await";
    const created = await createAgent({
      name: "guided",
      workspace: state.path("guided-workspace"),
      stagedConfig: { config: staged, writeSnapshot },
      prepareConfigCommit: async () => {
        await Promise.resolve();
        process.env.GUIDED_STAGE_TOKEN = "synthetic-after-preparation";
      },
    });
    expect(created).toMatchObject({ status: "created", agentId: "guided" });
    const saved = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    expect(saved.gateway?.auth?.token).toBe("${GUIDED_STAGE_TOKEN}");
    expect(saved.agents?.entries?.guided).toBeDefined();
  } finally {
    if (oldToken === undefined) {
      delete process.env.GUIDED_STAGE_TOKEN;
    } else {
      process.env.GUIDED_STAGE_TOKEN = oldToken;
    }
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("keeps a fresh named workspace pending through the first run setup", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    label: "named-agent-hatch",
  });
  const workspace = state.path("named-workspace");

  try {
    const created = await createAgent({ name: "Researcher", workspace });

    expect(created).toMatchObject({ status: "created", bootstrapPending: true });
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);

    const firstRunWorkspace = await ensureAgentWorkspace({
      dir: workspace,
      ensureBootstrapFiles: true,
    });
    expect(firstRunWorkspace.bootstrapPending).toBe(true);
    expect(await isWorkspaceBootstrapPending(workspace)).toBe(true);
    expect(
      await fs.readFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME), "utf8"),
    ).not.toContain("Researcher");
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

it("records operator and agent creation provenance after roster commits", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "empty",
    label: "agent-creation-provenance",
  });
  try {
    await createAgent({ name: "Operator Child", workspace: state.path("operator-child") });
    await createAgent({
      name: "Agent Child",
      workspace: state.path("agent-child"),
      provenance: { createdVia: "agent", creatorAgentId: "main" },
    });

    expect(readAgentProvenance("operator-child", { env: state.env })).toMatchObject({
      agentId: "operator-child",
      createdVia: "operator",
      creatorAgentId: null,
      createdAtMs: expect.any(Number),
    });
    expect(readAgentProvenance("agent-child", { env: state.env })).toMatchObject({
      agentId: "agent-child",
      createdVia: "agent",
      creatorAgentId: "main",
      createdAtMs: expect.any(Number),
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});

describe("agent roster persistence", () => {
  async function addWorkerToConfig(config: unknown): Promise<OpenClawConfig> {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "agent-roster-write",
    });
    try {
      await state.writeConfig(config);
      const result = await createAgent({ name: "Worker", workspace: state.path("worker") });
      expect(result).toMatchObject({
        status: "created",
        agentId: "worker",
        configPath: state.configPath,
      });
      return JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  }

  it("writes injected main and a new worker as one complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({ gateway: { mode: "local" } });

    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries?.worker).toMatchObject({ workspace: expect.any(String) });
    expect(Object.values(persisted.agents?.entries ?? {})).not.toContainEqual(
      expect.objectContaining({ default: expect.anything() }),
    );
  });

  it("replaces a legacy list with the complete keyed roster", async () => {
    const persisted = await addWorkerToConfig({
      agents: {
        list: [
          { id: "main", default: true },
          { id: "ops", workspace: "/srv/ops" },
        ],
      },
    });

    expect(persisted.agents).not.toHaveProperty("list");
    expect(persisted.agents?.entries?.main).toMatchObject({ workspace: expect.any(String) });
    expect(persisted.agents?.entries).toMatchObject({
      ops: { workspace: "/srv/ops" },
      worker: { workspace: expect.any(String) },
    });
  });

  it("preserves a legacy list byte-for-byte during a non-roster mutation", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      scenario: "empty",
      label: "legacy-roster-non-roster-write",
    });
    const list = [
      { id: "main", default: true },
      { id: "ops", workspace: "/srv/ops" },
    ];
    try {
      await state.writeConfig({ agents: { list }, gateway: { port: 18789 } });
      await mutateConfigFileWithRetry({
        mutate: (config) => {
          config.gateway = { ...config.gateway, port: 19001 };
        },
      });

      const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      expect(JSON.stringify(persisted.agents?.list)).toBe(JSON.stringify(list));
      expect(persisted.agents).not.toHaveProperty("entries");
      expect(persisted.gateway?.port).toBe(19001);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  });
});
