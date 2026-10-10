import { createHash } from "node:crypto";
import { chatMetadataSessionFields } from "../../gateway/server-methods/chat-metadata-contract.js";
import { resolveIncognitoSessionExpiresAt } from "../../shared/incognito-session-key.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseIncognitoIdentity } from "../../state/openclaw-agent-execution-identity.types.js";
import { projectSessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { projectSessionEntryCapabilityFacts } from "./session-entry-capability-facts.js";
import { sessionEntryReadRevision } from "./session-entry-read-revision.js";
import type { IncognitoSessionSnapshot } from "./session-incognito-contract.js";
import type { IncognitoSessionFacts } from "./session-incognito-facts.types.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";

export function createIncognitoSessionSnapshotReader(
  database: OpenClawAgentDatabase,
  identity: AgentDatabaseIncognitoIdentity,
  facts: {
    revision(sessionKey: string): number;
    completionSources(sessionKey: string): IncognitoSessionFacts["completionSources"];
  },
) {
  return (sessionKey: string): IncognitoSessionSnapshot => {
    const entry = readExactSessionEntryRow(database, sessionKey)?.entry;
    return {
      entry,
      facts: [
        {
          identity,
          sessionKey,
          revision: facts.revision(sessionKey),
          completionSources: facts.completionSources(sessionKey),
          capability: entry ? projectSessionEntryCapabilityFacts(entry) : undefined,
          entryReadRevision: entry ? sessionEntryReadRevision(entry) : undefined,
          chatMetadataRevision: entry
            ? createHash("sha256")
                .update(JSON.stringify(chatMetadataSessionFields.map((field) => entry[field])))
                .digest("hex")
            : undefined,
          delivery: entry
            ? { sessionId: entry.sessionId, updatedAt: entry.updatedAt, delivery: entry.delivery }
            : undefined,
          media: entry
            ? {
                sessionId: entry.sessionId,
                updatedAt: entry.updatedAt,
                lifecycleRevision: entry.lifecycleRevision,
                permissionMode: entry.permissionMode,
                execNode: entry.execNode,
                repositoryWorkspaceId: entry.repositoryWorkspaceId,
                worktreeId: entry.worktree?.id,
                sessionRoot: entry.sessionRoot,
                spawnedCwd: entry.spawnedCwd,
                spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
                pendingWorktree: entry.pendingWorktree,
                pendingProjectGitUrl: entry.pendingProjectGitUrl,
              }
            : undefined,
          steering: entry
            ? {
                lifecycleRevision: entry.lifecycleRevision,
                restartRecoveryHarnessCompletion: entry.restartRecoveryHarnessCompletion,
                restartRecoveryTerminalDeliveryEvidence:
                  entry.restartRecoveryTerminalDeliveryEvidence?.map((receipt) => ({
                    runId: receipt.runId,
                    harnessCompletion: receipt.harnessCompletion,
                    deliveryContext: receipt.deliveryContext,
                    payloads: receipt.payloads?.map(({ visible }) => ({ visible })),
                    payloadsTruncated: receipt.payloadsTruncated,
                    deliveryStatus: receipt.deliveryStatus && {
                      status: receipt.deliveryStatus.status,
                      resultCount: receipt.deliveryStatus.resultCount,
                    },
                    messagingToolSentTargets: receipt.messagingToolSentTargets?.map(
                      ({
                        provider,
                        accountId,
                        to,
                        threadId,
                        threadImplicit,
                        threadSuppressed,
                        visible,
                        sourceReplyFinal,
                      }) => ({
                        provider,
                        accountId,
                        to,
                        threadId,
                        threadImplicit,
                        threadSuppressed,
                        visible,
                        sourceReplyFinal,
                      }),
                    ),
                    messagingToolSentTargetsTruncated: receipt.messagingToolSentTargetsTruncated,
                    messagingToolAggregateEvidenceUnaccounted:
                      receipt.messagingToolAggregateEvidenceUnaccounted,
                  })),
                sessionId: entry.sessionId,
                updatedAt: entry.updatedAt,
                status: entry.status,
                restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
                restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
                restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
                restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
                restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
              }
            : undefined,
          sharing: entry
            ? {
                entry: projectSessionSharingEntry(entry),
                membership: new Set(
                  listSessionMembersInDatabase(database, sessionKey).map(
                    (member) => member.identityId,
                  ),
                ),
              }
            : undefined,
          expiresAt: entry ? resolveIncognitoSessionExpiresAt(entry) : undefined,
        },
      ],
    };
  };
}

export function withIncognitoSessionFacts<Value>(
  value: Value,
  facts: IncognitoSessionFacts[],
): Value extends unknown ? { value: Value; facts: IncognitoSessionFacts[] } : never;
export function withIncognitoSessionFacts(value: unknown, facts: IncognitoSessionFacts[]) {
  return { value, facts };
}
