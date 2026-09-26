import { ErrorCodes, type ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { errorShapeFromError } from "../error-shape.js";
import type { readInProcessSubagentResume } from "../in-process-subagent-resume.js";
import { assertParentSubagentResumeCurrent } from "../session-subagent-resume.js";
import { setAbortedAgentDedupeEntries } from "./agent-dedupe.js";
import {
  releasePreparedAgentRunUserTurn,
  type PreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

/** Revalidate the same prepared admission after each asynchronous preparation step. */
export function createAgentRunAdmissionRevalidator(options: {
  source: {
    context: AgentTurnContext;
    agentDedupeKeys: readonly string[];
    admissionAgentId: () => string | undefined;
    runId: string;
    assertGatewayWorkAdmissionAllowed: () => void;
    client: AgentTurnPrincipal | null;
    cfg: OpenClawConfig;
    resolvedSessionKey?: string;
    getAdmittedSessionId: () => string;
    hasGatewayAdmissionOutcome: () => boolean;
    respondToGatewayAdmissionOutcome: () => boolean;
  };
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  parentResume: ReturnType<typeof readInProcessSubagentResume>;
  rejectPreaccept: (error: ErrorShape) => Promise<undefined>;
  cleanupPreaccept: (admissionReleased?: boolean) => Promise<void>;
}) {
  const {
    source: params,
    activeRunAbort,
    parentResume,
    rejectPreaccept,
    cleanupPreaccept,
  } = options;
  const disposition = parentResume ? "cancelled" : "interrupted";
  const assertAllowed = () => {
    params.assertGatewayWorkAdmissionAllowed();
    if (parentResume) {
      if (params.client?.internal?.syntheticClient !== true) {
        throw new Error("Task resume requires trusted in-process admission.");
      }
      assertParentSubagentResumeCurrent({
        cfg: params.cfg,
        resume: parentResume,
        sessionKey: params.resolvedSessionKey,
        sessionId: params.getAdmittedSessionId(),
      });
    }
  };
  return (userTurn?: PreparedAgentRunUserTurn): true | Promise<undefined> => {
    if (activeRunAbort.controller.signal.aborted) {
      setAbortedAgentDedupeEntries({
        dedupe: params.context.dedupe,
        keys: params.agentDedupeKeys,
        agentId: params.admissionAgentId(),
        runId: params.runId,
        stopReason: activeRunAbort.entry?.abortStopReason ?? "rpc",
      });
    }
    try {
      assertAllowed();
    } catch (err) {
      const reject = () => rejectPreaccept(errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
      return userTurn
        ? releasePreparedAgentRunUserTurn(userTurn, disposition).then(
            reject,
            (cleanupError: unknown) =>
              rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, cleanupError)),
          )
        : reject();
    }
    if (!params.hasGatewayAdmissionOutcome()) {
      return true;
    }
    const respond = () => {
      try {
        assertAllowed();
        params.respondToGatewayAdmissionOutcome();
      } catch (err) {
        return rejectPreaccept(errorShapeFromError(ErrorCodes.INVALID_REQUEST, err));
      }
      return cleanupPreaccept(true).then(() => undefined);
    };
    return userTurn
      ? releasePreparedAgentRunUserTurn(userTurn, disposition).then(
          respond,
          (cleanupError: unknown) =>
            rejectPreaccept(errorShapeFromError(ErrorCodes.UNAVAILABLE, cleanupError)),
        )
      : respond();
  };
}
