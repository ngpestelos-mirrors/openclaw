import {
  normalizeUpdateFailureFacts,
  type UpdateFailureFact,
} from "../../infra/update-failure-facts.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { formatCliCommand } from "../command-format.js";

export type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

export function collectPostCorePluginFailureFacts(
  result: PostCorePluginUpdateResult,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureFact[] {
  if (result.status !== "error") {
    return [];
  }
  if (result.failureFacts?.length) {
    return normalizeUpdateFailureFacts(result.failureFacts, env);
  }
  const failures: UpdateFailureFact[] = result.npm.outcomes
    .filter((outcome) => outcome.status === "error")
    .map((outcome) => ({
      check: "plugin-update",
      code: outcome.code ?? "plugin-update-failed",
      pluginId: outcome.pluginId,
      message: outcome.message,
    }));
  if (!failures.length) {
    failures.push(
      ...result.sync.errors.map((message) => ({
        check: "plugin-sync",
        code: "plugin-sync-failed",
        message,
      })),
    );
  }
  if (!failures.length) {
    failures.push({
      check: "plugin-convergence",
      code: result.reason ?? "post-update-plugins",
      message: result.warnings?.[0]?.message,
    });
  }
  return normalizeUpdateFailureFacts(failures, env);
}

export type PluginUpdateWarning = NonNullable<PostCorePluginUpdateResult["warnings"]>[number];

export function createPluginUpdateWarning(params: {
  pluginId?: string;
  reason: string;
  kind?: "update" | "load";
  env?: NodeJS.ProcessEnv;
}): PluginUpdateWarning {
  const command = formatCliCommand(
    params.kind === "load"
      ? "openclaw doctor --fix"
      : params.pluginId
        ? `openclaw plugins update ${params.pluginId}`
        : "openclaw update repair",
    params.env,
  );
  const nextAction = `Run \`${command}\` to ${params.kind === "load" ? "check and repair the load problem" : "retry"}.`;
  return {
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    reason: params.reason,
    message: params.pluginId
      ? `Plugin "${params.pluginId}" could not be ${params.kind === "load" ? "loaded" : "updated"}. ${nextAction}`
      : `Plugin updates could not complete. ${nextAction}`,
    guidance: [command],
  };
}

export function appendPluginUpdateWarnings(
  result: UpdateRunResult,
  warnings: readonly PluginUpdateWarning[],
): UpdateRunResult {
  if (warnings.length === 0) {
    return result;
  }
  const plugins: PostCorePluginUpdateResult = result.postUpdate?.plugins ?? {
    status: "warning",
    changed: false,
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: false, outcomes: [] },
    integrityDrifts: [],
  };
  const combined = [...(plugins.warnings ?? [])];
  for (const warning of warnings) {
    if (
      !combined.some(
        (entry) => entry.pluginId === warning.pluginId && entry.reason === warning.reason,
      )
    ) {
      combined.push(warning);
    }
  }
  return {
    ...result,
    postUpdate: {
      ...result.postUpdate,
      plugins: {
        ...plugins,
        status: plugins.status === "error" ? "error" : "warning",
        warnings: combined,
      },
    },
  };
}

/**
 * Build the post-core-update result we return when the active config cannot
 * even be parsed. Mandatory post-core convergence requires a parseable
 * config to know which plugins are configured; if one isn't available, we
 * refuse to restart the gateway and surface this as a hard error so the
 * existing `status === "error"` => `exit 1` pre-restart gate fires.
 */
export function buildInvalidConfigPostCoreUpdateResult(): {
  message: string;
  guidance: string[];
  result: PostCorePluginUpdateResult;
} {
  const guidance = [
    "Run `openclaw doctor` to inspect the config validation errors.",
    "Once the config parses, rerun `openclaw update repair`.",
  ];
  const message =
    "Plugin post-update convergence skipped because the config is invalid; refusing to restart the gateway with an unverified plugin set.";
  return {
    message,
    guidance,
    result: {
      status: "error",
      reason: "invalid-config",
      changed: false,
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [],
      },
      integrityDrifts: [],
      warnings: [{ reason: "invalid-config", message, guidance }],
    },
  };
}
