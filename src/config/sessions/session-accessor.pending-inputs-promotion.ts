import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runInDetachedAsyncContext } from "../../shared/async-work-scope.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureOwnedTranscriptWriteAssertion } from "./transcript-write-context.js";

/** Capture custody before admission; dispatch and settlement stay inside the transcript FIFO. */
export function prepareSessionPendingInputPromotion<TMessage>(
  scope: SessionTranscriptWriteScope & SessionTranscriptRuntimeTarget,
  databaseOptions: OpenClawAgentDatabaseOptions,
  options: TranscriptMessageAppendOptions<TMessage>,
): (() => Promise<TranscriptMessageAppendResult<TMessage> | undefined>) | undefined {
  const custody = captureSessionPendingInputWorkerCustody();
  const message = asOptionalRecord(options.message);
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    !custody ||
    custody.input.databasePath !== scope.storePath ||
    custody.input.sessionKey !== scope.sessionKey ||
    custody.input.sessionId !== scope.sessionId ||
    message?.role !== "user" ||
    custody.input.idempotencyKey !== readMessageIdempotencyKey(message)
  ) {
    return undefined;
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(scope);
  return async () => {
    const execution = captureOpenClawAgentDatabaseExecution(databaseOptions);
    try {
      const { withSessionMetadataWorker } = await runInDetachedAsyncContext(
        () => import("../../agents/sessions/session-manager-metadata-runtime.js"),
      );
      const { env: _env, ...target } = scope;
      const {
        beforeFreshMessageCommit: _beforeFresh,
        prepareMessageAfterIdempotencyCheck,
        ...appendOptions
      } = options;
      return await withSessionMetadataWorker<
        TranscriptMessageAppendResult<TMessage> | undefined,
        TMessage
      >(
        databaseOptions,
        { execution },
        () => {
          assertOwned();
          custody.assertCurrent();
        },
        async (worker) => {
          const committed = await worker.execute({
            type: "session.transcript.promotePendingInput",
            input: {
              scope: { ...target, storePath: execution.path },
              options: appendOptions,
              pendingCustody: custody.input,
              replayPreparedPendingInput: Boolean(prepareMessageAfterIdempotencyCheck),
            },
          });
          custody.publishCommitted(committed.consumedInputIds);
          if (committed.projectionNeedsReconcile) {
            const { startSessionTranscriptIndexReconcile } = await runInDetachedAsyncContext(
              () => import("./session-transcript-reconcile.js"),
            );
            startSessionTranscriptIndexReconcile({
              ...databaseOptions,
              preferredSessionId: scope.sessionId,
            });
          }
          return committed.result;
        },
      );
    } finally {
      await execution.release();
    }
  };
}
