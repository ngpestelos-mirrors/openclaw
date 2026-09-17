import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { ensureWorktreeSessionBindingsSchema } from "../../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { WORKTREE_REMOVING_LEASE_KEY, worktreeRunLeaseScope } from "./run-lease-owner.js";
import type { ManagedWorktreeRecord } from "./types.js";

type BindingsDatabase = Pick<DB, "worktrees" | "worktree_session_bindings" | "state_leases">;
type WorktreeRow = Selectable<DB["worktrees"]>;
export type WorktreeSessionBindingState = "absent" | "inactive" | "active";

function dbFor(env: NodeJS.ProcessEnv): DatabaseSync {
  return openOpenClawStateDatabase({ env }).db;
}

function queryFor(db: DatabaseSync) {
  return getNodeSqliteKysely<BindingsDatabase>(db);
}

function explicitWorktreeSessionBindings(
  db: DatabaseSync,
  worktreeId: string,
): Array<{ sessionKey: string; active: boolean }> {
  if (!tableExists(db, "worktree_session_bindings")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    queryFor(db)
      .selectFrom("worktree_session_bindings")
      .select(["session_key", "active"])
      .where("worktree_id", "=", worktreeId)
      .orderBy("attached_at", "asc")
      .orderBy("session_key", "asc"),
  ).rows.map((row) => ({ sessionKey: row.session_key, active: row.active === 1 }));
}

function worktreeOwner(
  db: DatabaseSync,
  worktreeId: string,
): Pick<WorktreeRow, "owner_kind" | "owner_id" | "removed_at"> | undefined {
  return executeSqliteQuerySync(
    db,
    queryFor(db)
      .selectFrom("worktrees")
      .select(["owner_kind", "owner_id", "removed_at"])
      .where("id", "=", worktreeId),
  ).rows[0];
}

export function findSessionWorktreeBinding(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  options: { activeOnly?: boolean } = {},
): string | undefined {
  const db = dbFor(env);
  if (!tableExists(db, "worktree_session_bindings")) {
    return undefined;
  }
  let query = queryFor(db)
    .selectFrom("worktree_session_bindings")
    .select("worktree_id")
    .where("session_key", "=", sessionKey);
  if (options.activeOnly) {
    query = query.where("active", "=", 1);
  }
  return executeSqliteQuerySync(
    db,
    query.orderBy("active", "desc").orderBy("attached_at", "desc").limit(1),
  ).rows[0]?.worktree_id;
}

export function findActiveSessionWorktreeBinding(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
): string | undefined {
  return findSessionWorktreeBinding(env, sessionKey, { activeOnly: true });
}

export function hasExplicitWorktreeSessionBindings(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
): boolean {
  return explicitWorktreeSessionBindings(dbFor(env), worktreeId).length > 0;
}

export function worktreeSessionBindingsFromDatabase(
  db: DatabaseSync,
  worktreeId: string,
  options: { activeOnly?: boolean } = {},
): string[] {
  const explicit = explicitWorktreeSessionBindings(db, worktreeId);
  if (explicit.length > 0) {
    return explicit
      .filter((binding) => !options.activeOnly || binding.active)
      .map((binding) => binding.sessionKey);
  }
  const record = worktreeOwner(db, worktreeId);
  return record?.owner_kind === "session" && record.owner_id ? [record.owner_id] : [];
}

export function listRegistryWorktreeSessionBindings(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  options: { activeOnly?: boolean } = {},
): string[] {
  return worktreeSessionBindingsFromDatabase(dbFor(env), worktreeId, options);
}

export function isRegistryWorktreeSessionBound(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  sessionKey: string,
  options: { activeOnly?: boolean } = {},
): boolean {
  return listRegistryWorktreeSessionBindings(env, worktreeId, options).includes(sessionKey);
}

