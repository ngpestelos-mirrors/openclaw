/** Shipped SDK adapter; execution belongs to ordinary automation and session owners. */
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";
export type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

const log = createSubsystemLogger("heartbeat/compat");

/**
 * @deprecated Use session events or ordinary automations. Retained through at least
 * one stable replacement release; removal requires a separately approved SDK change.
 */
export function requestHeartbeat(opts: HeartbeatWakeRequest): void {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  if (!context) {
    throw new Error(
      "Heartbeat compatibility calls require a live Gateway. Use enqueueSessionEvent with an explicit agent and session.",
    );
  }
  const assertCurrent = () => {
    scope?.assertSystemOwnerCurrent?.();
    if (scope?.resolveGatewayContext && scope.resolveGatewayContext() !== context) {
      throw new Error("Heartbeat caller's Gateway owner was retired or replaced");
    }
  };
  assertCurrent();
  if (opts.tasks?.length || opts.scheduledEveryMs !== undefined || opts.retainedWork) {
    throw new Error(
      "Heartbeat task scheduling is retired. Run openclaw doctor --fix and use ordinary automations.",
    );
  }
  if (opts.intent === "manual" || opts.intent === "scheduled") {
    void import("./heartbeat-runner.js")
      .then(async ({ runHeartbeatOnce }) => {
        assertCurrent();
        const result = await runHeartbeatOnce({ ...opts, dueOnly: opts.intent === "scheduled" });
        if (result.status !== "ran") {
          log.warn(`Heartbeat compatibility check ${result.status}: ${result.reason}`);
        }
      })
      .catch((error: unknown) => log.error(String(error)));
    return;
  }
  const cfg = context.getRuntimeConfig();
  const agentId =
    opts.agentId ?? parseAgentSessionKey(opts.sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
  const sessionKey = opts.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId });
  void import("../auto-reply/reply/session-event-handoff.js")
    .then(async ({ captureSessionEventTargetForHost, enqueueSessionEventForHost }) => {
      assertCurrent();
      const expectedTarget = await captureSessionEventTargetForHost(agentId, sessionKey, {
        assertCurrent,
      });
      assertCurrent();
      expectedTarget.assertCurrent = assertCurrent;
      const target = opts.heartbeat?.target?.trim();
      if (target === "none") {
        expectedTarget.deliver = false;
      } else if ((target && target !== "last") || opts.heartbeat?.to || opts.heartbeat?.accountId) {
        const { resolveDeliveryTarget } = await import("../cron/isolated-agent/delivery-target.js");
        assertCurrent();
        const route = await resolveDeliveryTarget(cfg, agentId, {
          sessionKey,
          target: target === "owner" ? "owner" : undefined,
          channel: target === "owner" ? undefined : target,
          to: opts.heartbeat?.to,
          accountId: opts.heartbeat?.accountId,
        });
        assertCurrent();
        if (!route.ok) {
          throw route.error;
        }
        expectedTarget.deliveryContext = {
          channel: route.channel,
          to: route.to,
          accountId: route.accountId,
          threadId: route.threadId,
        };
      }
      const receipt = enqueueSessionEventForHost(
        opts.reason?.trim() || "Review pending session events.",
        { agentId, sessionKey, source: "plugin", expectedTarget, assertCurrent },
      );
      const outcome = await receipt.settled;
      if (outcome.status !== "completed") {
        log.warn(
          `Heartbeat compatibility follow-up ${outcome.status}: ${outcome.error ?? "cancelled"}`,
        );
      }
    })
    .catch((error: unknown) => log.error(String(error)));
}
