import type { Stats } from "node:fs";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { applyAgentConfig } from "../commands/agents.config.js";
import { transformConfigFileWithRetry } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { planWithPackageActions, sameCommittedAgent, statusAtLeast } from "./add-plan-helpers.js";
import { ClawBootstrapWriteError, seedClawPackageBootstrap } from "./bootstrap.js";
import {
  ClawCronInstallError,
  installClawCronJobs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import type { ClawMcpConfigApplicationOptions } from "./mcp.js";
import {
  ClawMcpInstallError,
  installClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import { ClawPackageInstallError, installClawPackages } from "./packages.js";
import {
  deleteClawInstallRecord,
  persistClawInstallRecord,
  updateClawInstallRecordStatus,
  type ClawInstallStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import { runClawSettlement } from "./update-rollback.js";
import {
  ClawWorkspaceWriteError,
  createClawWorkspaceFiles,
  type PersistedClawWorkspaceFile,
} from "./workspace.js";

export const CLAW_ADD_RESULT_SCHEMA_VERSION = "openclaw.clawAddResult.v1" as const;

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
type ClawAddApplyOptions = OpenClawStateDatabaseOptions &
  ClawMcpConfigApplicationOptions & {
    assertCurrent?: () => void;
    assertSettlementCurrent?: () => void;
    runSettlement?: <T>(operation: () => Promise<T>) => Promise<T>;
    signal?: AbortSignal;
    waitMs?: number;
    reloadPlugins?: PluginInstallBatchReload;
    consentPlanIntegrity?: string;
    resumeRecord?: PersistedClawInstall;
    resumePlan?: ClawAddPlan;
    commitConfig?: ConfigCommit;
    persistRecord?: typeof persistClawInstallRecord;
    deleteRecord?: typeof deleteClawInstallRecord;
    updateRecord?: typeof updateClawInstallRecordStatus;
    createWorkspaceFiles?: typeof createClawWorkspaceFiles;
    runtime?: RuntimeEnv;
    installPackages?: typeof installClawPackages;
    installMcpServers?: typeof installClawMcpServers;
    installCronJobs?: typeof installClawCronJobs;
    seedPackageBootstrap?: typeof seedClawPackageBootstrap;
    cronGateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
    nowMs?: number;
  };
export class ClawAddMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawAddMutationError";
  }
}

type ClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  mcpServers: PersistedClawMcpServerRef[];
  cronJobs: PersistedClawCronRef[];
  installRecord?: PersistedClawInstall;
  error?: {
    code: string;
    message: string;
    diagnostics?: ClawWorkspaceWriteError["diagnostics"];
  };
};

async function markInstallStatus(
  agentId: string,
  status: ClawInstallStatus,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): Promise<void> {
  await (options.updateRecord ?? updateClawInstallRecordStatus)(agentId, status, {
    ...options,
    expectedStatuses,
  });
}

async function clearUnownedInstallRecord(
  agentId: string,
  expectedStatuses: ClawInstallStatus[],
  options: ClawAddApplyOptions,
): Promise<void> {
  await (options.deleteRecord ?? deleteClawInstallRecord)(agentId, {
    ...options,
    expectedStatuses,
  });
}

function workspacePathKey(value: string): string {
  return process.platform === "win32" ? normalizeWindowsPathForComparison(value) : value;
}

