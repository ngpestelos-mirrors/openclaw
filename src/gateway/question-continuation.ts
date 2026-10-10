import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { SessionAccessScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { hasSessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import {
  executeSessionQuestionOperation,
  readSessionQuestionCustody,
} from "../config/sessions/session-questions.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { CommandLane } from "../process/lanes.js";
import { prepareChannelOperatorAdmin } from "./channel-operator-authority.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";
import { restoreGatewayQuestionOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

export type QuestionContinuationReceipt =
  | { status: "settled"; questionId: string; runId: string }
  | { status: "interrupted"; questionId: string; runId: string }
  | { status: "not_owed"; questionId: string };

/** One native turn owns each committed answer. The existing lane handles busy sessions. */
export async function dispatchQuestionContinuation(params: {
  question: DurableQuestion;
  scope: SessionAccessScope & { storePath: string };
  context: GatewayRequestContext;
  runtime: GatewayInstanceRuntime;
  assertCurrent: () => void;
}): Promise<QuestionContinuationReceipt> {
  const { question, scope, context, runtime } = params;
  const questionId = question.record.id;
  if (question.continuation.status !== "owed") {
    return { status: "not_owed", questionId };
  }
  const runId = randomUUID();
  const epoch = getAgentEventLifecycleGeneration();
  const assertCurrent = () => {
    params.assertCurrent();
    if (!runtime.isAvailable() || getAgentEventLifecycleGeneration() !== epoch) {
      throw new Error("Durable question Gateway owner changed.");
    }
  };
  let expectedQuestion = question;
  let executionCompleted = false;
  let claimed = false;
  let claimAttempted = false;
  let restored: Awaited<ReturnType<typeof restoreGatewayQuestionOperatorRecovery>> = undefined;
  const isOwnReceipt = (
    current: DurableQuestion | DurableQuestion[] | undefined,
  ): current is DurableQuestion =>
    Boolean(
      current &&
      !Array.isArray(current) &&
      current.continuation.runId === runId &&
      current.continuation.gatewayEpoch === epoch &&
      current.sessionKey === expectedQuestion.sessionKey &&
      current.sessionId === expectedQuestion.sessionId &&
      current.lifecycleRevision === expectedQuestion.lifecycleRevision &&
      isDeepStrictEqual(current.provenance, expectedQuestion.provenance) &&
      isDeepStrictEqual(current.sessionBinding, expectedQuestion.sessionBinding) &&
      isDeepStrictEqual(current.record, expectedQuestion.record) &&
      current.resolutionId === expectedQuestion.resolutionId,
    );
  const finish = async (interrupted: boolean, reason?: string) => {
    const result = await executeSessionQuestionOperation(
      { ...scope, assertCurrent: params.assertCurrent },
      { kind: "finish", id: questionId, runId, interrupted, reason, expectedQuestion },
    );
    if (!interrupted && (!isOwnReceipt(result) || result.continuation.status !== "settled")) {
      throw new Error("Durable question completion receipt was not settled.");
    }
  };
  try {
    assertCurrent();
    const freshResult = await readSessionQuestionCustody(
      question.sessionBinding,
      questionId,
      assertCurrent,
    );
    const fresh = Array.isArray(freshResult) ? undefined : freshResult;
    if (
      !fresh ||
      fresh.continuation.status !== "owed" ||
      fresh.sessionId !== question.sessionId ||
      fresh.lifecycleRevision !== question.lifecycleRevision ||
      !isDeepStrictEqual(fresh.provenance, question.provenance) ||
      !isDeepStrictEqual(fresh.sessionBinding, question.sessionBinding) ||
      !isDeepStrictEqual(fresh.record, question.record) ||
      fresh.resolutionId !== question.resolutionId
    ) {
      throw new Error("Durable question source custody changed.");
    }
    expectedQuestion = fresh;
    const source = fresh.provenance.recoverySource;
    let authority;
    let agentId = scope.agentId;
    if (fresh.provenance.issuer === "operator" && source) {
      restored = await restoreGatewayQuestionOperatorRecovery({
        questionId,
        expectedQuestion,
        target: {
          agentId: source.agentId,
          sessionKey: question.sessionKey,
          sessionId: question.sessionId,
          storePath: scope.storePath,
          sourceRunId: question.provenance.sourceRunId,
          recoveryRunId: runId,
        },
        context,
        assertCurrent,
      });
      authority = restored?.authority;
      agentId = source.agentId;
    } else if (
      fresh.provenance.issuer === "channel" &&
      fresh.provenance.channelAuthorizationReference
    ) {
      const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
      const channelOwner = await prepareChannelOperatorAdmin(
        getConfig(),
        fresh.provenance.channelAuthorizationReference,
      );
      assertCurrent();
      if (channelOwner) {
        const assertChannelCurrent = () => {
          assertCurrent();
          if (!channelOwner.isCurrent(getConfig())) {
            throw new Error("Durable question channel caller authority changed.");
          }
        };
        authority = captureChannelOperatorRunAuthority({
          ...channelOwner.operatorProfile,
          getRuntimeConfig: getConfig,
          assertCurrent: assertChannelCurrent,
          signal: channelOwner.signal,
          channelRecoveryReference: channelOwner.recoveryReference,
        });
      }
    }
    if (!authority) {
      throw new Error("Durable question original caller authority is unavailable.");
    }
    assertCurrent();
    const turns = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: authority.profileId },
        operatorRunAuthority: authority,
        scopes: [...authority.scopes],
      }),
      assertContextCurrent: assertCurrent,
    });
    const delivery = question.provenance.delivery;
    await turns.dispatch(
      {
        agentId,
        sessionKey: question.sessionKey,
        expectedExistingSessionId: question.sessionId,
        expectedExistingSessionLifecycleRevision: question.lifecycleRevision,
        idempotencyKey: runId,
        lane: CommandLane.Main,
        message: `The previously requested user question has resolved. Continue the original task using this result:\n${JSON.stringify({ id: questionId, status: question.record.status, answers: question.record.answers })}`,
        ...(delivery
          ? {
              channel: delivery.channel,
              to: delivery.to,
              accountId: delivery.accountId,
              threadId: delivery.threadId !== undefined ? String(delivery.threadId) : undefined,
              deliver: true,
            }
          : {}),
      },
      {
        expectFinal: true,
        assertAdmissionCurrent: () => {
          assertCurrent();
          authority.assertCurrent();
        },
        commitAdmission: async (target) => {
          if (
            target.runId !== runId ||
            target.lifecycleGeneration !== epoch ||
            target.storePath !== scope.storePath ||
            target.sessionId !== question.sessionId ||
            target.sessionKey !== question.sessionKey
          ) {
            throw new Error("Durable question target changed before admission.");
          }
          claimAttempted = true;
          const result = await executeSessionQuestionOperation(
            { ...scope, assertCurrent: target.assertCurrent },
            {
              kind: "claim",
              id: questionId,
              runId: target.runId,
              gatewayEpoch: epoch,
              expectedQuestion,
            },
          );
          if (
            !result ||
            Array.isArray(result) ||
            result.continuation.status !== "claimed" ||
            result.continuation.runId !== target.runId ||
            result.continuation.gatewayEpoch !== epoch ||
            result.sessionId !== question.sessionId ||
            result.lifecycleRevision !== question.lifecycleRevision
          ) {
            throw new Error("Durable question continuation claim was not admitted.");
          }
          claimed = true;
        },
      },
    );
    executionCompleted = true;
    await finish(false);
    return { status: "settled", questionId, runId };
  } catch (error) {
    if (hasSessionQuestionCustodyRetiredError(error)) {
      throw error;
    }
    if (executionCompleted) {
      // Repair only this completed turn's receipt. Repeating dispatch could repeat
      // delivered output or effects even when the first receipt ACK was lost.
      const canonical = await readSessionQuestionCustody(
        question.sessionBinding,
        questionId,
        params.assertCurrent,
      );
      if (!isOwnReceipt(canonical)) {
        throw error;
      }
      if (canonical.continuation.status === "settled") {
        return { status: "settled", questionId, runId };
      }
      if (canonical.continuation.status !== "claimed") {
        throw error;
      }
      try {
        await finish(false);
      } catch (repairError) {
        if (hasSessionQuestionCustodyRetiredError(repairError)) {
          throw repairError;
        }
        const repaired = await readSessionQuestionCustody(
          question.sessionBinding,
          questionId,
          params.assertCurrent,
        );
        if (!isOwnReceipt(repaired) || repaired.continuation.status !== "settled") {
          throw repairError;
        }
      }
      return { status: "settled", questionId, runId };
    }
    if (claimAttempted && !claimed) {
      // An uncertain worker acknowledgement never authorizes execution. Read only
      // our exact claim back so its interrupted receipt can be presented safely.
      const canonical = await readSessionQuestionCustody(
        question.sessionBinding,
        questionId,
        params.assertCurrent,
      );
      claimed = isOwnReceipt(canonical) && canonical.continuation.status === "claimed";
    }
    if (claimed) {
      await finish(
        true,
        "Continuation was interrupted. Start a new user turn to inspect the current state; the previous turn will not automatically repeat.",
      );
    } else {
      await executeSessionQuestionOperation(
        { ...scope, assertCurrent: params.assertCurrent },
        {
          kind: "block",
          id: questionId,
          expectedQuestion,
          reason:
            "Continuation could not be admitted under the original caller authority. Start a new user turn to inspect the question and current session.",
        },
      );
    }
    throw error;
  } finally {
    restored?.release();
  }
}
