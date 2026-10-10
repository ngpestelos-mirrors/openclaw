import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { filterStringEntries } from "@openclaw/normalization-core";
import { CLAW_REMOVE_PLAN_SCHEMA_VERSION } from "../claws/lifecycle-remove-contract.js";
import {
  CLAW_ADD_PLAN_SCHEMA_VERSION,
  CLAW_OUTPUT_STABILITY,
  type ClawAddPlan,
  type ClawDiagnostic,
} from "../claws/types.js";
import type { ClawUpdatePlan } from "../claws/update-plan.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { redactSensitiveText } from "../logging/redact.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsAddOptions, ClawsRemoveOptions } from "./claws-cli.js";

export function emitClawFailure(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  message: string,
  payload: unknown,
): void {
  if (json) {
    writeRuntimeJson(runtime, payload);
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
}

export function formatClawDiagnostics(diagnostics: readonly ClawDiagnostic[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

export function logClawExperimentalWarning(runtime: RuntimeEnv): void {
  runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
}

function logClawPlanNotices(diagnostics: ClawDiagnostic[], runtime: RuntimeEnv): void {
  for (const diagnostic of diagnostics.filter((entry) => entry.level === "warning")) {
    runtime.log(redactSensitiveText(`Notice: ${diagnostic.message}`));
  }
}

export function logClawAgentConfiguration(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  const { model, subagents } = plan.agent.config;
  if (model !== undefined) {
    runtime.log(`Model: ${JSON.stringify(model)}`);
  }
  if (subagents) {
    const targets =
      subagents.allowAgents?.join(", ") || (subagents.allowAgents ? "none" : "inherited");
    runtime.log(`Delegation: ${targets}; mode: ${subagents.delegationMode ?? "inherited"}`);
  }
  logClawPlanNotices(plan.diagnostics, runtime);
}

export function logClawUpdatePlanSummary(plan: ClawUpdatePlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agentId}`);
  runtime.log(`Update actions: ${plan.summary.totalActions}`);
  runtime.log(
    `Add: ${plan.summary.added}; change: ${plan.summary.changed}; remove: ${plan.summary.removed}; release: ${plan.summary.released}; unchanged: ${plan.summary.unchanged}; manual: ${plan.summary.manual}`,
  );
  runtime.log(
    `Capability changes: ${plan.summary.capabilityChanges}; escalations requiring explicit review: ${plan.summary.capabilityEscalations}`,
  );
  runtime.log(`Plan integrity: ${plan.planIntegrity}`);
  logClawPlanNotices(plan.diagnostics, runtime);
  if (plan.summary.capabilityEscalations > 0) {
    runtime.log(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
  }
  for (const change of plan.capabilityChanges) {
    const current = change.current?.summary ?? "unset";
    const desired = change.desired?.summary ?? "unset";
    runtime.log(
      `  ${change.requiresDistinctConsent ? "!" : "-"} ${change.path}: ${current} -> ${desired} (${change.action})`,
    );
    runtime.log(redactSensitiveText(`      effect: ${JSON.stringify(change.effect)}`));
  }
  if (plan.readiness.requirements.length > 0) {
    runtime.log(`Setup requirements (${plan.readiness.requirements.length}):`);
    for (const requirement of plan.readiness.requirements) {
      runtime.log(redactSensitiveText(`  - ${JSON.stringify(requirement)}`));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.error(formatClawDiagnostics(plan.blockers));
  }
}

export function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  logClawAgentConfiguration(plan, runtime);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(
      `  Requirement ${action.target}: ${requirementState}${action.action === "install" ? " (installation requires this exact plan consent)" : ""}`,
    );
  }
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = action.details as Record<string, unknown> | undefined;
    const target =
      typeof server?.url === "string"
        ? redactSensitiveUrlLikeString(server.url)
        : typeof server?.command === "string"
          ? redactSensitiveArgv([server.command, ...filterStringEntries(server.args)]).join(" ")
          : "invalid declaration";
    runtime.log(`  MCP ${action.id}: ${target}`);
  }
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    runtime.log("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

export function requireClawPlanConsent(
  action: "add" | "remove",
  opts: ClawsAddOptions | ClawsRemoveOptions,
  runtime: RuntimeEnv,
): boolean {
  if (opts.dryRun || (opts.yes && opts.planIntegrity)) {
    return false;
  }
  const code = opts.yes ? "plan_integrity_required" : "consent_required";
  const message = opts.yes
    ? `Claw ${action} consent must include --plan-integrity from the exact dry-run plan.`
    : `Claw ${action} requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to ${action === "add" ? "create the new agent and workspace" : "remove owned state"}.`;
  emitClawFailure(runtime, opts.json, message, {
    schemaVersion:
      action === "add" ? CLAW_ADD_PLAN_SCHEMA_VERSION : CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    ok: false,
    error: { code, message },
  });
  return true;
}
