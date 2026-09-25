import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "../../chat/message-client-source.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  getAgentEventLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  preparePendingInputRequest,
  resolveCommittedPendingInputRequestHash,
  resolvePendingInputReplayRequest,
  matchesSessionPendingInputRequest,
  type PendingInputRequest,
} from "./session-accessor.pending-input-request.js";
import { withSessionPendingInputDatabase } from "./session-accessor.pending-inputs.runtime.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  claimCurrentSessionPendingInputDedupeRecovery,
  isFinalInputCompletion,
  hasSessionPendingInputOwner,
  parseSessionPendingInputMessage,
  registerSessionPendingInputOwner,
  finishSessionPendingInputOwner,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
  resolveSqliteWriteAdmissionScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => Promise<void>;
  completion?: AgentRunTerminalOutcome;
  complete?: (outcome: AgentRunTerminalOutcome) => Promise<AgentRunTerminalOutcome>;
};
const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();

function ownerReceipt(owner: SessionPendingInputOwner): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    state: "queued",
    inputId: owner.inputId,
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    finish: owner.finish,
  };
  receiptOwners.set(receipt, owner);
  return receipt;
}

/** Install only a private receipt's persistence context; this does not reopen execution authority. */
export function withSessionPendingInputPersistence<T>(
  receipt: SessionPendingInputReceipt,
  persist: () => T,
): T {
  const owner = receiptOwners.get(receipt);
  return owner ? runWithSessionPendingInputPersistence(owner, persist) : receipt.run(persist);
}

/** Bind one collected message to its private admitted sources without creating another durable queue. */
export function bindSessionPendingInputSources(
  receipts: readonly SessionPendingInputReceipt[],
  message: PersistedUserTurnMessage,
): SessionPendingInputReceipt | undefined {
  const sources = [
    ...new Set(
      receipts.flatMap((receipt) => {
        if (receipt.state === "consumed") {
          throw new Error("Collected input has already been consumed");
        }
        const owner = receiptOwners.get(receipt);
        return owner ? (owner.sources ?? [owner]) : [];
      }),
    ),
  ];
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (
    !idempotencyKey ||
    sources.some(
      (source) =>
        source.databasePath !== first.databasePath ||
        source.sessionId !== first.sessionId ||
        source.sessionKey !== first.sessionKey ||
        source.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error("Collected input requires one exact session and a distinct aggregate identity");
  }
  // Collected framing still passes storage redaction; its staged sources have
  // already passed approval and must not run through another plugin hook.
  const clients = normalizeMessageClientSources(
    receipts.flatMap((receipt) => readMessageClientSources(receipt.message)),
  );
  const collectedMessage = { ...message };
  if (clients.length) {
    collectedMessage["__openclaw"] = {
      ...message["__openclaw"],
      transport: { ...asOptionalRecord(message["__openclaw"]?.transport), clients },
    };
  }
  const messageJson = JSON.stringify(
    redactTranscriptMessageForStorage(collectedMessage, { config: sources.at(-1)?.config }),
  );
  if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Collected input exceeds the Gateway payload limit");
  }
  const aggregateInputId = randomUUID();
  return ownerReceipt({
    ...first,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: async (disposition) => {
      const settled = await Promise.allSettled(sources.map((source) => source.finish(disposition)));
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Failed to finish collected input custody");
      }
    },
  });
}

