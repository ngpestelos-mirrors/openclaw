import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-native.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  readSessionPendingInputStage,
  commitSessionPendingInputStage,
  completeSessionPendingInputInDatabase,
  finishSessionPendingInputInDatabase,
  repairSessionPendingInputRowsInDatabase,
  type PendingInputStageRead,
  type PendingInputStageCommit,
  type PendingInputCompletion,
  type PendingInputFinish,
} from "./session-accessor.pending-inputs.kernel.js";
import type { PendingInputIdentity } from "./session-accessor.pending-inputs.read.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { hasSessionPendingInputOwner } from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";

type PendingInputAccess = {
  read(request: PendingInputStageRead): Promise<ReturnType<typeof readSessionPendingInputStage>>;
  stage(request: PendingInputStageCommit): Promise<boolean>;
  complete(
    request: PendingInputCompletion,
  ): Promise<ReturnType<typeof completeSessionPendingInputInDatabase>>;
  finish(request: PendingInputFinish): Promise<void>;
};

/** Keep preparation and commit in the same physical writer FIFO; authority stays on the host. */
export async function withSessionPendingInputDatabase<T>(
  resolved: ResolvedTranscriptScope & { path: string },
  assertCurrent: () => void,
  run: (access: PendingInputAccess) => Promise<T>,
  captured?: CapturedSessionEntryReadSource,
): Promise<T> {
  const options = { ...toDatabaseOptions(resolved), path: resolved.path };
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    return runOpenClawAgentWriteAdmission(
      options,
      async () => {
        const database = openOpenClawAgentDatabase(options);
        const assertHeld = () => {
          assertCurrent();
          if (captured) {
            assertCapturedSessionEntryReadSource(captured, database);
          }
        };
        const write = <T>(mutate: (current: typeof database) => T): Promise<T> => {
          assertHeld();
          return Promise.resolve(
            runOpenClawAgentWriteTransaction((current) => {
              assertHeld();
              const result = mutate(current);
              assertHeld();
              return result;
            }, options),
          );
        };
        return run({
          read: (request) =>
            write((current) => readSessionPendingInputStage(current, resolved, request)),
          stage: (request) =>
            write((current) => commitSessionPendingInputStage(current, resolved, request)),
          complete: (request) =>
            write((current) => completeSessionPendingInputInDatabase(current, resolved, request)),
          finish: (request) =>
            write((current) => finishSessionPendingInputInDatabase(current, request)),
        });
      },
      true,
    );
  }
  const { env: _env, ...workerScope } = resolved;
  const access = (worker: AgentDatabaseExecutionScope): PendingInputAccess => ({
    read: (request) =>
      worker.execute({
        type: "session.pendingInput.read",
        input: { resolved: workerScope, ...request },
      }),
    stage: (request) =>
      worker.execute({
        type: "session.pendingInput.stage",
        input: { resolved: workerScope, ...request },
      }),
    complete: (request) =>
      worker.execute({
        type: "session.pendingInput.complete",
        input: { resolved: workerScope, ...request },
      }),
    finish: (request) => worker.execute({ type: "session.pendingInput.finish", input: request }),
  });
  return withSessionEntryWorker(
    options,
    typeof captured?.databaseIdentity === "string" ? captured.databaseIdentity : undefined,
    assertCurrent,
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => ({
        value: await run(access(worker)),
      }));
      if (!result) {
        throw new Error("Pending input database disappeared before custody settlement");
      }
      return result.value;
    },
  );
}

export async function repairSessionPendingInputRows(
  options: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  rows: PendingInputIdentity[],
  identity: { identity: string; birthtime?: string } | undefined,
  assertCurrent: () => void,
): Promise<string[]> {
  const assertUnowned = () => {
    assertCurrent();
    if (
      rows.some(
        (row) => !row.requireRetiredSession && hasSessionPendingInputOwner(options.path, row),
      )
    ) {
      throw new Error("Pending input acquired a live owner before interruption");
    }
  };
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    return runExclusiveSqliteSessionWrite(
      options,
      async () =>
        runOpenClawAgentWriteTransaction((database) => {
          assertUnowned();
          const repaired = repairSessionPendingInputRowsInDatabase(database, rows);
          assertUnowned();
          return repaired;
        }, options),
      "session.pending-input.stage",
    );
  }
  return withSessionEntryWorker(
    options,
    identity?.identity,
    assertUnowned,
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => ({
        rows: await worker.execute({ type: "session.pendingInput.repair", input: { rows } }),
      }));
      return result?.rows ?? [];
    },
  );
}