export function bindRegistryWorktreeSession(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  sessionKey: string,
  now = Date.now(),
  options: { expectedSessionKeys?: readonly string[] } = {},
): WorktreeSessionBindingState {
  const db = dbFor(env);
  ensureWorktreeSessionBindingsSchema(db);
  return runOpenClawStateWriteTransaction(
    () => {
      const record = worktreeOwner(db, worktreeId);
      if (!record || record.removed_at !== null) {
        throw new Error(`unknown active worktree: ${worktreeId}`);
      }
      const bindings = explicitWorktreeSessionBindings(db, worktreeId);
      const initialSessionKey =
        bindings.length === 0 && record.owner_kind === "session" ? record.owner_id : undefined;
      const currentBindings =
        bindings.length > 0
          ? bindings.map((binding) => binding.sessionKey)
          : initialSessionKey
            ? [initialSessionKey]
            : [];
      if (
        options.expectedSessionKeys &&
        (currentBindings.length !== options.expectedSessionKeys.length ||
          currentBindings.some((key, index) => key !== options.expectedSessionKeys![index]))
      ) {
        throw new Error("worktree session membership changed; retry attachment");
      }
      const removing = executeSqliteQuerySync(
        db,
        queryFor(db)
          .selectFrom("state_leases")
          .select("lease_key")
          .where("scope", "=", worktreeRunLeaseScope(worktreeId))
          .where("lease_key", "=", WORKTREE_REMOVING_LEASE_KEY)
          .limit(1),
      ).rows[0];
      if (removing) {
        throw new Error("worktree removal is in progress; retry attachment");
      }
      const prior = bindings.find((binding) => binding.sessionKey === sessionKey);
      const previousState: WorktreeSessionBindingState = prior
        ? prior.active
          ? "active"
          : "inactive"
        : initialSessionKey === sessionKey
          ? "active"
          : "absent";
      for (const key of [initialSessionKey, sessionKey]) {
        if (key) {
          executeSqliteQuerySync(
            db,
            queryFor(db)
              .insertInto("worktree_session_bindings")
              .values({ worktree_id: worktreeId, session_key: key, active: 1, attached_at: now })
              .onConflict((conflict) =>
                conflict.columns(["worktree_id", "session_key"]).doUpdateSet({ active: 1 }),
              ),
          );
        }
      }
      return previousState;
    },
    { env },
  );
}

export function deactivateRegistryWorktreeSession(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  sessionKey: string,
): number {
  const db = dbFor(env);
  ensureWorktreeSessionBindingsSchema(db);
  return runOpenClawStateWriteTransaction(
    () => {
      const record = worktreeOwner(db, worktreeId);
      if (!record) {
        return 0;
      }
      if (
        explicitWorktreeSessionBindings(db, worktreeId).length === 0 &&
        record.owner_kind === "session" &&
        record.owner_id
      ) {
        executeSqliteQuerySync(
          db,
          queryFor(db).insertInto("worktree_session_bindings").values({
            worktree_id: worktreeId,
            session_key: record.owner_id,
            active: 1,
            attached_at: Date.now(),
          }),
        );
      }
      executeSqliteQuerySync(
        db,
        queryFor(db)
          .updateTable("worktree_session_bindings")
          .set({ active: 0 })
          .where("worktree_id", "=", worktreeId)
          .where("session_key", "=", sessionKey),
      );
      return explicitWorktreeSessionBindings(db, worktreeId).filter((binding) => binding.active)
        .length;
    },
    { env },
  );
}

export function deleteRegistryWorktreeSessionBinding(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  sessionKey: string,
): void {
  const db = dbFor(env);
  if (!tableExists(db, "worktree_session_bindings")) {
    return;
  }
  runOpenClawStateWriteTransaction(
    () => {
      deleteBindingRows(db, worktreeId, sessionKey);
      if (explicitWorktreeSessionBindings(db, worktreeId).length === 0) {
        executeSqliteQuerySync(
          db,
          queryFor(db)
            .updateTable("worktrees")
            .set({ owner_id: null })
            .where("id", "=", worktreeId)
            .where("owner_kind", "=", "session"),
        );
      }
    },
    { env },
  );
}

export function insertInitialBindingRow(db: DatabaseSync, record: ManagedWorktreeRecord): void {
  if (record.ownerKind === "session" && record.ownerId) {
    executeSqliteQuerySync(
      db,
      queryFor(db).insertInto("worktree_session_bindings").values({
        worktree_id: record.id,
        session_key: record.ownerId,
        active: 1,
        attached_at: record.createdAt,
      }),
    );
  }
}

export function deleteBindingRows(db: DatabaseSync, worktreeId: string, sessionKey?: string): void {
  if (!tableExists(db, "worktree_session_bindings")) {
    return;
  }
  let query = queryFor(db)
    .deleteFrom("worktree_session_bindings")
    .where("worktree_id", "=", worktreeId);
  if (sessionKey) {
    query = query.where("session_key", "=", sessionKey);
  }
  executeSqliteQuerySync(db, query);
}

export function deactivateBindingRows(db: DatabaseSync, worktreeId: string): void {
  if (tableExists(db, "worktree_session_bindings")) {
    executeSqliteQuerySync(
      db,
      queryFor(db)
        .updateTable("worktree_session_bindings")
        .set({ active: 0 })
        .where("worktree_id", "=", worktreeId),
    );
  }
}
