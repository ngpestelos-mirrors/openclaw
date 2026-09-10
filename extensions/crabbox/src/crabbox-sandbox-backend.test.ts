import path from "node:path";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  createCrabboxSandboxBackendFactory,
  createCrabboxSandboxBackendManager,
  resolveCrabboxSandboxWorkdir,
} from "./crabbox-sandbox-backend.js";
import { resolveCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";
import { crabboxSandboxLeaseId } from "./crabbox-sandbox-lease.js";
import { parseCrabboxSshCommand } from "./crabbox-sandbox-ssh-command.js";

type CrabboxSandboxCommandRunner = NonNullable<
  Parameters<typeof createCrabboxSandboxBackendFactory>[0]["runCommand"]
>;

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SCOPE_KEY = "agent:main:session:abc";
const LEASE_ID = crabboxSandboxLeaseId(SCOPE_KEY);

function spawnResult(stdout: string, code = 0): SpawnResult {
  return { stdout, stderr: "", code, signal: null, termination: "exit" } as SpawnResult;
}

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    provider: "daytona",
    state: "started",
    ready: true,
    sshUser: "",
    sshHost: "",
    sshPort: "",
    sshKey: "",
    ...overrides,
  });
}

const KEY_PATH = "/home/user/.config/crabbox/testboxes/lease/id_ed25519";
const KNOWN_HOSTS = "/home/user/.config/crabbox/testboxes/lease/known_hosts";

function sshCommand(
  user = "token-abc",
  host = "ssh.example.test",
  port = 2222,
  withKey = true,
): string {
  const key = withKey ? `'-i' '${KEY_PATH}' ` : "";
  return `warning: something informational\n'ssh' '-o' 'BatchMode=yes' ${key}'-p' '${port}' '-o' 'StrictHostKeyChecking=accept-new' '-o' 'UserKnownHostsFile=${KNOWN_HOSTS}' '${user}@${host}'\n`;
}

function respond(argv: string[], inspect = inspectJson(), ssh = sshCommand()): SpawnResult {
  switch (argv[1]) {
    case "inspect":
      return spawnResult(inspect);
    case "ssh":
      return spawnResult(ssh);
    default:
      return spawnResult(`leased ${LEASE_ID} slug=openclaw-sandbox\n`);
  }
}

function createParams(
  overrides: Partial<CreateSandboxBackendParams> = {},
): CreateSandboxBackendParams {
  return {
    sessionKey: SCOPE_KEY,
    scopeKey: SCOPE_KEY,
    workspaceDir: path.resolve(path.sep, "workspace", "project"),
    agentWorkspaceDir: path.resolve(path.sep, "workspace", "project"),
    cfg: {
      mode: "all",
      backend: "crabbox",
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: "/workspace",
      dockerTmpfsSource: "default",
      docker: {
        image: "unused",
        binds: [],
      } as unknown as CreateSandboxBackendParams["cfg"]["docker"],
      ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
      browser: createSandboxBrowserConfig(),
      tools: { allow: [], deny: [] } as CreateSandboxBackendParams["cfg"]["tools"],
      prune: createSandboxPruneConfig(),
    },
    ...overrides,
  };
}

function createRunner(handler: (argv: string[]) => SpawnResult | Promise<SpawnResult>) {
  const calls: string[][] = [];
  const runCommand = vi.fn<CrabboxSandboxCommandRunner>(async (argv) => {
    calls.push(argv);
    return await handler(argv);
  });
  return { calls, runCommand };
}

describe("crabbox sandbox lease identity", () => {
  it("derives a stable fixed lease id from the scope key", () => {
    expect(LEASE_ID).toMatch(/^cbx_[a-f0-9]{12}$/u);
    expect(crabboxSandboxLeaseId(SCOPE_KEY)).toBe(LEASE_ID);
    expect(crabboxSandboxLeaseId("agent:main:session:other")).not.toBe(LEASE_ID);
  });
});

