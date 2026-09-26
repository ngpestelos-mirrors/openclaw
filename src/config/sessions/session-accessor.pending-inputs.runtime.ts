import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-native.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  readSessionPendingInputStage,
  pendingInputStageNeedsWorker,
  commitSessionPendingInputStage,
  completeSessionPendingInputInDatabase,
  finishSessionPendingInputInDatabase,
  repairSessionPendingInputRowsInDatabase,
  type PendingInputStageRead,
  type PendingInputStageSnapshot,
  type PendingInputAlreadyAdmitted,
  type PendingInputStageCommit,
  type PendingInputCompletion,
  type PendingInputFinish,
} from "./session-accessor.pending-inputs.kernel.js";
import type { PendingInputIdentity } from "./session-accessor.pending-inputs.read.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import {
  hasSessionPendingInputOwner,
  MAX_INLINE_PENDING_INPUT_BYTES,
} from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-accessor.types.js";

type PendingInputAccess = {
  read(
    request: PendingInputStageRead & { requestHash?: undefined },
    source?: CapturedSessionEntryReadSource,
  ): Promise<PendingInputStageSnapshot | undefined>;
  read(
    request: PendingInputStageRead,
    source?: CapturedSessionEntryReadSource,
  ): Promise<PendingInputStageSnapshot | PendingInputAlreadyAdmitted | undefined>;
  stage(request: PendingInputStageCommit): Promise<boolean>;
  complete(
    request: PendingInputCompletion,
  ): Promise<ReturnType<typeof completeSessionPendingInputInDatabase>>;
  finish(request: PendingInputFinish): Promise<void>;
};

/** Staging retains its outer writer FIFO; each native operation joins it under live authority. */
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
        const write = <TValue>(mutate: (current: typeof database) => TValue): Promise<TValue> => {
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
  const assertHeld = (source = captured) => {
    assertCurrent();
    if (source) {
      assertCapturedSessionEntryReadSource(source);
    }
  };
  const runWorker = <TValue>(
    operation: (worker: AgentDatabaseExecutionScope) => Promise<TValue>,
    expectedSource = captured,
  ): Promise<TValue> => {
    const assertSource = () => assertHeld(expectedSource);
    assertSource();
    return withSessionEntryWorker(
      options,
      typeof expectedSource?.databaseIdentity === "string"
        ? expectedSource.databaseIdentity
        : undefined,
      assertSource,
      async (execution, source) => {
        const result = await execution.runExisting(source, async (worker) => ({
          value: await operation(worker),
        }));
        if (!result) {
          throw new Error("Pending input database disappeared before custody settlement");
        }
        source.assertCurrent();
        return result.value;
      },
    );
  };
  function read(
    request: PendingInputStageRead & { requestHash?: undefined },
    expectedSource?: CapturedSessionEntryReadSource,
  ): Promise<PendingInputStageSnapshot | undefined>;
  function read(
    request: PendingInputStageRead,
    expectedSource?: CapturedSessionEntryReadSource,
  ): Promise<PendingInputStageSnapshot | PendingInputAlreadyAdmitted | undefined>;
  function read(
    request: PendingInputStageRead,
    expectedSource = captured,
  ): Promise<PendingInputStageSnapshot | PendingInputAlreadyAdmitted | undefined> {
    assertHeld(expectedSource);
    let readSource = expectedSource;
    if (!request.trackCompletion) {
      const result = withOpenClawAgentDatabaseReadOnly((database) => {
        if (expectedSource) {
          assertCapturedSessionEntryReadSource(expectedSource, database);
        }
        const physical = readOpenClawAgentDatabaseIdentity(database);
        readSource = {
          agentId: database.agentId,
          path: database.path,
          databaseIdentity: physical.identity,
          databaseBirthtime: physical.birthtime,
        };
        return runSqliteDeferredTransactionSync(database.db, () =>
          readSessionPendingInputStage(database, resolved, request, MAX_INLINE_PENDING_INPUT_BYTES),
        );
      }, options);
      assertHeld(readSource);
      if (result.found && result.value !== pendingInputStageNeedsWorker) {
        return Promise.resolve(result.value);
      }
    }
    return runWorker(
      (worker) =>
        worker.execute({
          type: "session.pendingInput.read",
          input: { resolved: workerScope, ...request },
        }),
      readSource,
    );
  }
  return run({
    read,
    stage: (request) =>
      runWorker(
        (worker) =>
          worker.execute({
            type: "session.pendingInput.stage",
            input: { resolved: workerScope, ...request },
          }),
        request.snapshot.source,
      ),
    complete: (request) =>
      runWorker((worker) =>
        worker.execute({
          type: "session.pendingInput.complete",
          input: { resolved: workerScope, ...request },
        }),
      ),
    finish: (request) =>
      runWorker((worker) =>
        worker.execute({ type: "session.pendingInput.finish", input: request }),
      ),
  });
}

export async function repairSessionPendingInputRows(
  options: { agentId: string; path: string; env?: NodeJS.ProcessEnv },
  rows: PendingInputIdentity[],
  identity: { identity: string; birthtime?: string } | undefined,
  assertCurrent: () => void,
): Promise<string[]> {
  return runOpenClawAgentWriteAdmission(
    options,
    async () => {
      assertCurrent();
      // Staging publishes its live owner before releasing this same writer FIFO.
      const unowned = rows.filter(
        (row) => row.requireRetiredSession || !hasSessionPendingInputOwner(options.path, row),
      );
      if (!unowned.length) {
        return [];
      }
      if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
        return runOpenClawAgentWriteTransaction((database) => {
          assertCurrent();
          const repaired = repairSessionPendingInputRowsInDatabase(database, unowned);
          assertCurrent();
          return repaired;
        }, options);
      }
      return withSessionEntryWorker(
        options,
        identity?.identity,
        assertCurrent,
        async (execution, source) => {
          const result = await execution.runExisting(source, async (worker) => ({
            rows: await worker.execute({
              type: "session.pendingInput.repair",
              input: { rows: unowned },
            }),
          }));
          return result?.rows ?? [];
        },
      );
    },
    true,
  );
}
