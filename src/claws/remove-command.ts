import {
  emitClawFailure,
  logClawExperimentalWarning,
  requireClawPlanConsent,
} from "../cli/claws-cli-output.js";
import type { ClawsRemoveOptions } from "../cli/claws-cli.js";
import { clawMonitorCleanupGateway } from "../cli/claws-cli.monitor-cleanup.js";
import { clawPackageRemovalGateway } from "../cli/claws-cli.package-removal.js";
import { clawRemovalJournalGateway } from "../cli/claws-cli.removal-journal.js";
import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { assertExperimentalClawsEnabled } from "./experimental.js";
import {
  applyClawRemovePlan,
  buildClawRemovePlan,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  ClawRemoveError,
} from "./lifecycle-state.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export async function executeClawRemoveCommand(
  target: string,
  opts: ClawsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  if (requireClawPlanConsent("remove", opts, runtime)) {
    return;
  }
  const selected = opts.removeReferenced ?? [];
  if (opts.removeUnused && selected.length > 0) {
    runtime.error("Choose either --remove-unused or --remove-referenced, not both.");
    runtime.exit(1);
    return;
  }
  if (opts.forceReferenced && selected.length === 0) {
    runtime.error("--force-referenced requires at least one --remove-referenced selector.");
    runtime.exit(1);
    return;
  }
  const referencedCleanup = selected.length
    ? {
        mode: "remove-selected" as const,
        selected,
        allowConflicts: Boolean(opts.forceReferenced),
      }
    : opts.removeUnused
      ? { mode: "remove-if-unused" as const }
      : { mode: "retain" as const };
  const plan = await buildClawRemovePlan(target, {
    referencedCleanup,
    monitorGateway: clawMonitorCleanupGateway,
  });
  if (opts.dryRun || plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`Remove actions: ${plan.actions.length}`);
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      for (const action of plan.actions.filter((candidate) => candidate.kind === "packageRef")) {
        runtime.log(
          `  Package ${action.target}: ${action.action}${action.reason ? ` (${action.reason})` : ""}`,
        );
      }
      for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
        runtime.log(
          `  MCP ${action.id}: ${action.action}${action.reason ? ` (${action.reason})` : ""}`,
        );
      }
      if (plan.blockers.length > 0) {
        runtime.error(plan.blockers.map((blocker) => blocker.message).join("\n"));
      }
    }
    if (plan.blockers.length > 0) {
      runtime.exit(1);
    }
    return;
  }
  try {
    const result = await applyClawRemovePlan(plan, {
      journalGateway: clawRemovalJournalGateway,
      monitorGateway: clawMonitorCleanupGateway,
      packageGateway: clawPackageRemovalGateway,
      consentPlanIntegrity: opts.planIntegrity,
      referencedCleanup,
      cronGateway: {
        get: async (id) => await callGatewayFromCli("cron.get", {}, { id }),
        remove: async (id) => await callGatewayFromCli("cron.remove", {}, { id }),
      },
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(`${result.agentRemoved ? "Removed agent" : "Agent"}: ${result.agentId}`);
      runtime.log(`Status: ${result.status}`);
      for (const pkg of result.packages) {
        runtime.log(
          `  Package ${pkg.kind}:${pkg.ref}@${pkg.version}: ${pkg.action}${pkg.reason ? ` (${pkg.reason})` : ""}`,
        );
      }
      runtime.log(`Package references released: ${result.packageRefsReleased}`);
      if (result.error) {
        runtime.error(result.error.message);
      }
      for (const warning of result.warnings ?? []) {
        runtime.log(`Warning: ${warning}`);
      }
      if (result.pluginRuntime) {
        runtime.log(
          `Plugin runtime changed in Gateway generation ${result.pluginRuntime.generation}.`,
        );
      }
    }
    if (result.status !== "complete") {
      runtime.exit(1);
    }
  } catch (error) {
    const code = error instanceof ClawRemoveError ? error.code : "remove_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}
