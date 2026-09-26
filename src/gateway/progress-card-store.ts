import type { ProgressCard, ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../session-cards/progress-card-store.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { captureGatewaySessionStoreScope } from "./board-store.js";

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
          const identity = readOpenClawAgentDatabaseIdentity(database);
          if (typeof identity.identity === "symbol") {
            return runOpenClawAgentWriteTransaction(
              (current) => {
                assertCurrent();
                return writeSessionProgressCard(current.db, scope.sessionKey, captured);
              },
              databaseOptions,
              { operationLabel: "progress-card.put" },
            );
          }
          const execution = captureOpenClawAgentDatabaseExecution(databaseOptions, {
            expectedIdentity: {
              kind: "file",
              physicalIdentity: identity.identity,
              birthtime: identity.birthtime,
              nativeLocation: identity.filename,
            },
          });
          const source: AgentDatabaseRequestExecutionSource = {
            assertCurrent() {
              execution.assertCurrent();
              if (
                getOpenClawAgentDatabaseIfOpen(databaseOptions) !== database ||
                !isOpenClawAgentDatabasePathCurrent(database)
              ) {
                throw new Error("Progress-card mutation lost its borrowed database owner");
              }
              assertCurrent();
            },
            createAdmission(binding) {
              return () => {
                let phase: "waiting" | "transaction" | "commit" = "waiting";
                return {
                  nativeLocations: binding.nativeLocations,
                  admission: createSqliteWorkerOperationAdmission((request, grant) => {
                    binding.authorize(request);
                    if (request.stage === "transaction" || request.stage === "commit") {
                      if (
                        !(
                          (phase === "waiting" && request.stage === "transaction") ||
                          (phase === "transaction" && request.stage === "commit")
                        )
                      ) {
                        throw new Error("Progress-card authority requested out of order");
                      }
                      phase = request.stage;
                    }
                    if (!grant()) {
                      throw new Error("Progress-card authority expired");
                    }
                  }, binding.attachment),
                };
              };
            },
          };
          try {
            const result = await runOpenClawAgentWorkerWrite(databaseOptions, () =>
              execution.runExisting(source, (worker) =>
                worker.execute({
                  type: "progress-card.put",
                  input: { ...captured, sessionKey: scope.sessionKey },
                }),
              ),
            );
            if (!result) {
              throw new Error("Progress-card database disappeared before mutation");
            }
            return result;
          } finally {
            await execution.release();
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
