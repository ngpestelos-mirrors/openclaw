// Crabbox sandbox backend: tool-call isolation on a Crabbox-leased box.
//
// The Gateway, agent loop, channels, and model credentials stay on the host.
// Only exec, file tools, and media reads run on a machine that Crabbox leases
// with a fixed, scope-derived lease ID and that the built-in SSH backend then
// drives. Replaying the same lease ID adopts the existing box, so a Gateway
// restart or a second session in the same scope never allocates a duplicate.
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import {
  createRemoteShellSandboxFsBridge,
  getSandboxBackendWorkdirResolver,
  requireSandboxBackendFactory,
  type CreateSandboxBackendParams,
  type RemoteShellSandboxHandle,
  type SandboxBackendFactory,
  type SandboxBackendHandle,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import type { ResolvedCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";
import { crabboxSandboxLeaseId } from "./crabbox-sandbox-lease.js";
import {
  parseCrabboxSshCommand,
  type CrabboxSandboxEndpoint,
} from "./crabbox-sandbox-ssh-command.js";

export const CRABBOX_SANDBOX_BACKEND_ID = "crabbox";
const CRABBOX_SANDBOX_SLUG = "openclaw-sandbox";
const CRABBOX_SANDBOX_WARMUP_TIMEOUT_MS = 10 * 60_000;
const CRABBOX_SANDBOX_INSPECT_TIMEOUT_MS = 60_000;
const CRABBOX_SANDBOX_SSH_TIMEOUT_MS = 60_000;
const CRABBOX_SANDBOX_STOP_TIMEOUT_MS = 5 * 60_000;
const CRABBOX_SANDBOX_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * Token-based providers (for example Daytona) mint a short-lived SSH user on
 * every `crabbox ssh`; the default token lifetime is 30 minutes, so endpoints
 * are re-resolved well before that.
 */
const CRABBOX_SANDBOX_ENDPOINT_REFRESH_MS = 10 * 60_000;
const LEASE_ID_PATTERN = /^cbx_[a-f0-9]{12}$/u;
const READY_STATES = new Set(["started", "running", "ready"]);

type CrabboxSandboxCommandRunner = (
  argv: string[],
  options: {
    cwd?: string;
    killProcessTree: boolean;
    maxOutputBytes: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
) => Promise<SpawnResult>;

export type CrabboxSandboxBackendDependencies = {
  openclawRoot: string;
  pluginConfig: ResolvedCrabboxSandboxConfig;
  runCommand?: CrabboxSandboxCommandRunner;
  now?: () => number;
  endpointRefreshMs?: number;
};

function crabboxSandboxConfigLabel(pluginConfig: ResolvedCrabboxSandboxConfig): string {
  return `${pluginConfig.provider ?? "configured"}/${pluginConfig.class ?? "default"}`;
}

function providerArgs(pluginConfig: ResolvedCrabboxSandboxConfig): string[] {
  return pluginConfig.provider ? ["--provider", pluginConfig.provider] : [];
}

function commandFailure(action: string, result: SpawnResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
  return new Error(`Crabbox sandbox ${action} failed: ${detail}`);
}

type CrabboxSandboxClient = {
  binary: string;
  pluginConfig: ResolvedCrabboxSandboxConfig;
  runCommand: CrabboxSandboxCommandRunner;
};

async function runCrabbox(
  client: CrabboxSandboxClient,
  action: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<SpawnResult> {
  let result: SpawnResult;
  try {
    result = await client.runCommand([client.binary, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      killProcessTree: true,
      maxOutputBytes: CRABBOX_SANDBOX_MAX_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw new Error(
      `Crabbox sandbox ${action} could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw commandFailure(action, result);
  }
  return result;
}

type LeaseState = { state: string; ready: boolean };

function parseLeaseInspection(leaseId: string, stdout: string): LeaseState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Crabbox sandbox inspect returned invalid JSON for ${leaseId}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Crabbox sandbox inspect returned no lease for ${leaseId}`);
  }
  const id = typeof parsed.id === "string" ? parsed.id : "";
  if (id !== leaseId) {
    throw new Error(
      `Crabbox sandbox inspect returned lease ${id || "<empty>"} instead of ${leaseId}`,
    );
  }
  const state = typeof parsed.state === "string" ? parsed.state : "";
  return { state, ready: parsed.ready === true || READY_STATES.has(state) };
}

async function inspectLease(
  client: CrabboxSandboxClient,
  leaseId: string,
  options: { cwd?: string; signal?: AbortSignal },
): Promise<LeaseState> {
  const result = await runCrabbox(
    client,
    "inspect",
    ["inspect", ...providerArgs(client.pluginConfig), "--id", leaseId, "--json"],
    { ...options, timeoutMs: CRABBOX_SANDBOX_INSPECT_TIMEOUT_MS },
  );
  return parseLeaseInspection(leaseId, result.stdout);
}

async function resolveEndpoint(
  client: CrabboxSandboxClient,
  leaseId: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<CrabboxSandboxEndpoint> {
  // `crabbox ssh` validates the repository claim, refreshes the lease, and
  // mints provider access; --show-secret is required for token users.
  const result = await runCrabbox(
    client,
    "ssh",
    ["ssh", ...providerArgs(client.pluginConfig), "--id", leaseId, "--show-secret"],
    { ...options, timeoutMs: CRABBOX_SANDBOX_SSH_TIMEOUT_MS },
  );
  return parseCrabboxSshCommand(result.stdout);
}

async function ensureLease(
  client: CrabboxSandboxClient,
  leaseId: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<void> {
  const { pluginConfig } = client;
  const args = [
    "warmup",
    ...providerArgs(pluginConfig),
    ...(pluginConfig.class ? ["--class", pluginConfig.class] : []),
    "--lease-id",
    leaseId,
    "--slug",
    CRABBOX_SANDBOX_SLUG,
    "--keep",
    ...(pluginConfig.ttl ? ["--ttl", pluginConfig.ttl] : []),
    ...(pluginConfig.idleTimeout ? ["--idle-timeout", pluginConfig.idleTimeout] : []),
  ];
  // Fixed-ID warmup is idempotent: an existing lease is adopted, never duplicated.
  await runCrabbox(client, "warmup", args, {
    cwd: options.cwd,
    timeoutMs: CRABBOX_SANDBOX_WARMUP_TIMEOUT_MS,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const lease = await inspectLease(client, leaseId, options);
  if (!lease.ready) {
    throw new Error(`Crabbox lease ${leaseId} is not ready (state=${lease.state || "unknown"})`);
  }
}

function createClient(dependencies: CrabboxSandboxBackendDependencies): CrabboxSandboxClient {
  return {
    binary: resolveCrabboxBinary({
      explicit: dependencies.pluginConfig.binary,
      openclawRoot: dependencies.openclawRoot,
    }),
    pluginConfig: dependencies.pluginConfig,
    runCommand: dependencies.runCommand ?? runCommandWithTimeout,
  };
}

function sshParamsFor(
  params: CreateSandboxBackendParams,
  endpoint: CrabboxSandboxEndpoint,
): CreateSandboxBackendParams {
  return {
    ...params,
    cfg: {
      ...params.cfg,
      backend: "ssh",
      ssh: {
        ...params.cfg.ssh,
        target: endpoint.target,
        identityFile: endpoint.identityFile,
        identityData: undefined,
        certificateFile: undefined,
        certificateData: undefined,
        // Crabbox records the lease's host key in its per-lease known_hosts on
        // first contact; leases are fresh machines, so keys are not pinned.
        knownHostsFile: endpoint.knownHostsFile,
        knownHostsData: undefined,
        strictHostKeyChecking: false,
        updateHostKeys: false,
      },
    },
  };
}

function remoteShellField(
  handle: SandboxBackendHandle,
  field: "remoteWorkspaceDir" | "remoteAgentWorkspaceDir",
): string | undefined {
  // SAFETY: optional read of the ssh backend's remote-shell fields; a missing field yields undefined.
  const value = (handle as Partial<RemoteShellSandboxHandle>)[field];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Lease a box for the scope, then hand the endpoint to the built-in SSH
 * backend, which owns seeding, exec, file tools, and workdir validation. The
 * inner SSH handle is rebuilt whenever the provider endpoint may have expired.
 */
export function createCrabboxSandboxBackendFactory(
  dependencies: CrabboxSandboxBackendDependencies,
): SandboxBackendFactory {
  const client = createClient(dependencies);
  const now = dependencies.now ?? (() => Date.now());
  const refreshMs = dependencies.endpointRefreshMs ?? CRABBOX_SANDBOX_ENDPOINT_REFRESH_MS;
  return async (params: CreateSandboxBackendParams): Promise<SandboxBackendHandle> => {
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error("Crabbox sandbox backend does not support sandbox.docker.binds.");
    }
    const leaseId = crabboxSandboxLeaseId(params.scopeKey);
    await ensureLease(client, leaseId, { cwd: params.workspaceDir });
    const sshFactory = requireSandboxBackendFactory("ssh");
    let inner = await sshFactory(
      sshParamsFor(params, await resolveEndpoint(client, leaseId, { cwd: params.workspaceDir })),
    );
    let resolvedAt = now();
    let refreshing: Promise<SandboxBackendHandle> | null = null;
    const current = async (): Promise<SandboxBackendHandle> => {
      if (now() - resolvedAt < refreshMs) {
        return inner;
      }
      refreshing ??= (async () => {
        try {
          const endpoint = await resolveEndpoint(client, leaseId, { cwd: params.workspaceDir });
          inner = await sshFactory(sshParamsFor(params, endpoint));
          resolvedAt = now();
          return inner;
        } finally {
          refreshing = null;
        }
      })();
      return await refreshing;
    };
    const remoteShell: RemoteShellSandboxHandle = {
      remoteWorkspaceDir: remoteShellField(inner, "remoteWorkspaceDir") ?? inner.workdir,
      remoteAgentWorkspaceDir: remoteShellField(inner, "remoteAgentWorkspaceDir") ?? inner.workdir,
      runRemoteShellScript: async (commandParams) => {
        const handle = await current();
        // The optional read below falls back to runShellCommand when the field is absent.
        // SAFETY: the ssh backend handle also implements RemoteShellSandboxHandle.
        const runner = handle as Partial<RemoteShellSandboxHandle>;
        if (runner.runRemoteShellScript) {
          return await runner.runRemoteShellScript(commandParams);
        }
        return await handle.runShellCommand(commandParams);
      },
    };
    return {
      id: CRABBOX_SANDBOX_BACKEND_ID,
      runtimeId: leaseId,
      runtimeLabel: leaseId,
      workdir: inner.workdir,
      env: inner.env,
      configLabel: crabboxSandboxConfigLabel(dependencies.pluginConfig),
      configLabelKind: "Lease",
      workdirValidation: inner.workdirValidation,
      workdirRoots: inner.workdirRoots,
      capabilities: inner.capabilities,
      validateWorkdir: async (workdir) => {
        const handle = await current();
        return handle.validateWorkdir ? await handle.validateWorkdir(workdir) : null;
      },
      discardPreparedWorkdir: (workdir) => inner.discardPreparedWorkdir?.(workdir),
      buildExecSpec: async (execParams) => await (await current()).buildExecSpec(execParams),
      finalizeExec: async (finalizeParams) => {
        await inner.finalizeExec?.(finalizeParams);
      },
      runShellCommand: async (commandParams) =>
        await (await current()).runShellCommand(commandParams),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({ sandbox, runtime: remoteShell }),
    };
  };
}

/** Sandbox list/recreate/prune drive the lease itself; no SSH is required. */
export function createCrabboxSandboxBackendManager(
  dependencies: CrabboxSandboxBackendDependencies,
): SandboxBackendManager {
  const client = createClient(dependencies);
  const configLabel = crabboxSandboxConfigLabel(dependencies.pluginConfig);
  return {
    async describeRuntime({ entry }) {
      if (!LEASE_ID_PATTERN.test(entry.containerName)) {
        return { running: false, configLabelMatch: false };
      }
      let lease: LeaseState;
      try {
        lease = await inspectLease(client, entry.containerName, {});
      } catch {
        return { running: false, actualConfigLabel: entry.image, configLabelMatch: false };
      }
      return {
        running: lease.ready,
        actualConfigLabel: entry.image,
        configLabelMatch: entry.image === configLabel,
      };
    },
    async removeRuntime({ entry }) {
      if (!LEASE_ID_PATTERN.test(entry.containerName)) {
        throw new Error(`Crabbox sandbox runtime ${entry.containerName} is not a fixed lease id`);
      }
      await runCrabbox(
        client,
        "stop",
        ["stop", ...providerArgs(client.pluginConfig), entry.containerName],
        { timeoutMs: CRABBOX_SANDBOX_STOP_TIMEOUT_MS },
      );
    },
  };
}

/** The remote workdir is the SSH backend's, rooted at agents.defaults.sandbox.ssh.workspaceRoot. */
export function resolveCrabboxSandboxWorkdir(params: CreateSandboxBackendParams): string {
  const resolver = getSandboxBackendWorkdirResolver("ssh");
  if (!resolver) {
    throw new Error("Crabbox sandbox backend requires the built-in ssh backend");
  }
  return resolver({ ...params, cfg: { ...params.cfg, backend: "ssh" } });
}
