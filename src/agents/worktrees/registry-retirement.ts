import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { deactivateBindingRows } from "./registry-session-bindings.js";

type RetirementDatabase = Pick<DB, "worktrees">;

/** Mark a vanished checkout removed and release every active session membership atomically. */
export function retireRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  removedAt: number,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<RetirementDatabase>(db)
          .updateTable("worktrees")
          .set({ removed_at: removedAt })
          .where("id", "=", id),
      );
      deactivateBindingRows(db, id);
    },
    { env },
  );
}
