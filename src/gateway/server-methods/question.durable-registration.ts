import { randomUUID } from "node:crypto";
import type {
  Question,
  QuestionRequestParams,
  QuestionRecord,
} from "../../../packages/gateway-protocol/src/index.js";
import { matchesDurableQuestionDefinition } from "../../config/sessions/session-questions-definition.js";
import {
  readSessionQuestionCustody,
  executeSessionQuestionOperation,
} from "../../config/sessions/session-questions.js";
import type { DurableQuestion } from "../../config/sessions/session-questions.types.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import { handleQuestionChannelResolved } from "../../infra/question-channel-runtime.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { installDurableQuestion } from "../durable-question-runtime.js";
import type { QuestionManager } from "../question-manager.js";
import { publishDurableQuestionResolution } from "../question-session-access.js";
import { withQuestionSessionAccess } from "../question-session-access.js";
import { QuestionRequestValidationError } from "./question.errors.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** The worker commit owns custody before the registration ACK or prompt publication. */
export async function registerDurableQuestion(params: {
  options: GatewayRequestHandlerOptions;
  request: QuestionRequestParams;
  questions: Question[];
  sessionKey: string;
  agentId: string;
  narrow: boolean;
  requiresSharing: () => boolean;
  scheduler: GatewayScheduler;
  defaultTimeoutMs: number;
  assertGatewayCurrent: () => void;
}): Promise<DurableQuestion> {
  const {
    options,
    request,
    questions,
    sessionKey,
    agentId,
    narrow,
    requiresSharing,
    scheduler,
    defaultTimeoutMs,
  } = params;
  const client = options.client;
  const authority = readGatewayRequestMutationAuthority(options);
  const requester = client?.internal?.agentRuntimeIdentity;
  const operatorAuthority = client?.internal?.operatorRunAuthority;
  if (
    !requester ||
    (!operatorAuthority?.recoverySnapshot && !operatorAuthority?.channelRecoveryReference)
  ) {
    throw new QuestionRequestValidationError("Durable custody requires a trusted agent requester.");
  }
  const captured = await withQuestionSessionAccess(
    options,
    sessionKey,
    agentId,
    (access, prepared) => {
      if (
        !access?.durableBinding ||
        !prepared?.target ||
        (narrow && !prepared.canAccess(client, true, access))
      ) {
        access?.release();
        throw new QuestionRequestValidationError(
          "This question cannot acquire durable conversation custody.",
        );
      }
      if (requiresSharing() && prepared.authorizeMutation(client)) {
        access.release();
        throw new QuestionRequestValidationError(
          "This caller cannot create a question in the selected conversation.",
        );
      }
      return { access, binding: access.durableBinding };
    },
    { assertCurrent: authority.assertCurrent, includeMembers: !narrow && requiresSharing() },
  );
  try {
    const binding = {
      ...captured.binding,
      ...(operatorAuthority?.profileId ? { profileId: operatorAuthority.profileId } : {}),
    };
    const createdAtMs = scheduler.now();
    const record: QuestionRecord = {
      id: request.id ?? randomUUID(),
      questions,
      agentId: agentId,
      sessionKey,
      runId: requester.operationalRunInstance.runId,
      createdAtMs,
      expiresAtMs: createdAtMs + (request.timeoutMs ?? defaultTimeoutMs),
      status: "pending",
    };
    const recoverySource = operatorAuthority?.recoverySnapshot
      ? {
          version: 1 as const,
          agentId: binding.agentId,
          sessionKey: binding.sessionKey,
          sessionId: binding.sessionId,
          lifecycleRevision: binding.lifecycleRevision,
          sourceRunId: requester.operationalRunInstance.runId,
          snapshot: operatorAuthority.recoverySnapshot,
        }
      : undefined;
    const question: DurableQuestion = {
      record,
      sessionKey,
      sessionId: binding.sessionId,
      lifecycleRevision: binding.lifecycleRevision,
      sessionBinding: binding,
      provenance: {
        issuer: recoverySource ? "operator" : "channel",
        sourceRunId: requester.operationalRunInstance.runId,
        ...(recoverySource ? { recoverySource } : {}),
        ...(operatorAuthority?.channelRecoveryReference
          ? { channelAuthorizationReference: operatorAuthority.channelRecoveryReference }
          : {}),
        ...(requester.turnSourceChannel && requester.turnSourceTo
          ? {
              delivery: {
                channel: requester.turnSourceChannel,
                to: requester.turnSourceTo,
                accountId: requester.turnSourceAccountId,
                threadId: requester.turnSourceThreadId,
              },
            }
          : {}),
      },
      continuation: { status: "pending" },
    };
    const assertCurrent = () => {
      authority.assertCurrent();
      operatorAuthority?.assertCurrent();
      captured.access.assertSourceCurrent();
      if (options.context.validateAgentRuntimeApprovalAuthority?.(requester) !== true) {
        throw new Error("The asking run no longer owns durable question registration.");
      }
    };
    const scope = {
      agentId: binding.agentId,
      sessionKey,
      storePath: binding.storePath,
      assertCurrent,
    };
    let result;
    try {
      result = await executeSessionQuestionOperation(scope, { kind: "register", question });
    } catch (error) {
      if (!hasSqliteWorkerOutcomeUnknown(error)) {
        throw error;
      }
      result = await readSessionQuestionCustody(binding, record.id, params.assertGatewayCurrent);
      if (!result || Array.isArray(result) || !matchesDurableQuestionDefinition(result, question)) {
        throw error;
      }
    }
    if (!result || Array.isArray(result)) {
      throw new Error("Durable question registration lost its canonical receipt");
    }
    return result;
  } finally {
    captured.access.release();
  }
}

/** Preserve committed custody when its producer can no longer publish the prompt. */
export function retainUnpublishedDurableQuestion(
  manager: QuestionManager,
  question: DurableQuestion,
  onContinuationOwed: (question: DurableQuestion) => void,
  context: GatewayRequestHandlerOptions["context"],
): void {
  if (manager.observe(question.record.id)) {
    return;
  }
  installDurableQuestion(manager, question, onContinuationOwed, {
    onResolved: durableQuestionPublication(context),
  });
}

/** Durable publication belongs to the Gateway observation, beyond the asking invocation. */
export function durableQuestionPublication(context: GatewayRequestHandlerOptions["context"]) {
  return (
    event: import("../../../packages/gateway-protocol/src/index.js").QuestionResolvedEvent,
    observation: import("../question-manager.js").QuestionObservation,
  ) => {
    handleQuestionChannelResolved(event);
    return publishDurableQuestionResolution({
      context,
      event,
      observation,
      assertCurrent: () => {
        if (!observation.isCurrent()) {
          throw new Error("Question publication owner retired");
        }
      },
    });
  };
}
