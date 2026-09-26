import { sql } from "kysely";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  hasPendingInputConsumptionColumn,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  hasSessionPendingInputOwner,
  MAX_INLINE_PENDING_INPUT_BYTES,
  parseSessionPendingInputMessage,
  projectSessionPendingInput,
  readSessionPendingInputByKey,
  type SessionPendingInput,
  type SessionPendingInputPage,
  type SessionPendingInputRow,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  captureLifecycleDatabaseScope,
  getSessionKysely,
  normalizeSqliteSessionKey,
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
const MAX_INLINE_PENDING_INPUT_ROWS = 256;
type PendingInputReadOptions = { limit?: number; before?: number; id?: string };
export type PendingInputIdentity = Pick<
  SessionPendingInputRow,
  "input_id" | "session_key" | "session_id" | "lifecycle_generation"
> & {
  /** A registered old owner can be interrupted only if the writer proves its session retired. */
  requireRetiredSession?: true;
};
type PendingInputReadSnapshot = {
  rows: Array<{ identity: PendingInputIdentity; input: SessionPendingInput }>;
  total?: number;
  nextBefore?: number;
  currentSessionId?: string;
  databaseIdentity?: { identity: string; birthtime?: string };
};
export type SessionInputReceipt =
  | { runId: string; state: "pending" }
  | { runId: string; state: "consumed"; consumedByEventId: string };
export type PendingInputReadRequest = {
  scope: ResolvedTranscriptReadScope & { sessionKey: string };
} & ({ kind: "page"; options: PendingInputReadOptions } | { kind: "receipts"; runIds: string[] });
export type PendingInputReadResult =
  | { kind: "page"; snapshot: PendingInputReadSnapshot }
  | {
      kind: "receipts";
      receipts: SessionInputReceipt[];
      databaseIdentity?: PendingInputReadSnapshot["databaseIdentity"];
    };

/** Byte admission selects inline reads or the retained history reader before materialization. */
export function readPendingInputsInDatabase(
  request: PendingInputReadRequest,
  maxInlineBytes: number,
): PendingInputReadResult | undefined;
export function readPendingInputsInDatabase(
  request: PendingInputReadRequest,
): PendingInputReadResult;
export function readPendingInputsInDatabase(
  request: PendingInputReadRequest,
  maxInlineBytes?: number,
): PendingInputReadResult | undefined {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database): PendingInputReadResult | undefined =>
      runSqliteDeferredTransactionSync(database.db, () => {
        const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
        const databaseIdentity = typeof identity === "string" ? { identity, birthtime } : undefined;
        const db = getSessionKysely(database.db);
        const hasSchema = hasSessionPendingInputsSchema(database.db);
        if (request.kind === "receipts") {
          const rows =
            hasSchema && hasPendingInputConsumptionColumn(database.db)
              ? executeSqliteQuerySync(
                  database.db,
                  db
                    .selectFrom("session_pending_inputs")
                    .select(["run_id", "consumed_event_id"])
                    .where("session_key", "=", request.scope.sessionKey)
                    .where("session_id", "=", request.scope.sessionId)
                    .where("run_id", "in", request.runIds)
                    .orderBy("seq", "asc")
                    .limit(51),
                ).rows
              : [];
          // Correlation is not unique authority; ambiguous runs must retain their provisional input.
          if (rows.length > 50 || new Set(rows.map((row) => row.run_id)).size !== rows.length) {
            throw new Error("Pending input receipt lookup has ambiguous source run IDs");
          }
          return {
            kind: "receipts",
            databaseIdentity,
            receipts: rows.map((row) =>
              row.consumed_event_id == null
                ? { runId: row.run_id, state: "pending" }
                : {
                    runId: row.run_id,
                    state: "consumed",
                    consumedByEventId: row.consumed_event_id,
                  },
            ),
          };
        }
        if (!hasSchema) {
          return { kind: "page", snapshot: { rows: [], total: 0, databaseIdentity } };
        }
        const { options } = request;
        const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
        let base = db
          .selectFrom("session_pending_inputs")
          .where("session_key", "=", request.scope.sessionKey)
          .where("session_id", "=", request.scope.sessionId);
        if (hasPendingInputConsumptionColumn(database.db)) {
          base = base.where("consumed_event_id", "is", null);
        }
        const total =
          options.id === undefined
            ? (executeSqliteQueryTakeFirstSync(
                database.db,
                maxInlineBytes === undefined
                  ? base.select(db.fn.count<number>("input_id").as("total"))
                  : db
                      .selectFrom(
                        base
                          .select("input_id")
                          .limit(MAX_INLINE_PENDING_INPUT_ROWS + 1)
                          .as("bounded"),
                      )
                      .select((eb) => eb.fn.countAll<number>().as("total")),
              )?.total ?? 0)
            : undefined;
        if (
          maxInlineBytes !== undefined &&
          total !== undefined &&
          total > MAX_INLINE_PENDING_INPUT_ROWS
        ) {
          return undefined;
        }
        let query = base.orderBy("seq", "desc").limit(limit + 1);
        if (options.before !== undefined) {
          query = query.where("seq", "<", options.before);
        }
        if (options.id !== undefined) {
          query = query.where("input_id", "=", options.id);
        }
        const metadata = executeSqliteQuerySync(
          database.db,
          query.select([
            "seq",
            /* kysely-allow-raw: Bound the page before fetching accepted message JSON. */
            sql<number>`OCTET_LENGTH(message_json)`.as("serialized_bytes"),
          ]),
        ).rows;
        const selected: number[] = [];
        let bytes = 0;
        for (const row of metadata) {
          if (selected.length === limit || bytes + row.serialized_bytes > MAX_PAYLOAD_BYTES) {
            break;
          }
          selected.push(row.seq);
          bytes += row.serialized_bytes;
        }
        if (metadata.length && !selected.length) {
          throw new Error("Stored pending input exceeds the Gateway payload limit");
        }
        if (maxInlineBytes !== undefined && bytes > maxInlineBytes) {
          return undefined;
        }
        const rows = selected.length
          ? executeSqliteQuerySync(
              database.db,
              base.selectAll().where("seq", "in", selected).orderBy("seq", "desc"),
            ).rows
          : [];
        const currentSessionId = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select("current_session_id")
            .where("session_key", "=", request.scope.sessionKey),
        )?.current_session_id;
        return {
          kind: "page",
          snapshot: {
            rows: rows.map((row) => ({
              identity: {
                input_id: row.input_id,
                session_key: row.session_key,
                session_id: row.session_id,
                lifecycle_generation: row.lifecycle_generation,
              },
              input: projectSessionPendingInput(row),
            })),
            total,
            currentSessionId,
            databaseIdentity,
            nextBefore: selected.length < metadata.length ? selected.at(-1) : undefined,
          },
        };
      }),
    toDatabaseOptions(request.scope),
  );
  return result.found
    ? result.value
    : request.kind === "page"
      ? { kind: "page", snapshot: { rows: [], total: 0 } }
      : { kind: "receipts", receipts: [] };
}