function assertWorkspacePathUnchanged(workspace: string): void {
  const canonicalWorkspace = resolvePathViaExistingAncestorSync(workspace);
  if (workspacePathKey(canonicalWorkspace) !== workspacePathKey(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: expected ${JSON.stringify(workspace)}, resolved ${JSON.stringify(canonicalWorkspace)}.`,
    );
  }
}

export async function applyClawAddPlan(
  plan: ClawAddPlan,
  options: ClawAddApplyOptions = {},
): Promise<ClawAddResult> {
  options.assertCurrent?.();
  if (plan.blockers.length > 0) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (options.consentPlanIntegrity !== (options.resumePlan?.planIntegrity ?? plan.planIntegrity)) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan; run add --dry-run again.",
    );
  }

  const persistRecord = options.persistRecord ?? persistClawInstallRecord;
  let installRecord: PersistedClawInstall;
  try {
    installRecord = await persistRecord(plan, {
      ...options,
      status: "pending",
      expectedExistingRecord: options.resumeRecord,
      expectedExistingPlan: options.resumePlan,
      deferLegacyPlanUpgrade: options.resumePlan !== undefined,
    });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    throw new ClawAddMutationError("provenance_failed", (error as Error).message);
  }

  let workspaceCreated = false;
  let configCommitted = false;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  let packages: PersistedClawPackageRef[] = [];
  let mcpServers: PersistedClawMcpServerRef[] = [];
  let cronJobs: PersistedClawCronRef[] = [];
  const partialResult = ({
    installStatus = "partial",
    nowMs,
    ...overrides
  }: Partial<
    Pick<
      ClawAddResult,
      | "workspaceCreated"
      | "configCommitted"
      | "workspaceFiles"
      | "packages"
      | "mcpServers"
      | "cronJobs"
    >
  > & {
    installStatus?: ClawInstallStatus;
    nowMs?: number;
    error: ClawAddResult["error"];
  }): ClawAddResult => ({
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status: "partial",
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated,
    configCommitted,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    installRecord: {
      ...installRecord,
      status: installStatus,
      updatedAtMs: nowMs ?? Date.now(),
    },
    ...overrides,
  });

  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  const workspacePhaseRecorded = statusAtLeast(installRecord.status, "workspace_ready");
  let workspaceState: Stats | undefined;
  try {
    options.assertCurrent?.();
    assertWorkspacePathUnchanged(workspace);
    workspaceState = await lstat(workspace).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not inspect workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspacePhaseRecorded && workspaceState) {
    await markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return partialResult({
      workspaceCreated: false,
      configCommitted: false,
      packages: [],
      error: {
        code: "workspace_collision",
        message: `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      },
      nowMs: options.nowMs,
    });
  }
  if (workspaceState && !workspaceState.isDirectory()) {
    throw new ClawAddMutationError(
      "workspace_collision",
      `Workspace ${JSON.stringify(workspace)} is no longer a directory.`,
    );
  }

  workspaceCreated = workspaceState?.isDirectory() ?? false;
  configCommitted = statusAtLeast(installRecord.status, "config_committed");
  const installPackages = options.installPackages ?? installClawPackages;
  const preserveRecordedPhaseOrMarkPartial = async (): Promise<ClawInstallStatus> => {
    if (workspacePhaseRecorded) {
      return installRecord.status;
    }
    await markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
    return "partial";
  };

  const hostRequirementPlan = planWithPackageActions(
    plan,
    (action) => action.details?.kind === "plugin",
  );
  const hostRequirementActions = hostRequirementPlan.actions.filter(
    (action) => action.kind === "package",
  );
  if (hostRequirementActions.length > 0) {
    try {
      packages = await installPackages(hostRequirementPlan, options);
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const packageError = error instanceof ClawPackageInstallError ? error : undefined;
      const installStatus = await preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        packages: packageError?.installedPackages ?? packages,
        installStatus,
        error: {
          code: packageError?.code ?? "package_install_failed",
          message: packageError?.message ?? coerceErrorMessage(error),
        },
        nowMs: options.nowMs,
      });
    }
  }

  try {
    options.assertCurrent?.();
    assertWorkspacePathUnchanged(workspace);
    await mkdir(dirname(workspace), { recursive: true });
    options.assertCurrent?.();
    assertWorkspacePathUnchanged(workspace);
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    if (packages.length > 0) {
      const installStatus = await preserveRecordedPhaseOrMarkPartial();
      return partialResult({
        installStatus,
        error: {
          code: error instanceof ClawAddMutationError ? error.code : "workspace_parent_failed",
          message:
            error instanceof ClawAddMutationError
              ? error.message
              : `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }
    await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
    if (error instanceof ClawAddMutationError) {
      throw error;
    }
    throw new ClawAddMutationError(
      "workspace_parent_failed",
      `Could not create parent directory for workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
    );
  }

  if (!workspaceCreated) {
    try {
      options.assertCurrent?.();
      await mkdir(workspace);
      workspaceCreated = true;
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      await markInstallStatus(plan.agent.finalId, "partial", ["pending", "partial"], options);
      return partialResult({
        workspaceCreated: false,
        configCommitted: false,
        error: {
          code: "workspace_collision",
          message: `Could not create new workspace ${JSON.stringify(workspace)}: ${(error as Error).message}`,
        },
        nowMs: options.nowMs,
      });
    }

    try {
      if (!workspacePhaseRecorded) {
        await markInstallStatus(
          plan.agent.finalId,
          "workspace_ready",
          ["pending", "partial", "workspace_ready"],
          options,
        );
      }
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      const removedWorkspace = await rmdir(workspace)
        .then(() => true)
        .catch(() => false);
      if (removedWorkspace) {
        try {
          await clearUnownedInstallRecord(plan.agent.finalId, ["pending", "partial"], options);
        } catch (cleanupError) {
          if (hasSqliteWorkerOutcomeUnknown(cleanupError)) {
            throw cleanupError;
          }
          // Preserve the phase-write failure if the unowned attempt cannot be reconciled.
        }
      }
      throw new ClawAddMutationError("provenance_failed", (error as Error).message);
    }
  }

  // Seed and attest the consented package bootstrap while the workspace is still
  // private. Committing the agent config first makes the agent routable, so a
  // concurrent `sessions.create` can stock-seed BOOTSTRAP.md and strand the add at
  // `config_committed` with a seed conflict that no retry can clear.
  try {
    await (options.seedPackageBootstrap ?? seedClawPackageBootstrap)(plan, {
      ...options,
      ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    const installStatus: ClawInstallStatus = configCommitted
      ? "config_committed"
      : "workspace_ready";
    await markInstallStatus(
      plan.agent.finalId,
      installStatus,
      configCommitted ? ["config_committed"] : ["workspace_ready", "config_committed"],
      options,
    );
    return partialResult({
      installStatus,
      error: {
        code: error instanceof ClawBootstrapWriteError ? error.code : "bootstrap_write_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  try {
    const commit: ConfigCommit =
      options.commitConfig ??
      (async (transform) => {
        await transformConfigFileWithRetry({
          afterWrite: { mode: "auto" },
          writeOptions: {
            assertCurrent: () => {
              options.signal?.throwIfAborted();
              options.assertCurrent?.();
            },
          },
          transform: (config) => ({ nextConfig: transform(config) }),
        });
      });
    options.assertCurrent?.();
    await commit((config) => {
      options.assertCurrent?.();
      const existingAgents = listAgentEntries(config);
      const agentsToPreserve: AgentConfig[] =
        existingAgents.length > 0 ? existingAgents : [{ id: DEFAULT_AGENT_ID }];
      const configWithPreservedAgents: OpenClawConfig = {
        ...config,
        agents: {
          ...config.agents,
          entries: toAgentEntriesRecord(agentsToPreserve),
        },
      };
      const normalizedAgentId = normalizeAgentId(plan.agent.finalId);
      const existingAgent = agentsToPreserve.find(
        (agent) => normalizeAgentId(agent.id) === normalizedAgentId,
      );
      if (existingAgent) {
        if (sameCommittedAgent(existingAgent, plan)) {
          return config;
        }
        if (
          options.resumePlan &&
          options.resumeRecord?.schemaVersion === "openclaw.clawInstallRecord.v1" &&
          options.resumeRecord.status !== "complete" &&
          sameCommittedAgent(existingAgent, options.resumePlan)
        ) {
          return {
            ...configWithPreservedAgents,
            agents: {
              ...configWithPreservedAgents.agents,
              entries: toAgentEntriesRecord(
                agentsToPreserve.map((agent) =>
                  normalizeAgentId(agent.id) === normalizedAgentId ? plan.agent.config : agent,
                ),
              ),
            },
          };
        }
        throw new ClawAddMutationError(
          "agent_id_collision",
          "Agent " + JSON.stringify(plan.agent.finalId) + " was created after planning.",
        );
      }
      if (
        findOverlappingWorkspaceAgentIds(configWithPreservedAgents, plan.agent.finalId, workspace)
          .length > 0
      ) {
        throw new ClawAddMutationError(
          "workspace_collision",
          "Workspace " + JSON.stringify(workspace) + " is already assigned to an agent.",
        );
      }
      const nextConfig = applyAgentConfig(configWithPreservedAgents, {
        agentId: normalizedAgentId,
      });
      return {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          entries: {
            ...nextConfig.agents?.entries,
            ...toAgentEntriesRecord([plan.agent.config]),
          },
        },
      };
    });
    // The transform runs before persistence can still fail; record the fact only after commit.
    // Moving this into the callback retains the workspace and reports a write that never landed.
    configCommitted = true;
    try {
      await recordAgentProvenance(plan.agent.finalId, { createdVia: "claw" }, options);
    } catch (error) {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      throw new ClawAddMutationError("provenance_failed", coerceErrorMessage(error));
    }
    if (options.resumePlan && installRecord.schemaVersion === "openclaw.clawInstallRecord.v1") {
      installRecord = await persistRecord(plan, {
        ...options,
        status: "pending",
        expectedExistingRecord: options.resumeRecord,
        expectedExistingPlan: options.resumePlan,
      });
    }
    await markInstallStatus(
      plan.agent.finalId,
      "config_committed",
      ["workspace_ready", "config_committed"],
      options,
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    let installStatus: ClawInstallStatus = "workspace_ready";
    if (!configCommitted) {
      await runClawSettlement(options, async () => {
        const removedWorkspace = await rmdir(workspace)
          .then(() => true)
          .catch(() => false);
        if (removedWorkspace) {
          workspaceCreated = false;
          installStatus = "partial";
          await markInstallStatus(plan.agent.finalId, "partial", ["workspace_ready", "partial"], {
            ...options,
            signal: undefined,
            assertCurrent: options.assertSettlementCurrent ?? options.assertCurrent,
          });
        }
      });
    }
    return partialResult({
      installStatus,
      error: {
        code: error instanceof ClawAddMutationError ? error.code : "config_commit_failed",
        message: coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const createFiles = options.createWorkspaceFiles ?? createClawWorkspaceFiles;
  try {
    workspaceFiles = await createFiles(plan, options);
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    const workspaceError =
      error instanceof ClawWorkspaceWriteError
        ? error
        : new ClawWorkspaceWriteError(
            [
              {
                level: "error",
                code: "workspace_file_io_error",
                phase: "mutation",
                path: "$.workspace",
                message: coerceErrorMessage(error),
              },
            ],
            workspaceFiles,
          );
    await markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      workspaceFiles: workspaceError.createdFiles,
      installStatus: "config_committed",
      nowMs: options.nowMs,
      error: {
        code: "workspace_files_failed",
        message: workspaceError.message,
        diagnostics: workspaceError.diagnostics,
      },
    });
  }

  try {
    // Skills require their workspace. Recurring work is enabled only after all
    // package mutation succeeds.
    const workspacePackagePlan = planWithPackageActions(
      plan,
      (action) => action.details?.kind !== "plugin",
    );
    const workspacePackageActions = workspacePackagePlan.actions.filter(
      (action) => action.kind === "package",
    );
    if (workspacePackageActions.length > 0) {
      const workspacePackages = await installPackages(workspacePackagePlan, options);
      packages = [...packages, ...workspacePackages];
    }
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    const packageError = error instanceof ClawPackageInstallError ? error : undefined;
    return partialResult({
      packages: [...packages, ...(packageError?.installedPackages ?? [])],
      installStatus: "config_committed",
      error: {
        code: packageError?.code ?? "package_install_failed",
        message: packageError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const installMcpServers = options.installMcpServers ?? installClawMcpServers;
  try {
    mcpServers = await installMcpServers(plan, options);
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    const mcpError = error instanceof ClawMcpInstallError ? error : undefined;
    await markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      mcpServers: mcpError?.mcpServers ?? mcpServers,
      installStatus: "config_committed",
      error: {
        code: mcpError?.code ?? "mcp_install_failed",
        message: mcpError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  const installCronJobs = options.installCronJobs ?? installClawCronJobs;
  try {
    cronJobs = await installCronJobs(plan, { ...options, gateway: options.cronGateway });
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    const cronError = error instanceof ClawCronInstallError ? error : undefined;
    await markInstallStatus(plan.agent.finalId, "config_committed", ["config_committed"], options);
    return partialResult({
      cronJobs: cronError?.cronJobs ?? cronJobs,
      installStatus: "config_committed",
      error: {
        code: cronError?.code ?? "cron_install_failed",
        message: cronError?.message ?? coerceErrorMessage(error),
      },
      nowMs: options.nowMs,
    });
  }

  try {
    await markInstallStatus(
      plan.agent.finalId,
      "complete",
      ["config_committed", "complete"],
      options,
    );
    return {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      mutationAllowed: true,
      planIntegrity: plan.planIntegrity,
      status: "complete",
      claw: plan.claw,
      agent: plan.agent,
      workspaceCreated,
      configCommitted,
      packages,
      mcpServers,
      cronJobs,
      workspaceFiles,
      installRecord: {
        ...installRecord,
        status: "complete",
        updatedAtMs: options.nowMs ?? Date.now(),
      },
    };
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return partialResult({
      error: { code: "provenance_failed", message: (error as Error).message },
    });
  }
}
