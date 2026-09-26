import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import type { ProgressCardWriteOperations } from "../session-cards/progress-card-store.worker.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { captureGatewaySessionStoreScope } from "./board-store.js";

const log = createSubsystemLogger("gateway/progress-card");

export type ProgressCardStore = {
  get(sessionKey: string, agentId?: string): Promise<ProgressCard | null>;
  put(
    sessionKey: string,
    input: {
      markdown?: string;
      steps?: ProgressCardStep[];
      expectedRevision?: number;
      // The storage owner checks authority inside its write transaction.
      assertCurrent?: () => void;
    },
    agentId?: string,
  ): Promise<{ card: ProgressCard | null }>;
};

export const progressCardStore: ProgressCardStore = {
  async get(sessionKey, agentId) {
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
    const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
    if (isIncognitoOpenClawAgentSqlitePath(unsuffixed.path, { agentId: scope.agentId, env })) {
      const result = withOpenClawAgentDatabaseReadOnly(
        (database) => readSessionProgressCard(database.db, scope.sessionKey),
        { agentId: scope.agentId, path: unsuffixed.path, env },
      );
      return result.found ? result.value : null;
    }
    const target = await prepareSqliteTargetFromSessionStorePath(scope.storePath, {
      agentId: scope.agentId,
      env,
    });
    return await withSessionHistoryWorkerDatabase(
      { agentId: target.agentId ?? scope.agentId, path: target.path, env },
      (owner) => owner.readProgressCard({ sessionKey: scope.sessionKey, env }),
    );
  },
  async put(sessionKey, input, agentId) {
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const scope = captureGatewaySessionStoreScope(sessionKey, agentId);
    const assertCallerCurrent = input.assertCurrent;
    const captured = structuredClone({
      markdown: input.markdown,
      steps: input.steps,
      expectedRevision: input.expectedRevision,
    });
    const assertCurrent = () => {
      assertCallerCurrent?.();
      const current = captureGatewaySessionStoreScope(sessionKey, agentId);
      if (
        current.agentId !== scope.agentId ||
        current.storePath !== scope.storePath ||
        current.sessionKey !== scope.sessionKey
      ) {
        throw new Error("progress-card session changed; retry");
      }
    };
    assertCurrent();
    const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath);
    const incognito = isIncognitoOpenClawAgentSqlitePath(unsuffixed.path, {
      agentId: scope.agentId,
      env,
    });
    const prepareTarget = () =>
      incognito
        ? Promise.resolve({ agentId: scope.agentId, path: unsuffixed.path })
        : prepareSqliteTargetFromSessionStorePath(scope.storePath, { agentId: scope.agentId, env });
    const write = (target: Awaited<ReturnType<typeof prepareTarget>>) => {
      const databaseOptions = { agentId: target.agentId ?? scope.agentId, path: target.path, env };
      return withOpenClawAgentDatabaseAsync(
        databaseOptions,
        async (database) => {
          assertCurrent();
          if (typeof readOpenClawAgentDatabaseIdentity(database).identity === "symbol") {
            return runOpenClawAgentWriteTransaction(
              (current) => {
                assertCurrent();
                return writeSessionProgressCard(current.db, scope.sessionKey, captured);
              },
              databaseOptions,
              { operationLabel: "progress-card.put" },
            );
          }
          const publication = await openOpenClawAgentSqliteWorkerStore<ProgressCardWriteOperations>(
            databaseOptions,
            database.db,
            {
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.progressCardStore),
              input: undefined,
            },
          );
          let completed = false;
          let failure: unknown;
          try {
            const value = await publication.run(
              (worker) =>
                worker.execute({
                  type: "progress-card.put",
                  input: { ...captured, sessionKey: scope.sessionKey },
                }),
              assertCurrent,
            );
            completed = true;
            return value;
          } catch (error) {
            failure = error;
            throw error;
          } finally {
            try {
              await publication.close();
            } catch (error) {
              if (!completed) {
                throw new AggregateError(
                  [failure, error],
                  "Progress-card publication and cleanup failed",
                  {
                    cause: failure,
                  },
                );
              }
              try {
                log.warn(
                  `Progress-card publication completed before cleanup failed: ${formatErrorMessage(error)}`,
                );
              } catch {
                // Diagnostics cannot make a committed write replayable.
              }
            }
          }
        },
        assertCurrent,
      );
    };
    // Exact locators reserve FIFO before asynchronous owner discovery. Unresolved
    // store families first discover their path without borrowing another store's queue.
    const result = await (unsuffixed.agentId || unsuffixed.shared || incognito
      ? runOpenClawAgentWriteAdmission(
          { agentId: scope.agentId, path: unsuffixed.path, env },
          async () => write(await prepareTarget()),
          true,
        )
      : prepareTarget().then((target) =>
          runOpenClawAgentWriteAdmission(
            { agentId: target.agentId ?? scope.agentId, path: target.path, env },
            () => write(target),
            true,
          ),
        ));
    return "card" in result ? result : { card: null };
  },
};
