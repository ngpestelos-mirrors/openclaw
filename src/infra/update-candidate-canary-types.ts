import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { UpdateCanaryCommand } from "./update-candidate-canary-commands.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type CanaryPhase = UpdateCanaryCommand["phase"] | "snapshot" | "startup" | "readiness";

export type CanaryOutcome =
  | { status: "ok" }
  | {
      status: "error";
      reason:
        | "doctor-failed"
        | "candidate-checks-timeout"
        | "candidate-snapshot-failed"
        | "runtime-verification-failed";
    };

export type CanaryResult = {
  phase: CanaryPhase;
  durationMs: number;
  logTail: string[];
  steps: UpdateStepResult[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  gatewayRestartCompletion?: boolean;
  doctorConfigWrites?: boolean;
  doctorConfigChanges?: UpdateDoctorConfigChange[];
  listenerIsolation?: {
    gateway: { host: "127.0.0.1"; port: number };
    mcpAppSandbox: "disabled";
  };
} & CanaryOutcome;
