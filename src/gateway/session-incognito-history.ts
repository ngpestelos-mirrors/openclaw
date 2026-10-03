import path from "node:path";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.types.js";
import type {
  ChatHistoryPageParams,
  SessionHistoryReadParams,
} from "../config/sessions/session-history-types.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "../config/sessions/session-incognito-history-contract.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import type { SubagentCoordinationDisplayResolver } from "./chat-display-projection.history.js";
import type { CurrentUserProfileDisplayResolver } from "./current-user-profile-display.js";
import { readChatHistoryPageKernel } from "./server-methods/chat-history-page-kernel.js";
import { encodeChatHistoryResponsePage } from "./server-methods/chat-history-response-page.js";
import { readSessionHistorySnapshotKernel } from "./session-history-snapshot.js";
import type { SessionTranscriptReader } from "./session-transcript-read-kernel.js";

/** Inactive composition: callers retain the actor and supply already-prepared display facts. */
export function createIncognitoSessionHistoryReader(params: {
  actor: Pick<IncognitoAgentDatabaseExecution, "sessions" | "assertCurrent">;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget & { agentId: string; storePath: string };
  subagentCoordination: SubagentCoordinationDisplayResolver;
  resolveCurrentUserProfileDisplay: CurrentUserProfileDisplayResolver;
  resolveCronJobName?: (jobId: string) => string | undefined;
  signal?: AbortSignal;
}) {
  const { actor, authority, signal, subagentCoordination } = params;
  authority.assertCurrent();
  actor.assertCurrent();
  const { agentId, storePath, ...target } = structuredClone(params.target);
  const capturedStorePath = path.resolve(storePath);
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    actor.assertCurrent();
    authority.assertCurrent();
    claim.assertCurrent();
    subagentCoordination.assertCurrent?.();
  };
  const assertScope = (scope: Partial<SessionTranscriptReadScope>) => {
    assertCurrent();
    if (
      scope.sessionId !== target.sessionId ||
      (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
      (scope.agentId !== undefined && scope.agentId !== agentId) ||
      (scope.storePath !== undefined && path.resolve(scope.storePath) !== capturedStorePath) ||
      (scope.sessionEntry?.sessionId !== undefined &&
        scope.sessionEntry.sessionId !== target.sessionId)
    ) {
      throw new Error("Incognito history request belongs to another session or store");
    }
  };
  const disclose = <T>(value: T): T => {
    assertCurrent();
    claim.authorize(authority, "commit");
    assertCurrent();
    return value;
  };
  const read = async <Key extends keyof IncognitoHistoryOperations>(
    scope: SessionTranscriptReadScope,
    command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
  ): Promise<IncognitoHistoryOperations[Key]["output"]> => {
    assertScope(scope);
    return disclose(await actor.sessions.history(authority, command, signal));
  };
  const readers: SessionTranscriptReader = {
    subagentCoordination,
    readSessionMessageCountAsync: (scope) =>
      read(scope, { type: "session.history.count", input: target }),
    readRecentSessionMessagesWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.recent", input: { ...target, options } }),
    readSessionMessagesPageWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.page", input: { ...target, options } }),
    readSessionMessagesAroundIdWithStatsAsync: (scope, options) =>
      read(scope, { type: "session.history.around-id", input: { ...target, options } }),
    readSessionMessageByIdAsync: (scope, messageId, options) =>
      read(scope, { type: "session.history.by-id", input: { ...target, messageId, options } }),
    async readSessionMessagesWithSourceAsync(scope, options) {
      const { messages, offPathMessages, transcriptPath } = await read(scope, {
        type: "session.history.source",
        input: { ...target, options },
      });
      return disclose({
        messages: offPathMessages ? [...messages, ...offPathMessages] : messages,
        transcriptPath,
      });
    },
    async readSessionMessagesAsync(scope, options) {
      return disclose((await readers.readSessionMessagesWithSourceAsync(scope, options)).messages);
    },
    async readSessionMessagesMatchingIdAsync(scope, messageId) {
      return disclose(
        (
          await read(scope, {
            type: "session.history.lookup",
            input: { ...target, messageId },
          })
        ).messages,
      );
    },
  };
  const options = {
    readers,
    readOnly: true,
    resolveCurrentUserProfileDisplay: params.resolveCurrentUserProfileDisplay,
    resolveCronJobName: params.resolveCronJobName ?? (() => undefined),
  };
  return {
    readers,
    async rpc(request: ChatHistoryPageParams) {
      const captured = structuredClone(request);
      assertScope({
        agentId: captured.sessionAgentId,
        sessionId: captured.sessionId,
        sessionKey: captured.canonicalKey,
        storePath: captured.storePath,
        sessionEntry: captured.entry,
      });
      const page = await readChatHistoryPageKernel(captured, options);
      return disclose(encodeChatHistoryResponsePage(page, captured));
    },
    async http(request: SessionHistoryReadParams) {
      const captured = structuredClone(request);
      assertScope(captured.target);
      return disclose(await readSessionHistorySnapshotKernel(captured, options));
    },
  };
}
