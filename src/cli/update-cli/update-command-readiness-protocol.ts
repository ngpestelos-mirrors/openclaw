import { z } from "zod";
import { GATEWAY_RESTART_WAIT_OUTCOMES } from "../daemon-cli/restart-health.types.js";

const text = z.string();
const optionalText = text.optional();
const pid = z.number().int().positive();
const failure = z.object({ id: text, error: text });
const mismatch = z.object({ expected: text, actual: text.nullable() });

/** Private, process-bound observation; credentials and lifecycle actions stay out of stdin. */
export const UpdateReadinessRequestSchema = z.strictObject({
  gatewayPort: z.number().int().min(1).max(65535),
  timeoutMs: z.number().positive().finite(),
  probeTimeoutMs: z.number().positive().finite().optional(),
  expectedVersion: optionalText,
  expectedBuildId: optionalText,
  requireRunningService: z.boolean().optional(),
  requirePluginHealth: z.boolean().optional(),
  waitForStartup: z.boolean().optional(),
  healthOnly: z.boolean().optional(),
});

// Validate the observer's consumed facts at the process boundary, not arbitrary status JSON.
// Native diagnostic fields that do not participate in verification stay with the child.
export const UpdateReadinessObservationSchema = z.object({
  health: z.object({
    runtime: z.object({
      status: optionalText,
      state: optionalText,
      pid: pid.optional(),
      lastExitStatus: z.number().optional(),
      detail: optionalText,
      inspectionFailure: z
        .object({
          code: z.literal("service-runtime-inspection-failed"),
          detail: text,
          timeoutMs: z.number().optional(),
        })
        .optional(),
      systemd: z
        .object({
          startRefusal: z
            .object({
              reason: z.enum(["masked", "refuse-manual-start", "disabled-no-start"]),
              message: text,
            })
            .optional(),
        })
        .optional(),
    }),
    portUsage: z.object({
      port: z.number().int(),
      status: z.enum(["free", "busy", "unknown"]),
      listeners: z.array(
        z.object({
          pid: pid.optional(),
          ppid: z.number().int().nonnegative().optional(),
          command: optionalText,
          commandLine: optionalText,
          user: optionalText,
          address: optionalText,
        }),
      ),
      hints: z.array(text),
      errors: z.array(text).optional(),
    }),
    healthy: z.boolean(),
    staleGatewayPids: z.array(pid),
    gatewayVersion: text.nullable().optional(),
    gatewayBuildId: text.nullable().optional(),
    gatewayBootId: optionalText,
    expectedVersion: optionalText,
    versionMismatch: mismatch.optional(),
    buildIdMismatch: mismatch.optional(),
    probeError: optionalText,
    authenticationError: optionalText,
    staleConnection: z.enum(["installation-replaced", "legacy-handler-unavailable"]).optional(),
    activatedPluginErrors: z
      .array(
        failure.extend({
          origin: text,
          activated: z.boolean(),
          activationSource: optionalText,
          activationReason: optionalText,
          failurePhase: optionalText,
        }),
      )
      .optional(),
    unavailablePlugins: z.array(z.object({ id: text, reason: text, detail: text })).optional(),
    channelProbeErrors: z.array(failure).optional(),
    channelProbeTimeouts: z.array(failure).optional(),
    channelRuntimeWarnings: z.array(failure).optional(),
    waitOutcome: z.enum(GATEWAY_RESTART_WAIT_OUTCOMES).optional(),
    elapsedMs: z.number().nonnegative().optional(),
    startupPhase: optionalText,
  }),
  readyz: z.boolean(),
  http: z
    .object({
      healthz: z.number().nullable(),
      readyz: z.number().nullable(),
      coreReady: z.boolean().optional(),
      failingChannels: z.array(text).optional(),
    })
    .optional(),
});

export type UpdateReadinessRequest = z.infer<typeof UpdateReadinessRequestSchema>;
export type UpdateReadinessObservation = z.infer<typeof UpdateReadinessObservationSchema>;