async function readPendingInputData(
  scope: PendingInputScope,
  selection:
    | Omit<Extract<PendingInputReadRequest, { kind: "page" }>, "scope">
    | Omit<Extract<PendingInputReadRequest, { kind: "receipts" }>, "scope">,
): Promise<PendingInputReadResult> {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const context = captureOpenClawStateWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const resolved = captureLifecycleDatabaseScope(await prepareSqliteTranscriptReadScope(captured));
  assertStateCurrent();
  const options = { ...toDatabaseOptions(resolved), path: resolved.path };
  const request = {
    ...selection,
    scope: { ...resolved, sessionKey: normalizeSqliteSessionKey(scope.sessionKey) },
  };
  const consume = async (result: PendingInputReadResult, assertCurrent: () => void) => {
    const databaseIdentity =
      result.kind === "page" ? result.snapshot.databaseIdentity : result.databaseIdentity;
    const assertSource = () => {
      assertStateCurrent();
      assertCurrent();
      if (databaseIdentity) {
        assertExistingDatabaseIdentity(
          resolved.path,
          `file:${databaseIdentity.identity}`,
          databaseIdentity.birthtime,
        );
      }
    };
    assertSource();
    if (result.kind === "page") {
      const stale = result.snapshot.rows.filter(
        ({ identity, input }) =>
          input.state === "queued" &&
          (result.snapshot.currentSessionId !== identity.session_id ||
            !hasSessionPendingInputOwner(resolved.path, identity)),
      );
      if (stale.length) {
        const { repairSessionPendingInputRows } =
          await import("./session-accessor.pending-inputs.runtime.js");
        const repaired = await repairSessionPendingInputRows(
          options,
          stale.map(({ identity: row }) => {
            if (
              result.snapshot.currentSessionId !== row.session_id &&
              hasSessionPendingInputOwner(resolved.path, row)
            ) {
              row.requireRetiredSession = true;
            }
            return row;
          }),
          databaseIdentity,
          assertSource,
        );
        assertSource();
        const interrupted = new Set(repaired);
        for (const row of result.snapshot.rows) {
          if (interrupted.has(row.identity.input_id)) {
            row.input.state = "interrupted";
          }
        }
      }
    }
    return result;
  };
  const inline = isIncognitoOpenClawAgentSqlitePath(resolved.path, options)
    ? readPendingInputsInDatabase(request)
    : readPendingInputsInDatabase(request, MAX_INLINE_PENDING_INPUT_BYTES);
  if (inline !== undefined) {
    return await consume(inline, () => {});
  }
  return await withSessionHistoryWorkerDatabase(
    options,
    async (owner) => await consume(await owner.readPendingInputs(request), owner.assertCurrent),
  );
}