/** Accept durable input without changing the active transcript or scheduling execution. */
export async function stageSessionPendingInput(
  scope: PendingInputScope,
  options: PendingInputRequest & {
    /** Records processing completion separately from canonical transcript consumption. */
    trackCompletion?: boolean;
    assertCurrent: () => void;
    /** Retained only after the full admission checks and custody transaction commit. */
    assertAdmittedCurrent?: () => void;
    assertCompletionCurrent?: () => void;
  },
): Promise<SessionPendingInputReceipt | undefined> {
  const preparedRequest = preparePendingInputRequest(options);
  const { idempotencyKey } = preparedRequest;
  const capturedScope = { ...scope, env: { ...(scope.env ?? process.env) } };
  const admissionScope = resolveSqliteWriteAdmissionScope(capturedScope);
  const prepare = async () => {
    const resolved = captureLifecycleDatabaseScope({
      ...(await prepareSqliteScope(capturedScope)),
      sessionId: scope.sessionId,
    });
    return withSessionPendingInputDatabase<SessionPendingInputReceipt | undefined>(
      resolved,
      options.assertCurrent,
      async (access) => {
        options.assertCurrent();
        const snapshot = await access.read({
          idempotencyKey,
          trackCompletion: options.trackCompletion,
        });
        options.assertCurrent();
        if (!snapshot) {
          return undefined;
        }
        const { existing, previous, committed, source } = snapshot;
        const replayRequest = resolvePendingInputReplayRequest(
          preparedRequest,
          previous ?? existing,
        );
        const { message, stableMessage } = replayRequest;
        let requestHash = replayRequest.requestHash;
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        let finished = false;
        let complete: SessionPendingInputReceipt["complete"];
        if (options.trackCompletion) {
          const completionScope = {
            idempotencyKey,
            runId: options.runId,
            lifecycleGeneration,
          };
          if (
            previous &&
            (previous.request_hash !== requestHash || previous.run_id !== options.runId)
          ) {
            throw new Error("Input completion idempotency key conflicts with the accepted input");
          }
          if (previous && isFinalInputCompletion(previous.outcome)) {
            return {
              state: "consumed",
              inputId: idempotencyKey,
              message,
              completion: previous.outcome,
              run: () => {
                throw new Error("Input processing has already completed");
              },
              finish: async () => {},
            };
          }
          complete = (outcome) => {
            const assertCompletion = () => {
              if (finished) {
                throw new Error("Input completion owner has already been released");
              }
              // Cancellation retains the original owner until its terminal write settles.
              (options.assertCompletionCurrent ?? options.assertCurrent)();
              assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            };
            return withSessionPendingInputDatabase(
              resolved,
              assertCompletion,
              (current) => current.complete({ ...completionScope, requestHash, outcome }),
              source,
            );
          };
        }
        if (existing) {
          if (
            !matchesSessionPendingInputRequest(existing, stableMessage, requestHash) ||
            existing.run_id !== options.runId
          ) {
            throw new Error("Pending input idempotency key conflicts with the accepted input");
          }
          if (existing.consumed_event_id != null) {
            return {
              state: "consumed",
              inputId: existing.input_id,
              message: parseSessionPendingInputMessage(existing.message_json),
              run: () => {
                throw new Error("Pending input has already been consumed");
              },
              finish: async () => {},
            };
          }
          if (hasSessionPendingInputOwner(source.path, existing)) {
            throw new Error("Pending input is already admitted; wait for its current turn");
          }
          if (
            (!options.requestFingerprint && !options.trackCompletion) ||
            (existing.state !== "queued" && existing.state !== "interrupted") ||
            (existing.lifecycle_generation === lifecycleGeneration && !options.trackCompletion)
          ) {
            throw new Error("Pending input ownership ended; submit a new turn to continue");
          }
        }
        if (committed) {
          const committedMessage = parseSessionPendingInputMessage(
            JSON.stringify(committed.message),
          );
          if (options.trackCompletion) {
            const committedRequestHash = resolveCommittedPendingInputRequestHash(
              {
                ...options,
                message,
                replaySourceSessionKeys:
                  previous || existing ? undefined : options.replaySourceSessionKeys,
              },
              committedMessage,
            );
            if (!committedRequestHash) {
              return undefined;
            }
            requestHash = committedRequestHash;
            options.assertCurrent();
          }
          // Committed transcript replay keeps its existing contract and never creates new custody.
          return {
            state: "queued",
            inputId: committed.messageId,
            message: committedMessage,
            run: (operation) => {
              options.assertCurrent();
              return operation();
            },
            finish: async () => {
              finished = true;
            },
            ...(complete ? { complete } : {}),
          };
        }
        const prepared = existing
          ? parseSessionPendingInputMessage(existing.message_json)
          : options.prepareMessageAfterIdempotencyCheck
            ? options.prepareMessageAfterIdempotencyCheck(message)
            : message;
        if (!prepared) {
          return undefined;
        }
        const messageJson =
          existing?.message_json ??
          JSON.stringify(redactTranscriptMessageForStorage(prepared, { config: options.config }));
        if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
          throw new Error("Approved pending input exceeds the Gateway payload limit");
        }
        const inputId = existing?.input_id ?? randomUUID();
        const accepted = await access.stage({
          snapshot,
          trackCompletion: options.trackCompletion,
          inputId,
          idempotencyKey,
          runId: options.runId,
          requestHash,
          messageJson,
          lifecycleGeneration,
        });
        if (!accepted) {
          return undefined;
        }
        const owner: SessionPendingInputOwner = {
          inputId,
          transcriptInputId: inputId,
          sessionId: scope.sessionId,
          sessionKey: resolved.sessionKey,
          databasePath: source.path,
          idempotencyKey,
          lifecycleGeneration,
          messageJson,
          config: options.config,
          assertCurrent: options.assertAdmittedCurrent ?? options.assertCurrent,
          ...(existing ? { restartRecovered: true as const } : {}),
          finish: (disposition) => {
            finished = true;
            return finishSessionPendingInputOwner(owner, () =>
              withSessionPendingInputDatabase(
                resolved,
                () => {},
                (current) => current.finish({ inputId, lifecycleGeneration, disposition }),
                source,
              ),
            );
          },
        };
        registerSessionPendingInputOwner(owner);
        const receipt = ownerReceipt(owner);
        if (complete) {
          receipt.complete = complete;
        }
        return receipt;
      },
    );
  };
  return admissionScope
    ? runExclusiveSqliteSessionWrite(admissionScope, prepare, "session.pending-input.stage")
    : prepare();
}

/** Verify source custody before replacing a stale process-local completed receipt. */
export function claimSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): boolean {
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => claimCurrentSessionPendingInputDedupeRecovery(database, resolved, runId),
    toDatabaseOptions(resolved),
  );
  return result.found && result.value;
}

export {
  listSessionPendingInputs,
  readSessionPendingInput,
  readSessionSubmittedInput,
  listSessionPendingInputReceipts,
} from "./session-accessor.pending-inputs.read.js";
