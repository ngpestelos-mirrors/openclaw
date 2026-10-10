import { readClawStatus } from "../claws/lifecycle-state.js";
import { withAuthoredAgentRoster } from "../claws/migrate-validation.js";
import { preflightClawPackage } from "../claws/packages.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import {
  applyClawUpdatePlan,
  CLAW_UPDATE_RESULT_SCHEMA_VERSION,
  ClawUpdateMutationError,
} from "../claws/update-apply.js";
import { buildClawUpdatePlan, CLAW_UPDATE_PLAN_SCHEMA_VERSION } from "../claws/update-plan.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawExperimentalWarning,
  logClawUpdatePlanSummary,
} from "../cli/claws-cli-output.js";
import type { ClawsUpdateOptions } from "../cli/claws-cli.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawCommandServices } from "./command-runtime.js";

export async function executeClawUpdateCommand(
  target: string,
  opts: ClawsUpdateOptions,
  runtime: RuntimeEnv,
  services: ClawCommandServices,
): Promise<void> {
  services.assertCurrent();
  if (!opts.dryRun && (!opts.yes || !opts.planIntegrity)) {
    const message =
      "Claw update requires explicit consent; pass --dry-run to preview or --yes with --plan-integrity to apply supported actions.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code: "consent_required", message },
    });
    return;
  }

  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    emitClawFailure(runtime, opts.json, listedMcpServers.error, {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      valid: false,
      diagnostics: [
        {
          level: "error",
          code: "mcp_config_unavailable",
          phase: "plan",
          path: "$.mcpServers",
          message: listedMcpServers.error,
        },
      ],
    });
    return;
  }
  const config = withAuthoredAgentRoster(
    listedMcpServers.runtimeConfig ?? listedMcpServers.config,
    listedMcpServers.sourceConfigBeforeMigrations,
  );
  let source = opts.from;
  if (!source) {
    const status = await readClawStatus(target, {
      readOnly: true,
      sourceMcpServers: listedMcpServers.mcpServers,
    });
    if (status.records.length !== 1) {
      const message =
        status.records.length === 0
          ? `No installed Claw agent matches ${JSON.stringify(target)}.`
          : `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`;
      emitClawFailure(runtime, opts.json, message, {
        schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: true,
        mutationAllowed: false,
        valid: false,
        diagnostics: [
          {
            level: "error",
            code: status.records.length === 0 ? "claw_not_found" : "claw_ambiguous",
            phase: "plan",
            path: "$",
            message,
          },
        ],
      });
      return;
    }
    const recorded = status.records[0]!.install.claw;
    source = recorded.kind === "package" ? recorded.packageRoot : recorded.manifestPath;
  }

  const loaded = await readClawManifestFile(source, {
    allowLegacyDynamicToolProfile: !opts.from,
  });
  if (!loaded.ok) {
    const diagnostics = opts.from
      ? loaded.diagnostics
      : [
          ...loaded.diagnostics,
          {
            level: "error" as const,
            code: "recorded_source_unavailable",
            phase: "plan" as const,
            path: "$",
            message: "The recorded Claw source is unavailable; pass --from to override it.",
          },
        ];
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(diagnostics), {
      schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: true,
      mutationAllowed: false,
      valid: false,
      diagnostics,
    });
    return;
  }

  const plan = await buildClawUpdatePlan({
    agentId: target,
    targetManifest: loaded.manifest,
    targetClawMarkdownBody: loaded.clawMarkdownBody,
    targetOpenClawProfile: loaded.openClawProfile,
    targetSource: loaded.source,
    config,
    sourceMcpServers: listedMcpServers.mcpServers,
    packagePreflight: preflightClawPackage,
    diagnostics: loaded.diagnostics,
  });
  if (opts.dryRun || plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      runtime.log(
        `Claw update plan: ${plan.currentClaw?.name ?? target} ${plan.currentClaw?.version ?? "unknown"} -> ${plan.targetClaw?.version ?? "unknown"}`,
      );
      runtime.log(`Plan integrity: ${plan.planIntegrity}`);
      logClawUpdatePlanSummary(plan, runtime);
    }
    if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
      runtime.exit(1);
    }
    return;
  }

  try {
    const result = await applyClawUpdatePlan(
      plan,
      {
        targetManifest: loaded.manifest,
        targetClawMarkdownBody: loaded.clawMarkdownBody,
        targetOpenClawProfile: loaded.openClawProfile,
        targetSource: loaded.source,
      },
      {
        config,
        reloadPlugins: services.reloadPlugins,
        commitConfig: services.commitConfig,
        createConfigApplication: services.createConfigApplication,
        assertCurrent: services.assertCurrent,
        assertSettlementCurrent: services.assertSettlementCurrent,
        runSettlement: services.runSettlement,
        env: services.env,
        signal: services.signal,
        waitMs: services.waitMs,
        sourceMcpServers: listedMcpServers.mcpServers,
        consentPlanIntegrity: opts.planIntegrity,
        packagePreflight: preflightClawPackage,
        runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
        cronGateway: services.cronGateway,
      },
    );
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Updated agent: ${result.agentId}`);
    runtime.log(`Claw version: ${result.previousClaw.version} -> ${result.targetClaw.version}`);
  } catch (error) {
    const code = error instanceof ClawUpdateMutationError ? error.code : "update_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_UPDATE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: code === "update_partial" ? "partial" : "failed",
      error: { code, message },
    });
  }
}
