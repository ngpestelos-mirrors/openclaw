import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, type GatewayLockHandle } from "../infra/gateway-lock.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { localStateOwnerFixtureEntrypoint } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const roots = useAutoCleanupTempDirTracker(afterAll);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

describe("agent roster offline ownership", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let owner: GatewayLockHandle | null;
  let claim: TestPortClaim;
  let config: string;

  beforeAll(async () => {
    root = roots.make("openclaw-agent-roster-owner-");
    env = environment(root);
    claim = await acquireTestPortBlock({ offsets: [0] });
    config = JSON.stringify({
      agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries: { main: {} } },
      gateway: { mode: "local", port: claim.port },
    });
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, config);
    openOpenClawStateDatabase({ env });
    await closeOpenClawStateDatabaseAsync();
    owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
    expect(owner).not.toBeNull();
  });
  afterAll(async () => {
    await owner?.release();
    await claim.release();
  });

  it.each([
    ["native creation", ["native-agent-create", "WORKSPACE"]],
    ["onboarding workspace", ["onboard-workspace", "WORKSPACE"]],
    ["setup", ["setup", "--baseline", "--workspace", "WORKSPACE", "--json"]],
    [
      "advanced creation",
      ["agents", "add", "advanced", "--role", "researcher", "--workspace", "WORKSPACE", "--json"],
    ],
    [
      "team creation",
      ["agents", "team", "create", "--workspace-root", "WORKSPACE", "--non-interactive", "--json"],
    ],
  ])("refuses live %s before creating state", async (name, args) => {
    const workspace = path.join(root, `uncreated-${name.replaceAll(" ", "-")}`);
    const result = await runCliProcessChild({
      nodeArgs: [...entrypoint, ...args.map((arg) => (arg === "WORKSPACE" ? workspace : arg))],
      env,
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("exclusive offline state ownership");
    expect(result.stderr).toContain("stop the Gateway");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(config);
    await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses plugin registry refresh with a live owner and persists it offline", async () => {
    const args = [...entrypoint, "plugins", "registry", "--refresh", "--json"];
    const live = await runCliProcessChild({ nodeArgs: args, env });
    expect(live.code, live.stderr).toBe(1);
    expect(live.stderr).toContain("exclusive offline state ownership");
    expect(live.stderr).toContain("stop the Gateway");
    expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(config);

    await owner?.release();
    owner = null;
    try {
      const offline = await runCliProcessChild({ nodeArgs: args, env });
      expect(offline.code, offline.stderr).toBe(0);
      expect(JSON.parse(offline.stdout)).toMatchObject({ refreshed: true, state: "fresh" });
      const next = await runCliProcessChild({
        nodeArgs: [...entrypoint, "plugins", "registry", "--json"],
        env,
      });
      expect(next.code, next.stderr).toBe(0);
      expect(JSON.parse(next.stdout)).toMatchObject({ state: "fresh", differences: [] });
      expect(await fs.readFile(env.OPENCLAW_CONFIG_PATH!, "utf8")).toBe(config);
    } finally {
      owner = await acquireGatewayLock({ env, port: claim.port, allowInTests: true, timeoutMs: 0 });
      expect(owner).not.toBeNull();
    }
  });

  it("creates the roster and workspace after the Gateway releases ownership", async () => {
    await owner?.release();
    owner = null;
    const workspace = path.join(root, "offline-workspace");
    const result = await runCliProcessChild({
      nodeArgs: [
        ...entrypoint,
        "agents",
        "add",
        "offline",
        "--workspace",
        workspace,
        "--non-interactive",
        "--json",
      ],
      env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ agentId: "offline", workspace });
    const next = await runCliProcessChild({
      nodeArgs: [...entrypoint, "agents", "list", "--json"],
      env,
    });
    expect(next.code, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toContainEqual(
      expect.objectContaining({ id: "offline", workspace }),
    );
    expect((await fs.stat(workspace)).isDirectory()).toBe(true);
    const successor = await acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0 });
    expect(successor).not.toBeNull();
    await successor?.release();
  });
});