describe("crabbox sandbox backend factory", () => {
  it("replays a fixed-id warmup and hands the inspected endpoint to the ssh backend", async () => {
    const { calls, runCommand } = createRunner((argv) => respond(argv));
    const factory = createCrabboxSandboxBackendFactory({
      openclawRoot: OPENCLAW_ROOT,
      pluginConfig: {
        provider: "daytona",
        class: "small",
        ttl: "2h",
        idleTimeout: "30m",
        binary: "/opt/bin/crabbox",
      },
      runCommand,
    });
    const params = createParams();
    const handle = await factory(params);
    expect(handle.id).toBe("crabbox");
    expect(handle.runtimeId).toBe(LEASE_ID);
    expect(handle.runtimeLabel).toBe(LEASE_ID);
    expect(handle.configLabel).toBe("daytona/small");
    expect(handle.configLabelKind).toBe("Lease");
    expect(handle.workdir.startsWith("/tmp/openclaw-sandboxes/")).toBe(true);
    expect(calls[0]).toEqual([
      "/opt/bin/crabbox",
      "warmup",
      "--provider",
      "daytona",
      "--class",
      "small",
      "--lease-id",
      LEASE_ID,
      "--slug",
      "openclaw-sandbox",
      "--keep",
      "--ttl",
      "2h",
      "--idle-timeout",
      "30m",
    ]);
    expect(calls[1]).toEqual([
      "/opt/bin/crabbox",
      "inspect",
      "--provider",
      "daytona",
      "--id",
      LEASE_ID,
      "--json",
    ]);
    expect(runCommand.mock.calls[0]?.[1]).toMatchObject({
      cwd: params.workspaceDir,
      killProcessTree: true,
    });

    // A second creation for the same scope replays the same lease id instead of allocating.
    const again = await factory(params);
    expect(again.runtimeId).toBe(LEASE_ID);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(2);
    expect(
      calls.filter((argv) => argv[1] === "warmup").every((argv) => argv.includes(LEASE_ID)),
    ).toBe(true);
  });

  it("omits provider and class when the plugin config leaves them to crabbox", async () => {
    const { calls, runCommand } = createRunner((argv) => respond(argv));
    const factory = createCrabboxSandboxBackendFactory({
      openclawRoot: OPENCLAW_ROOT,
      pluginConfig: { binary: "/opt/bin/crabbox" },
      runCommand,
    });
    await factory(createParams());
    expect(calls[2]).toEqual(["/opt/bin/crabbox", "ssh", "--id", LEASE_ID, "--show-secret"]);
    expect(calls[0]).toEqual([
      "/opt/bin/crabbox",
      "warmup",
      "--lease-id",
      LEASE_ID,
      "--slug",
      "openclaw-sandbox",
      "--keep",
    ]);
  });

  it("fails closed when warmup fails or the lease has no SSH endpoint", async () => {
    const failing = createRunner((argv) =>
      argv[1] === "warmup" ? spawnResult("", 4) : respond(argv),
    );
    await expect(
      createCrabboxSandboxBackendFactory({
        openclawRoot: OPENCLAW_ROOT,
        pluginConfig: { binary: "/opt/bin/crabbox" },
        runCommand: failing.runCommand,
      })(createParams()),
    ).rejects.toThrow(/warmup failed/u);

    const endpointless = createRunner((argv) =>
      argv[1] === "ssh" ? spawnResult("warning: only a warning\n") : respond(argv),
    );
    await expect(
      createCrabboxSandboxBackendFactory({
        openclawRoot: OPENCLAW_ROOT,
        pluginConfig: { binary: "/opt/bin/crabbox" },
        runCommand: endpointless.runCommand,
      })(createParams()),
    ).rejects.toThrow(/did not print an ssh command/u);

    const notReady = createRunner((argv) =>
      respond(argv, inspectJson({ ready: false, state: "stopped" })),
    );
    await expect(
      createCrabboxSandboxBackendFactory({
        openclawRoot: OPENCLAW_ROOT,
        pluginConfig: { binary: "/opt/bin/crabbox" },
        runCommand: notReady.runCommand,
      })(createParams()),
    ).rejects.toThrow(/not ready/u);

    const wrongLease = createRunner((argv) =>
      respond(argv, inspectJson({ id: "cbx_000000000000" })),
    );
    await expect(
      createCrabboxSandboxBackendFactory({
        openclawRoot: OPENCLAW_ROOT,
        pluginConfig: { binary: "/opt/bin/crabbox" },
        runCommand: wrongLease.runCommand,
      })(createParams()),
    ).rejects.toThrow(/instead of/u);
  });

  it("rejects docker binds", async () => {
    const { runCommand } = createRunner((argv) => respond(argv));
    const factory = createCrabboxSandboxBackendFactory({
      openclawRoot: OPENCLAW_ROOT,
      pluginConfig: { binary: "/opt/bin/crabbox" },
      runCommand,
    });
    const params = createParams();
    params.cfg.docker.binds = ["/host:/container"];
    await expect(factory(params)).rejects.toThrow(/docker\.binds/u);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("resolves the remote workdir without starting the lease", () => {
    const workdir = resolveCrabboxSandboxWorkdir(createParams());
    expect(workdir.startsWith("/tmp/openclaw-sandboxes/")).toBe(true);
  });
});

describe("crabbox ssh command parsing", () => {
  it("splits quoted tokens and extracts the endpoint", () => {
    expect(
      parseCrabboxSshCommand(
        `'ssh' '-o' 'UserKnownHostsFile=/tmp/known hosts' "-p" "2200" user@host`,
      ),
    ).toEqual({ target: "user@host:2200", knownHostsFile: "/tmp/known hosts" });
    expect(parseCrabboxSshCommand(sshCommand())).toEqual({
      target: "token-abc@ssh.example.test:2222",
      identityFile: KEY_PATH,
      knownHostsFile: KNOWN_HOSTS,
    });
    expect(parseCrabboxSshCommand(sshCommand("daytona", "10.0.0.5", 22, false))).toEqual({
      target: "daytona@10.0.0.5:22",
      knownHostsFile: KNOWN_HOSTS,
    });
    expect(parseCrabboxSshCommand("'ssh' '-p' '22' 'user@[fe80::1]'\n")).toMatchObject({
      target: "user@[fe80::1]:22",
    });
    expect(() => parseCrabboxSshCommand("'ssh' '-p' '70000' 'user@host'")).toThrow(/invalid port/u);
    expect(() => parseCrabboxSshCommand("'ssh' '-F' 'cfg' 'host'")).toThrow(/config-file/u);
    expect(() => parseCrabboxSshCommand("'ssh' 'hostonly'")).toThrow(/user@host/u);
  });
});

describe("crabbox sandbox endpoint refresh", () => {
  it("re-resolves the endpoint through crabbox ssh once it may have expired", async () => {
    let clock = 1_000_000;
    let sshCalls = 0;
    const { runCommand } = createRunner((argv) => {
      if (argv[1] === "ssh") {
        sshCalls += 1;
        return spawnResult(sshCommand(`token-${sshCalls}`));
      }
      return respond(argv);
    });
    const factory = createCrabboxSandboxBackendFactory({
      openclawRoot: OPENCLAW_ROOT,
      pluginConfig: { binary: "/opt/bin/crabbox" },
      runCommand,
      now: () => clock,
      endpointRefreshMs: 60_000,
    });
    const handle = await factory(createParams());
    expect(sshCalls).toBe(1);
    // Building exec specs does not connect; it only needs the current endpoint.
    await handle.buildExecSpec({ command: "true", env: {}, usePty: false }).catch(() => undefined);
    expect(sshCalls).toBe(1);
    clock += 61_000;
    await handle.buildExecSpec({ command: "true", env: {}, usePty: false }).catch(() => undefined);
    expect(sshCalls).toBe(2);
    await handle.buildExecSpec({ command: "true", env: {}, usePty: false }).catch(() => undefined);
    expect(sshCalls).toBe(2);
  });
});

describe("crabbox sandbox backend manager", () => {
  it("describes runtimes through inspect and removes them by stopping the lease", async () => {
    const { calls, runCommand } = createRunner((argv) =>
      argv[1] === "stop" ? spawnResult(`released ${LEASE_ID}\n`) : respond(argv),
    );
    const manager = createCrabboxSandboxBackendManager({
      openclawRoot: OPENCLAW_ROOT,
      pluginConfig: { provider: "daytona", binary: "/opt/bin/crabbox" },
      runCommand,
    });
    const entry = {
      containerName: LEASE_ID,
      backendId: "crabbox",
      sessionKey: SCOPE_KEY,
      createdAtMs: 0,
      lastUsedAtMs: 0,
      image: "daytona/default",
    };
    const config = {} as Parameters<typeof manager.describeRuntime>[0]["config"];
    await expect(manager.describeRuntime({ entry, config })).resolves.toEqual({
      running: true,
      actualConfigLabel: "daytona/default",
      configLabelMatch: true,
    });
    await manager.removeRuntime({ entry, config });
    expect(calls.at(-1)).toEqual(["/opt/bin/crabbox", "stop", "--provider", "daytona", LEASE_ID]);

    await expect(
      manager.describeRuntime({ entry: { ...entry, containerName: "not-a-lease" }, config }),
    ).resolves.toEqual({ running: false, configLabelMatch: false });
    await expect(
      manager.removeRuntime({ entry: { ...entry, containerName: "not-a-lease" }, config }),
    ).rejects.toThrow(/not a fixed lease id/u);
  });
});

describe("crabbox sandbox config", () => {
  it("stays unregistered without a sandbox block and tolerates sibling warmImages config", () => {
    expect(resolveCrabboxSandboxConfig(undefined)).toBeUndefined();
    expect(resolveCrabboxSandboxConfig({ warmImages: { keepPrevious: 1 } })).toBeUndefined();
    expect(
      resolveCrabboxSandboxConfig({
        warmImages: { keepPrevious: 1 },
        sandbox: { provider: " daytona ", class: "small", ttl: "90m", idleTimeout: "15m" },
      }),
    ).toEqual({ provider: "daytona", class: "small", ttl: "90m", idleTimeout: "15m" });
    expect(resolveCrabboxSandboxConfig({ sandbox: {} })).toEqual({});
  });

  it("rejects unknown keys, empty strings, and malformed durations", () => {
    expect(() => resolveCrabboxSandboxConfig({ sandbox: { ttl: "soon" } })).toThrow(/duration/u);
    expect(() => resolveCrabboxSandboxConfig({ sandbox: { region: "eu" } })).toThrow(
      /not a supported option/u,
    );
    expect(() => resolveCrabboxSandboxConfig({ sandbox: { provider: " " } })).toThrow(/non-empty/u);
    expect(() => resolveCrabboxSandboxConfig({ sandbox: "daytona" })).toThrow(/must be an object/u);
  });
});
