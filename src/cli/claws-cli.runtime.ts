import {
  findClawExtensionPackageCollisions,
  planClawExtensions,
} from "../claws/application-plan.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import {
  CLAW_EXPORT_RESULT_SCHEMA_VERSION,
  ClawExportError,
  exportClawAgent,
} from "../claws/export.js";
import { readClawStatus } from "../claws/lifecycle-state.js";
import { preflightClawPackage } from "../claws/packages.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_INSPECT_RESULT_SCHEMA_VERSION, CLAW_OUTPUT_STABILITY } from "../claws/types.js";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  emitClawFailure,
  formatClawDiagnostics,
  logClawExperimentalWarning,
} from "./claws-cli-output.js";
import type {
  ClawsAddOptions,
  ClawsExportOptions,
  ClawsInspectOptions,
  ClawsRemoveOptions,
  ClawsStatusOptions,
} from "./claws-cli.js";

export async function runClawsInspectCommand(
  sourcePath: string,
  opts: ClawsInspectOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await readClawManifestFile(sourcePath);
  if (!result.ok) {
    emitClawFailure(runtime, opts.json, formatClawDiagnostics(result.diagnostics), {
      schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      valid: false,
      diagnostics: result.diagnostics,
    });
    return;
  }

  const extensionPlan = await planClawExtensions({
    extensions: result.openClawProfile?.extensions ?? [],
    workspace: result.source.packageRoot,
    packagePreflight: preflightClawPackage,
  });
  const extensionCollisions = findClawExtensionPackageCollisions({
    packages: result.manifest.packages,
    extensions: result.openClawProfile?.extensions ?? [],
  });
  const diagnostics = [
    ...result.diagnostics,
    ...extensionPlan.blockers,
    ...extensionCollisions.map(({ diagnostic }) => diagnostic),
  ];
  const valid = diagnostics.every((diagnostic) => diagnostic.level !== "error");
  const payload = {
    schemaVersion: CLAW_INSPECT_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    valid,
    source: result.source,
    manifest: result.manifest,
    ...(result.openClawProfile ? { openClawProfile: result.openClawProfile } : {}),
    extensions: extensionPlan.extensions,
    diagnostics,
  };
  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    if (!valid) {
      runtime.exit(1);
    }
    return;
  }
  logClawExperimentalWarning(runtime);
  runtime.log(`Claw: ${result.source.name}@${result.source.version}`);
  runtime.log(`Agent: ${result.manifest.agent.name ?? result.manifest.agent.id}`);
  runtime.log(`Packages: ${result.manifest.packages.length}`);
  runtime.log(`Extension requirements: ${extensionPlan.extensions.length}`);
  for (const extension of extensionPlan.extensions) {
    runtime.log(
      `  ${extension.id}: ${extension.requirementState}; ${extension.detectedFormat ?? "unresolved"} -> ${(extension.mapped ?? []).join(", ") || "no mapped capabilities"}`,
    );
  }
  runtime.log(`MCP servers: ${Object.keys(result.manifest.mcpServers).length}`);
  runtime.log(`Cron jobs: ${result.manifest.cronJobs.length}`);
  if (!valid) {
    runtime.error(formatClawDiagnostics(diagnostics));
    runtime.exit(1);
  }
}

export async function runClawsAddCommand(
  sourcePath: string,
  opts: ClawsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const { executeClawAddCommand } = await import("../claws/add-command.js");
  const { runClawCommandWithOwner } = await import("./claws-command-owner.js");
  await runClawCommandWithOwner(
    "claws.add",
    { source: sourcePath, options: opts },
    runtime,
    (services, output) => executeClawAddCommand(sourcePath, opts, output, services),
  );
}

export async function runClawsStatusCommand(
  target: string | undefined,
  opts: ClawsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const status = await readClawStatus(target);
  if (opts.json) {
    writeRuntimeJson(runtime, status);
  } else {
    logClawExperimentalWarning(runtime);
    runtime.log(`Installed Claws: ${status.summary.claws}`);
    for (const record of status.records) {
      runtime.log(
        `${record.install.agentId}: ${record.install.claw.name}@${record.install.claw.version} (${record.install.status})`,
      );
      runtime.log(
        `  Agent: ${record.agentState}; bootstrap: ${record.bootstrapState}; files: ${record.workspaceFiles.length}; packages: ${record.packages.length}`,
      );
    }
  }
  if (target && status.records.length === 0) {
    runtime.exit(1);
  }
}

export async function runClawsRemoveCommand(
  target: string,
  opts: ClawsRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const { executeClawRemoveCommand } = await import("../claws/remove-command.js");
  const { runClawCommandWithOwner } = await import("./claws-command-owner.js");
  await runClawCommandWithOwner(
    "claws.remove",
    { target, options: opts },
    runtime,
    (services, output) => executeClawRemoveCommand(target, opts, output, services),
  );
}

export async function runClawsExportCommand(
  agentId: string,
  opts: ClawsExportOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  try {
    const listedMcpServers = await listConfiguredMcpServers();
    if (!listedMcpServers.ok) {
      throw new ClawExportError("mcp_config_unavailable", listedMcpServers.error);
    }
    const result = await exportClawAgent(agentId, opts.out, {
      config: getRuntimeConfig(),
      sourceMcpServers: listedMcpServers.mcpServers,
      ...(opts.bootstrap ? { bootstrapPath: opts.bootstrap } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Exported agent: ${result.agentId}`);
    runtime.log(`Package directory: ${result.outputDirectory}`);
    runtime.log(
      `Workspace files: ${result.manifest.workspace.files.length + Object.keys(result.manifest.workspace.bootstrapFiles).length}`,
    );
    runtime.log(`Packages: ${result.manifest.packages.length}`);
    runtime.log(`Bootstrap: ${result.filesWritten.includes("BOOTSTRAP.md") ? "included" : "none"}`);
  } catch (error) {
    const code = error instanceof ClawExportError ? error.code : "export_failed";
    const message = error instanceof Error ? error.message : String(error);
    emitClawFailure(runtime, opts.json, message, {
      schemaVersion: CLAW_EXPORT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      status: "failed",
      error: { code, message },
    });
  }
}
