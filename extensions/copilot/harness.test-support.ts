import { randomUUID } from "node:crypto";
import type {
  AgentHarnessAttemptParamsV2 as AgentHarnessAttemptParams,
  AgentHarnessCompactParams,
  AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCopilotAgentHarness as createCopilotAgentHarnessImpl } from "./harness.js";

export function createCopilotAgentHarness(
  options?: Parameters<typeof createCopilotAgentHarnessImpl>[0],
) {
  const harness = createCopilotAgentHarnessImpl(options);
  const compact = harness.compact;
  if (compact) {
    harness.compact = (
      params: AgentHarnessCompactParams &
        Partial<Pick<AgentHarnessCompactParams<2>, "hostCapabilities">>,
    ) => {
      if (params.hostCapabilities) {
        return compact(params);
      }
      return runWithAsyncWorkResources(async (onAcquired) => {
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt: {
            runId: params.runId ?? randomUUID(),
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionTarget: params.sessionTarget,
            agentId: params.agentId,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            config: params.config,
            abortSignal: params.abortSignal,
          },
          pluginId: "copilot",
        });
        onAcquired({ release: host.close, releaseBeforeResultWhenIdle: true });
        const prepared = { ...params, hostCapabilities: host.capabilities };
        return await compact(prepared);
      });
    };
  }
  return harness;
}

type SettledTurnFinalizationAttemptParams = Parameters<
  NonNullable<AgentHarnessV2["finalizeSettledTurn"]>
>[0]["attempt"];

export function asFinalizationAttempt(
  params: AgentHarnessAttemptParams,
): SettledTurnFinalizationAttemptParams {
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  return attempt;
}
