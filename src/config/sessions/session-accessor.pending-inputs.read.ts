import { sql } from "kysely";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  hasSessionPendingInputsSchema,
  hasPendingInputConsumptionColumn,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import {
  projectSessionPendingInput,
  type SessionPendingInput,
  type SessionPendingInputRow,
} from "./session-accessor.sqlite-pending-inputs.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export type SessionPendingInputReadRequest = {
  sessionKey: string;
  sessionId: string;
  limit?: number;
  before?: number;
  id?: string;
};
export type SessionPendingInputReadResult = {
  rows: Array<
    Pick<
      SessionPendingInputRow,
      "input_id" | "session_key" | "session_id" | "lifecycle_generation"
    > & { input: SessionPendingInput }
  >;
  total: number | undefined;
  nextBefore?: number;
};

/** Return no payload when the existing byte selection exceeds the caller's inline budget. */
export function readSessionPendingInputPage(
  database: Pick<OpenClawAgentDatabase, "db">,
  scope: SessionPendingInputReadRequest,
  inline?: { bytes: number; rows: number },
): SessionPendingInputReadResult | undefined {
  const limit = Math.max(1, Math.min(20, Math.trunc(scope.limit ?? 20)));
  if (!hasSessionPendingInputsSchema(database.db)) {
    return { rows: [], total: 0 };
  }
  const db = getSessionKysely(database.db);
  let base = db
    .selectFrom("session_pending_inputs")
    .where("session_key", "=", scope.sessionKey)
    .where("session_id", "=", scope.sessionId);
  if (hasPendingInputConsumptionColumn(database.db)) {
    base = base.where("consumed_event_id", "is", null);
  }
  const total =
    scope.id === undefined
      ? (executeSqliteQueryTakeFirstSync(
          database.db,
          inline
            ? db
                .selectFrom(
                  base
                    .select("input_id")
                    .limit(inline.rows + 1)
                    .as("pending"),
                )
                .select(db.fn.count<number>("input_id").as("total"))
            : base.select(db.fn.count<number>("input_id").as("total")),
        )?.total ?? 0)
      : undefined;
  if (inline && total !== undefined && total > inline.rows) {
    return undefined;
  }
  let query = base.orderBy("seq", "desc").limit(limit + 1);
  if (scope.before !== undefined) {
    query = query.where("seq", "<", scope.before);
  }
  if (scope.id !== undefined) {
    query = query.where("input_id", "=", scope.id);
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
  if (inline && bytes > inline.bytes) {
    return undefined;
  }
  // Sort the bounded page in memory instead of spilling full message bodies to a temp B-tree.
  const rows = selected.length
    ? executeSqliteQuerySync(
        database.db,
        base.selectAll().where("seq", "in", selected),
      ).rows.toSorted((left, right) => right.seq - left.seq)
    : [];
  return {
    rows: rows.map((row) => ({
      input_id: row.input_id,
      session_key: row.session_key,
      session_id: row.session_id,
      lifecycle_generation: row.lifecycle_generation,
      input: projectSessionPendingInput(row),
    })),
    total,
    nextBefore: selected.length < metadata.length ? selected.at(-1) : undefined,
  };
}
