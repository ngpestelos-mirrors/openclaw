/** Admission verdict for explicit Doctor maintenance before mutable repair. */
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasGatewayServiceStopUnsafeError } from "../daemon/service-inspection-error.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { ExecApprovalsMigrationRequiredError } from "../infra/exec-approvals-migration-gate.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import type { OpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";

/** Repair failures that cannot safely authorize restoring the stopped service. */
export function isDoctorMaintenanceRestorationUnsafe(error: unknown): boolean {
  if (hasGatewayServiceStopUnsafeError(error) || hasCommandProcessCleanupError(error)) {
    return true;
  }
  return collectNestedErrorCandidates(error).some(
    (cause) =>
      cause instanceof DoctorUnreadableStateDatabaseError ||
      cause instanceof DoctorStateMigrationRefusalError ||
      cause instanceof StartupMaintenanceRequiredError ||
      cause instanceof ExecApprovalsMigrationRequiredError ||
      cause instanceof UpdateSchemaRefusalError ||
      cause instanceof GatewayLockError ||
      (cause instanceof ConfigWritePostCommitError && cause.rollbackStatus !== "restored"),
  );
}

/** The same persisted-state admission protects completion and exceptional restoration. */
export async function assertDoctorMaintenanceReady(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<void> {
  const { assertSessionStoreMigrationComplete } =
    await import("../config/sessions/startup-migration.js");
  assertSessionStoreMigrationComplete({ cfg, env, operation: "doctor" });
  const { assertOpenClawDatabasesReady } = await import("../state/openclaw-database-preflight.js");
  const { resolveConfiguredAgentDatabaseTargets } = await import("../config/sessions/targets.js");
  await assertOpenClawDatabasesReady({
    env,
    config: cfg,
    operation: "doctor",
    onDeferredSchemaPublication: (publication) => log(publication.message),
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(cfg, { env }),
  });
  const { assertConfiguredWorkspaceStateReady } = await import("../agents/workspace-state-dirs.js");
  await assertConfiguredWorkspaceStateReady({ cfg, operation: "doctor" });
  const { assertNoPendingLegacyExecApprovals } =
    await import("../infra/exec-approvals-migration-gate.js");
  assertNoPendingLegacyExecApprovals({ operation: "doctor", env });
}

/** Repair may have committed config before a later diagnostic failed. */
export async function readDoctorMaintenanceRecoveryConfig(
  resources: Pick<OpenClawDatabaseMaintenanceScope, "run">,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): Promise<OpenClawConfig> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  return resources.run(async () => {
    const { config } = await readConfigFileSnapshot({
      skipPluginValidation: true,
      observe: false,
    });
    await assertDoctorMaintenanceReady(config, env, log);
    return config;
  });
}

export function assertDoctorMaintenanceInspection(
  inspection: PreManagedServiceStop,
  env: NodeJS.ProcessEnv,
): void {
  const kind = inspection.serviceUpdateVerdict?.kind;
  // Unavailable inspection grants no service authority. The state coordinators
  // and agent leases below still exclude live writers before repair.
  if (
    !inspection.blockMessage &&
    (kind === "unavailable" ||
      (inspection.inspected &&
        (kind === "owned" || kind === "absent" || inspection.offline === true)))
  ) {
    return;
  }
  throw new Error(
    inspection.blockMessage ??
      `Gateway service ownership or shutdown could not be verified. Run ${formatCliCommand("openclaw gateway status --deep", env)} and stop it through its service owner before retrying.`,
  );
}
