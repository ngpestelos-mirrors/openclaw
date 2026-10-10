import {
  validateQuestionGetParams,
  validateQuestionListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { canSelectQuestion, usesOwnRunQuestionAccess } from "../question-access.js";
import {
  readDurableQuestionFact,
  projectQuestionContinuationReceipt,
} from "../question-continuation-receipt.js";
import type { QuestionManager } from "../question-manager.js";
import {
  questionNotFound,
  prepareQuestionAuthorization,
  withPreparedQuestionSessions,
} from "../question-session-access.js";
import { managerError } from "./question.errors.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
export function prepareSelectedQuestion(
  manager: QuestionManager,
  options: GatewayRequestHandlerOptions,
  id: string,
  access: "read" | "mutate",
) {
  readGatewayRequestMutationAuthority(options).assertCurrent();
  const question = canSelectQuestion(manager, id, options.client) ? manager.get(id) : null;
  if (!question) {
    options.respond(false, undefined, questionNotFound(id));
    return undefined;
  }
  const observation = manager.observe(id, question);
  const authorize = prepareQuestionAuthorization(options, observation, id, access);
  return {
    question,
    observation,
    authorize,
    withCurrent<T>(consume: () => T, includeMembers?: boolean) {
      return withPreparedQuestionSessions(
        options,
        [authorize.target],
        ([prepared]) => {
          const error = authorize.authorize(prepared);
          if (error) {
            options.respond(false, undefined, error);
            return undefined;
          }
          return consume();
        },
        {
          assertCurrent: authorize.assertCurrent,
          ...(includeMembers !== undefined ? { includeMembers } : {}),
        },
      );
    },
  };
}

export function createQuestionReadHandlers(manager: QuestionManager): GatewayRequestHandlers {
  return {
    "question.get": async (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionGetParams, "question.get", respond)) {
        return;
      }
      const selected = prepareSelectedQuestion(manager, options, params.id, "read");
      if (!selected) {
        return;
      }
      const durable = manager.hasDurableCustody(params.id);
      const canonical = durable
        ? await readDurableQuestionFact(
            selected.observation!,
            selected.authorize.assertCurrent,
            () => manager.retireDurableCustodyObservation(selected.observation!),
          )
        : undefined;
      const continuation =
        params.includeContinuation && canonical
          ? projectQuestionContinuationReceipt(canonical)
          : undefined;
      if (durable && !canonical) {
        respond(false, undefined, questionNotFound(params.id));
        return;
      }
      await selected
        .withCurrent(() => {
          respond(
            true,
            {
              question: canonical?.record ?? selected.observation!.record,
              ...(continuation ? { continuation } : {}),
            },
            undefined,
          );
        })
        .catch((error: unknown) => {
          if (!managerError(error, respond)) {
            throw error;
          }
        });
    },
    "question.list": async (options) => {
      const { params, respond } = options;
      if (!assertValidParams(params, validateQuestionListParams, "question.list", respond)) {
        return;
      }
      readGatewayRequestMutationAuthority(options).assertCurrent();
      const records = manager
        .list(
          usesOwnRunQuestionAccess(options.client)
            ? (question) => canSelectQuestion(manager, question.id, options.client)
            : undefined,
          Boolean(params.includeContinuation),
        )
        .map((question) => {
          const observation = manager.observe(question.id, question);
          return {
            question,
            observation,
            durable: manager.hasDurableCustody(question.id),
            authorize: prepareQuestionAuthorization(options, observation, question.id, "read"),
          };
        });
      const canonical = await Promise.all(
        records.map(({ observation, authorize, durable }) =>
          observation && durable
            ? readDurableQuestionFact(observation, authorize.assertCurrent, () =>
                manager.retireDurableCustodyObservation(observation),
              )
            : undefined,
        ),
      );
      const receipts = params.includeContinuation
        ? canonical.map((fact) => (fact ? projectQuestionContinuationReceipt(fact) : undefined))
        : undefined;
      await withPreparedQuestionSessions(
        options,
        records.map(({ authorize }) => authorize.target),
        (prepared) => {
          const questions = records.flatMap(
            ({ question, observation, authorize, durable }, index) => {
              const fact = canonical[index];
              const current = fact?.record ?? question;
              return observation?.isCurrent() &&
                observation.record === question &&
                (!durable || fact) &&
                (current.status === "pending" || params.includeContinuation) &&
                !authorize.authorize(prepared[index])
                ? [current]
                : [];
            },
          );
          const continuations = receipts?.filter(
            (receipt) =>
              receipt && questions.some((question) => question.id === receipt.questionId),
          );
          respond(true, { questions, ...(continuations ? { continuations } : {}) }, undefined);
        },
        { assertCurrent: readGatewayRequestMutationAuthority(options).assertCurrent },
      );
    },
  };
}
