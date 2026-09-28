import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayProbeResult } from "../gateway/probe.js";
import {
  runOnboardingGatewayProbe,
  summarizeGatewayProbeError,
  type OnboardingGatewayProbeParams,
} from "./onboard-helpers.js";

export type GatewayConfiguredModelProbeResult =
  | { kind: "configured" }
  | { kind: "missing-configured-model"; detail: string }
  | { kind: "reachable-unverified"; detail?: string }
  | { kind: "unreachable"; detail?: string };

/** Reads only Gateway config and classifies whether its default agent has inference. */
export async function probeGatewayConfiguredModel(
  params: OnboardingGatewayProbeParams,
): Promise<GatewayConfiguredModelProbeResult> {
  let probe: GatewayProbeResult;
  try {
    probe = await runOnboardingGatewayProbe(params, "config");
  } catch (err) {
    return { kind: "unreachable", detail: summarizeGatewayProbeError(err) };
  }
  const detail = probe.error ?? undefined;
  if (!probe.gatewayReached) {
    return { kind: "unreachable", ...(detail ? { detail } : {}) };
  }
  if (!probe.ok) {
    return { kind: "reachable-unverified", detail };
  }
  const snapshot = probe.configSnapshot as {
    valid?: unknown;
    runtimeConfig?: unknown;
    config?: unknown;
  } | null;
  const configCandidate =
    snapshot?.valid === true ? (snapshot.runtimeConfig ?? snapshot.config) : null;
  if (!configCandidate || typeof configCandidate !== "object" || Array.isArray(configCandidate)) {
    return {
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    };
  }
  try {
    const config = configCandidate as OpenClawConfig;
    const model = resolveAgentEffectiveModelPrimary(config, resolveDefaultAgentId(config));
    return model
      ? { kind: "configured" }
      : {
          kind: "missing-configured-model",
          detail: "Gateway default agent has no configured model",
        };
  } catch {
    return {
      kind: "reachable-unverified",
      detail: "Gateway returned an invalid config snapshot",
    };
  }
}
