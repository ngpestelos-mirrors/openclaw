import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import {
  readOpenAiHttpRunTerminal,
  runOpenAiCompatibleAgentCommand,
} from "./openai-compatible-agent-run.js";

vi.mock("../commands/agent.js", () => ({ agentCommandFromGatewayIngress: vi.fn() }));

describe("OpenAI-compatible command admission", () => {
  it.each([false, true])(
    "keeps authority until custody transfers (already admitted=%s)",
    async (alreadyAdmitted) => {
      const prepared = createDeferred();
      const proceed = createDeferred();
      const executed = vi.fn();
      let current = true;
      vi.mocked(agentCommandFromGatewayIngress).mockImplementationOnce(async (opts) => {
        const context = {
          operationalRunInstance: { runId: "http-run", instanceId: "http-instance" },
        };
        if (alreadyAdmitted) {
          await opts.onAdmittedRunContext?.(context);
        }
        prepared.resolve();
        await proceed.promise;
        opts.assertSourceCurrent?.();
        if (!alreadyAdmitted) {
          await opts.onAdmittedRunContext?.(context);
        }
        executed();
        return { payloads: [{ text: "settled", mediaUrl: null }], meta: { durationMs: 0 } };
      });
      const pending = runOpenAiCompatibleAgentCommand({
        message: "probe",
        sessionKey: "agent:main:main",
        runId: "http-run",
        messageChannel: "webchat",
        senderIsOwner: true,
        hasCurrentClientAuthority: () => current,
      });
      await prepared.promise;
      current = false;
      proceed.resolve();
      if (alreadyAdmitted) {
        await expect(pending).resolves.toMatchObject({ payloads: [{ text: "settled" }] });
        expect(executed).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow("Gateway requester authority changed");
        expect(executed).not.toHaveBeenCalled();
      }
    },
  );
});

describe("OpenAI-compatible agent run terminal metadata", () => {
  it.each([undefined, null, "invalid", [], { pendingToolCalls: "invalid" }])(
    "treats malformed metadata as having no pending calls: %j",
    (meta) => {
      expect(readOpenAiHttpRunTerminal({ meta })).toMatchObject({
        runFailed: false,
        pendingToolCalls: undefined,
      });
    },
  );

  it("filters malformed calls and normalizes the valid calls for both HTTP protocols", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: "tool_calls",
          pendingToolCalls: [
            null,
            { id: 7, name: "ignored", arguments: "{}" },
            { id: " call_1 ", name: " get_weather ", arguments: { city: "Taipei" } },
          ],
        },
      }),
    ).toEqual({
      runFailed: false,
      stopReason: "tool_calls",
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Taipei"}' }],
    });
  });

  it("ignores a malformed stop reason without discarding valid calls", () => {
    expect(
      readOpenAiHttpRunTerminal({
        meta: {
          stopReason: 42,
          pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
        },
      }),
    ).toMatchObject({
      stopReason: undefined,
      pendingToolCalls: [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    });
  });
});
