import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  LAUNCH_AGENT_POLICY,
  decodeLaunchAgentPlistDefinition,
  readLaunchAgentProgramArgumentsFromFile,
} from "./launchd-plist.js";
import {
  buildLaunchAgentEnvironmentWrapper,
  readExistingLaunchAgentPlist,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { resolveGatewayLogPaths, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";
import type { GatewayServiceEnv } from "./service-types.js";

/** Compare native plist values so XML and binary definitions have the same repair policy. */
export async function auditLaunchdDefinition(
  env: GatewayServiceEnv,
  issues: ServiceConfigIssue[],
  timeoutMs?: number,
): Promise<void> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  const finding = (key: string, blocked = false, detail = plistPath) => {
    issues.push({
      code:
        key === "KeepAlive"
          ? "launchd-keep-alive"
          : key === "RunAtLoad"
            ? "launchd-run-at-load"
            : "launchd-definition-drift",
      definitionKey: key,
      message: blocked
        ? `LaunchAgent ${key} contains an unsupported edit; the definition was preserved.`
        : `LaunchAgent ${key} differs from the current installer definition.`,
      detail,
      level: "recommended",
      ...(blocked ? { rewriteBlocked: true } : {}),
    });
  };
  try {
    const content = await readExistingLaunchAgentPlist(plistPath);
    if (content === null) {
      return;
    }
    const installed = await decodeLaunchAgentPlistDefinition(content, timeoutMs);
    const label = resolveLaunchAgentLabel(env);
    await readLaunchAgentProgramArgumentsFromFile(plistPath, {
      ...resolveLaunchAgentEnvironmentReadOptions(env, label),
      requireEffective: true,
      timeoutMs,
    });
    const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
    const expected: Record<string, unknown> = {
      ...LAUNCH_AGENT_POLICY,
      Label: label,
      StandardOutPath: stdoutPath,
      StandardErrorPath: stdoutPath,
    };
    const preserved = new Set([
      "ProgramArguments",
      "WorkingDirectory",
      "EnvironmentVariables",
      "Comment",
    ]);
    // v2026.3.1 used state-dir logs; v2026.7.1-2 sent stderr to /dev/null.
    const legacyLogs = resolveGatewayLogPaths(env);
    const knownLogs: Record<string, readonly string[]> = {
      StandardOutPath: [legacyLogs.stdoutPath],
      StandardErrorPath: [legacyLogs.stderrPath, "/dev/null"],
    };
    for (const key of new Set([...Object.keys(installed), ...Object.keys(expected)])) {
      if (!preserved.has(key) && installed[key] !== expected[key]) {
        const logPaths = knownLogs[key];
        const current = installed[key];
        // A different Label is a different native service, not a stale policy value.
        finding(
          key,
          !Object.hasOwn(expected, key) ||
            key === "Label" ||
            // v2026.7.1-2 and v2026.9.4 already emitted the current scalar policy.
            // Missing keys are upgrades; other explicit scalar values are operator edits.
            (current !== undefined && Object.hasOwn(LAUNCH_AGENT_POLICY, key)) ||
            Boolean(
              logPaths &&
              current !== undefined &&
              (typeof current !== "string" || !logPaths.includes(current)),
            ) ||
            (typeof installed[key] === "object" && installed[key] !== null),
        );
      }
    }
    const wrapperPath = resolveLaunchAgentEnvWrapperPath(env, label);
    const wrapper = await readExistingLaunchAgentPlist(wrapperPath);
    if (wrapper !== null && wrapper.toString("utf8") !== buildLaunchAgentEnvironmentWrapper()) {
      finding("EnvironmentWrapper", true, wrapperPath);
    }
  } catch {
    finding("definition", true);
  }
}