export async function listSessionPendingInputs(
  scope: PendingInputScope,
  options: { limit?: number; before?: number } = {},
): Promise<SessionPendingInputPage> {
  const result = await readPendingInputData(scope, { kind: "page", options: { ...options } });
  if (result.kind !== "page") {
    throw new Error("Pending input reader returned receipts instead of a page");
  }
  const { rows, total, nextBefore } = result.snapshot;
  return {
    items: rows.toReversed().map((row) => row.input),
    total: total ?? 0,
    ...(nextBefore !== undefined ? { nextBefore } : {}),
  };
}

export async function readSessionPendingInput(
  scope: PendingInputScope,
  id: string,
): Promise<SessionPendingInput | undefined> {
  const result = await readPendingInputData(scope, { kind: "page", options: { id, limit: 1 } });
  if (result.kind !== "page") {
    throw new Error("Pending input reader returned receipts instead of a page");
  }
  return result.snapshot.rows[0]?.input;
}

export async function listSessionPendingInputReceipts(
  scope: PendingInputScope,
  options: { runIds: readonly string[] },
): Promise<SessionInputReceipt[]> {
  if (options.runIds.length > 50) {
    throw new Error("Pending input receipt lookup accepts at most 50 run IDs");
  }
  const runIds = [...new Set(options.runIds)];
  if (!runIds.length) {
    return [];
  }
  const result = await readPendingInputData(scope, { kind: "receipts", runIds });
  if (result.kind !== "receipts") {
    throw new Error("Pending input reader returned a page instead of receipts");
  }
  return result.receipts;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): PersistedUserTurnMessage | undefined {
  try {
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const db = getSessionKysely(database.db);
          const session = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_nodes")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_nodes.current_session_id",
              )
              .select("current_session_id")
              .where("session_nodes.session_key", "=", resolved.sessionKey)
              .where("session_windows.session_key", "=", resolved.sessionKey),
          );
          if (session?.current_session_id !== resolved.sessionId) {
            return undefined;
          }
          // Collected sources survive consumption; their text is not the aggregate transcript.
          // Check byte metadata before either reader materializes stored JSON.
          const pending = hasSessionPendingInputsSchema(database.db)
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_pending_inputs")
                  .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", resolved.sessionId)
                  .where("idempotency_key", "=", idempotencyKey),
              )
            : undefined;
          let messageJson: string | undefined;
          if (pending) {
            if (pending.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            messageJson = readSessionPendingInputByKey(
              database,
              resolved,
              idempotencyKey,
            )?.message_json;
          } else {
            // Stale projections cannot establish retry identity. Their owning writer repairs them.
            if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
              return undefined;
            }
            const transcript = executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("transcript_event_identities as identity")
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "identity.session_id")
                    .onRef("event.seq", "=", "identity.seq"),
                )
                .select(transcriptEventReadBytesSql("event").as("bytes"))
                .where("identity.session_id", "=", resolved.sessionId)
                .where("identity.message_idempotency_key", "=", idempotencyKey)
                .orderBy("identity.seq", "desc")
                .limit(1),
            );
            if (!transcript || transcript.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            const committed = readTranscriptMessageByScopedIdempotencyKey(
              database,
              resolved,
              idempotencyKey,
              "scan",
            );
            messageJson = committed ? JSON.stringify(committed.message) : undefined;
          }
          if (!messageJson) {
            return undefined;
          }
          const message = parseSessionPendingInputMessage(messageJson);
          return readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
        }),
      toDatabaseOptions(resolved),
    );
    return result.found ? result.value : undefined;
  } catch {
    // Unavailable or corrupt storage supplies no proof of the original submitted bytes.
    return undefined;
  }
}
