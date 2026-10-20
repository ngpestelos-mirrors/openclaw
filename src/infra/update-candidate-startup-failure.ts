import { constants } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { UpdateFailureFact } from "./update-failure-facts-format.js";

/** Closed public vocabulary; candidate output supplies no text to these templates. */
export const UPDATE_CANDIDATE_STARTUP_CAUSES = {
  "candidate-startup-config-invalid": "Invalid configuration field",
  "candidate-startup-schema-migration-required": "schema migration required",
  "candidate-startup-newer-schema": "database schema newer than candidate",
  "candidate-startup-plugin-load-failed": "plugin load failed",
  "candidate-startup-port-in-use": "port in use",
  "candidate-startup-readiness-timeout": "readiness timeout",
  "candidate-startup-native-module-missing": "native module missing",
  "candidate-startup-native-abi-mismatch": "native module ABI mismatch",
  "candidate-startup-out-of-memory": "startup ran out of memory",
} as const;

export function publicCandidateStartupCause(code: string): string | undefined {
  return Object.entries(UPDATE_CANDIDATE_STARTUP_CAUSES).find(([key]) => key === code)?.[1];
}

export function isPublicCandidateStartupDiagnostic(line: string): boolean {
  if (Object.values(UPDATE_CANDIDATE_STARTUP_CAUSES).some((message) => message === line)) {
    return true;
  }
  const signal = /^startup crash with signal (SIG[A-Z0-9]+)$/u.exec(line)?.[1];
  return Boolean(signal && Object.hasOwn(constants.signals, signal));
}

/** Recognize source/runtime error envelopes before truncation evicts their cause. */
export function classifyUpdateCandidateStartupLine(line: string): UpdateFailureFact | undefined {
  const text = stripVTControlCharacters(line);
  let code: keyof typeof UPDATE_CANDIDATE_STARTUP_CAUSES | undefined;
  let pluginId: string | undefined;
  if (/\bInvalid config at |\bOpenClaw config is invalid\b/u.test(text)) {
    code = "candidate-startup-config-invalid";
  } else if (
    /\bOpenClaw state database schema migration required\b|\bgateway requires (?:state migration|offline media migration|state database schema migration|cron run history migration)\b|\bOpenClaw agent database .+; run openclaw doctor --fix to migrate persisted media before using it\./u.test(
      text,
    )
  ) {
    code = "candidate-startup-schema-migration-required";
  } else if (
    /\bGateway refused startup because \d+ OpenClaw database schema\(s\) are newer than this build\./u.test(
      text,
    )
  ) {
    code = "candidate-startup-newer-schema";
  } else if (/\bplugin load failed: /u.test(text)) {
    code = "candidate-startup-plugin-load-failed";
    // IDs remain private until the report checks the shipped public plugin catalog.
    pluginId = /\bplugin load failed: ([^:\r\n]+):/u.exec(text)?.[1];
  } else if (/\[plugins\] .+ failed during (?:validation|load|register) from /u.test(text)) {
    code = "candidate-startup-plugin-load-failed";
    pluginId = /\[plugins\] (.+) failed during (?:validation|load|register) from /u.exec(text)?.[1];
  } else if (/\bEADDRINUSE\b|\banother gateway instance is already listening on /u.test(text)) {
    code = "candidate-startup-port-in-use";
  } else if (
    /\bwas compiled against a different Node\.js version using\b|\bModule did not self-register\b|\bGLIBC_\d+(?:\.\d+)+['"] not found\b/u.test(
      text,
    )
  ) {
    code = "candidate-startup-native-abi-mismatch";
  } else if (/\bCannot find (?:module|package) ['"][^\r\n]+\.node['"]/u.test(text)) {
    code = "candidate-startup-native-module-missing";
  } else if (
    /FATAL ERROR: (?:Reached heap limit|Ineffective mark-compacts near heap limit) Allocation failed - JavaScript heap out of memory/u.test(
      text,
    )
  ) {
    code = "candidate-startup-out-of-memory";
  }
  return code
    ? {
        check: "startupz",
        code,
        message: UPDATE_CANDIDATE_STARTUP_CAUSES[code],
        ...(pluginId ? { pluginId } : {}),
      }
    : undefined;
}
