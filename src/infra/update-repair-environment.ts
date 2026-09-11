import { sanitizeHostExecEnv } from "./host-env-security.js";
import { installationTargetEnv } from "./installation-target-context.js";
import type { UpdateRepairTarget } from "./update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

/** Bind isolation before loading any code from the updated installation. */
export function updateRepairEnvironment(target: UpdateRepairTarget): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (target.environment) {
    // Rehearsal may clear live selectors, but only its isolation paths can
    // override the host environment. Keep executable lookup and credentials host-owned.
    const environment: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(env)) {
      if (target.environment[key] !== undefined) {
        environment[key] = env[key];
      }
    }
    for (const key of [
      "HOME",
      "USERPROFILE",
      "TMPDIR",
      "TMP",
      "TEMP",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]) {
      environment[key] = target.environment[key];
    }
    const sanitized = sanitizeHostExecEnv({ baseEnv: environment });
    for (const key of Object.keys(env)) {
      if (sanitized[key] === undefined) {
        delete env[key];
      }
    }
    Object.assign(env, sanitized);
  }
  Object.assign(
    env,
    installationTargetEnv({
      stateDir: target.stateDir,
      configPath: target.configPath,
      defaultWorkspaceDir: target.workspaceDir,
    }),
    buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
      deferConfiguredPluginInstallRepair: Boolean(target.environment),
    }),
  );
  return env;
}
