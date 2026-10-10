import {
  emitClawFailure,
  logClawExperimentalWarning,
  requireClawPlanConsent,
} from "../cli/claws-cli-output.js";
import type { ClawsRemoveOptions } from "../cli/claws-cli.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawCommandServices } from "./command-runtime.js";
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
  runtime: RuntimeEnv,
  services: ClawCommandServices,
): Promise<void> {
  services.assertCurrent();
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
    assertCurrent: services.assertCurrent,
    referencedCleanup,
    monitorGateway: services.monitorGateway,
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
      journalGateway: services.journalGateway,
      monitorGateway: services.monitorGateway,
      packageGateway: services.packageGateway,
      unsetMcpServer: services.unsetMcpServer,
      assertCurrent: services.assertCurrent,
      configWriteOptions: services.configWriteOptions,
      onConfigCommitted: services.onConfigCommitted,
      consentPlanIntegrity: opts.planIntegrity,
      referencedCleanup,
      cronGateway: services.cronGateway,
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
