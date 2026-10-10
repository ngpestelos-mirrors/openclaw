import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { authorizeLegacyV1Resume } from "../cli/claws-cli-legacy-resume.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawExperimentalWarning,
} from "../cli/claws-cli-output.js";
import { logClawAddPlanSummary, requireClawPlanConsent } from "../cli/claws-cli-output.js";
import type { ClawsAddOptions } from "../cli/claws-cli.js";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { applyClawAddPlan, CLAW_ADD_RESULT_SCHEMA_VERSION, ClawAddMutationError } from "./add.js";
import type { ClawCommandServices } from "./command-runtime.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { findResumableIntroducedPluginRequirement } from "./package-resume.js";
import { preflightClawPackage } from "./packages.js";
import { readClawPackageOwnership } from "./provenance-async.js";
import { clawInstallRecordMatchesPlan, type PersistedClawInstall } from "./provenance.js";
import { readClawManifestFile } from "./reader.js";
import { CLAW_ADD_PLAN_SCHEMA_VERSION, CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";

async function matchingResumeState(plan: ClawAddPlan) {
  const snapshot = await readClawPackageOwnership({ agentId: plan.agent.finalId });
  const record = snapshot.install;
  if (
    !record ||
    record.status === "complete" ||
    record.workspace !== plan.agent.workspace ||
    record.claw.kind !== plan.claw.kind ||
    record.claw.name !== plan.claw.name ||
    record.claw.version !== plan.claw.version ||
    record.claw.integrity !== plan.claw.integrity
  ) {
    return undefined;
  }
  return {
    record,
    packageRefs: snapshot.packageRefs,
  };
}

export async function executeClawAddCommand(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv,
  services: ClawCommandServices,
): Promise<void> {
  services.assertCurrent();
  if (requireClawPlanConsent("add", opts, runtime)) {
    return;
  }
  let legacyV1ResumeRecord: PersistedClawInstall | undefined;
  const result = await readClawManifestFile(sourcePath, {
    authorizeLegacyDynamicToolProfile: async ({ manifest, source }) => {
      legacyV1ResumeRecord = await authorizeLegacyV1Resume({ manifest, source, opts });
      return legacyV1ResumeRecord !== undefined;
    },
  });
  if (!result.ok) {
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_ADD_PLAN_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const config = getRuntimeConfig();
  const listedMcpServers = await listConfiguredMcpServers();
  if (!listedMcpServers.ok) {
    runtime.error(listedMcpServers.error);
    runtime.exit(1);
    return;
  }
  const existingAgentIds = listAgentIds(config);
  const existingWorkspacePaths = existingAgentIds.map((agentId) =>
    resolveAgentWorkspaceDir(config, agentId),
  );
  const basePlanContext = {
    config,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    existingAgentIds,
    existingWorkspacePaths,
    existingMcpServers: listedMcpServers.mcpServers,
    packagePreflight: preflightClawPackage,
  };
  const planInput = {
    manifest: result.manifest,
    clawMarkdownBody: result.clawMarkdownBody,
    packageBootstrap: result.packageBootstrap,
    openClawProfile: result.openClawProfile,
    source: result.source,
    diagnostics: result.diagnostics,
  };
  let plan = await buildClawAddPlan({ ...planInput, context: basePlanContext });
  let legacyResumePlan = result.legacyOpenClawProfile
    ? await buildClawAddPlan({
        ...planInput,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        context: basePlanContext,
      })
    : undefined;
  let resumableInstallRecord: PersistedClawInstall | undefined;
  const resumeState = await matchingResumeState(legacyResumePlan ?? plan);
  if (result.legacyOpenClawProfile && !resumeState) {
    plan = {
      ...plan,
      blockers: [
        ...plan.blockers,
        {
          level: "error",
          code: "claw_resume_plan_mismatch",
          phase: "plan",
          path: "$",
          message:
            "The incomplete Claw add no longer matches the previously consented plan; remove its partial state before retrying.",
        },
      ],
    };
  }
  if (resumeState) {
    const { record: resumeRecord, packageRefs: resumePackageRefs } = resumeState;
    resumableInstallRecord = resumeRecord;
    const packagePreflight = async (
      pkg: Parameters<typeof preflightClawPackage>[0],
      workspace: string,
    ) => {
      const preflight = await preflightClawPackage(pkg, workspace);
      return findResumableIntroducedPluginRequirement({
        agentId: resumeRecord.agentId,
        pkg,
        preflight,
        refs: resumePackageRefs,
      })
        ? { ...preflight, action: "install" as const }
        : preflight;
    };
    const canResumeWorkspace =
      resumeRecord.status === "workspace_ready" || resumeRecord.status === "config_committed";
    const expectedCommittedAgentConfigs = legacyResumePlan
      ? [legacyResumePlan.agent.config, plan.agent.config]
      : [plan.agent.config];
    const committedAgent = listAgentEntries(config).find(
      (agent) =>
        agent.id === resumeRecord.agentId &&
        expectedCommittedAgentConfigs.some(
          (expected) => stableStringify(agent) === stableStringify(expected),
        ),
    );
    const canResumeAgent =
      resumeRecord.status === "config_committed" ||
      (resumeRecord.status === "workspace_ready" && committedAgent !== undefined);
    const resumePlanContext = {
      ...basePlanContext,
      packagePreflight,
      existingAgentIds: canResumeAgent
        ? existingAgentIds.filter((agentId) => agentId !== resumeRecord.agentId)
        : existingAgentIds,
      existingWorkspacePaths: canResumeWorkspace
        ? existingAgentIds
            .filter((agentId) => agentId !== resumeRecord.agentId)
            .map((agentId) => resolveAgentWorkspaceDir(config, agentId))
        : existingWorkspacePaths,
      ...(canResumeWorkspace ? { resumableWorkspace: resumeRecord.workspace } : {}),
    };
    plan = await buildClawAddPlan({ ...planInput, context: resumePlanContext });
    if (result.legacyOpenClawProfile) {
      legacyResumePlan = await buildClawAddPlan({
        ...planInput,
        openClawProfile: result.legacyOpenClawProfile,
        reconstructLegacyDynamicToolProfilePlan: true,
        context: resumePlanContext,
      });
    }
    const expectedResumePlan = legacyResumePlan ?? plan;
    const exactLegacyResume =
      !legacyResumePlan ||
      (legacyV1ResumeRecord !== undefined &&
        stableStringify(legacyV1ResumeRecord) === stableStringify(resumeRecord));
    if (
      plan.blockers.length === 0 &&
      (!exactLegacyResume || !clawInstallRecordMatchesPlan(resumeRecord, expectedResumePlan))
    ) {
      plan = {
        ...plan,
        blockers: [
          ...plan.blockers,
          {
            level: "error",
            code: "claw_resume_plan_mismatch",
            phase: "plan",
            path: "$",
            message:
              "The incomplete Claw add no longer matches the current plan; remove its partial state before retrying.",
          },
        ],
      };
    }
  }

  if (opts.dryRun || plan.blockers.length > 0) {
    if (opts.json) {
      writeRuntimeJson(runtime, plan);
    } else {
      logClawExperimentalWarning(runtime);
      if (plan.blockers.length === 0) {
        runtime.log(`Claw add plan: ${plan.claw.name}@${plan.claw.version}`);
      }
      logClawAddPlanSummary(plan, runtime);
      if (plan.blockers.length > 0) {
        runtime.error(formatClawDiagnostics(plan.blockers));
      }
    }
    if (plan.blockers.length > 0) {
      runtime.exit(1);
    }
    return;
  }

  const consentPlanIntegrity = legacyResumePlan?.planIntegrity ?? plan.planIntegrity;
  if (opts.planIntegrity !== consentPlanIntegrity) {
    const message = "The consented Claw plan no longer matches; run add --dry-run again.";
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      planIntegrity: plan.planIntegrity,
      error: { code: "plan_integrity_mismatch", message },
    });
    return;
  }

  let addResult;
  if (!opts.json) {
    logClawExperimentalWarning(runtime);
  }
  try {
    addResult = await applyClawAddPlan(plan, {
      reloadPlugins: services.reloadPlugins,
      commitConfig: services.commitConfig,
      createConfigApplication: services.createConfigApplication,
      assertCurrent: services.assertCurrent,
      assertSettlementCurrent: services.assertSettlementCurrent,
      runSettlement: services.runSettlement,
      env: services.env,
      signal: services.signal,
      waitMs: services.waitMs,
      consentPlanIntegrity: opts.planIntegrity,
      resumeRecord: resumableInstallRecord,
      resumePlan: legacyResumePlan,
      runtime: opts.json ? { ...runtime, log: () => undefined } : runtime,
      cronGateway: services.cronGateway,
    });
  } catch (error) {
    const code = error instanceof ClawAddMutationError ? error.code : "add_failed";
    const message = coerceErrorMessage(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, addResult);
  } else {
    runtime.log(`Added agent: ${addResult.agent.finalId}`);
    runtime.log(`Workspace: ${addResult.agent.workspace}`);
    runtime.log(`Status: ${addResult.status}`);
    if (addResult.error) {
      runtime.error(addResult.error.message);
    }
  }
  if (addResult.status !== "complete") {
    runtime.exit(1);
  }
}
