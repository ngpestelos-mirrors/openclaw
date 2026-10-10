import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import {
  readUserGitHubConnectionInDatabase,
  writeUserGitHubConnectionInDatabase,
  type UserGitHubConnection,
} from "./user-github-connections.kernel.js";

/** Native fixture mutation for final-guard and recovery boundary tests. */
export function updateUserGitHubConnection(
  owner: string,
  update: (current: UserGitHubConnection | undefined) => UserGitHubConnection,
  assertCurrent: () => void,
  database?: OpenClawStateDatabaseOptions,
): UserGitHubConnection {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readUserGitHubConnectionInDatabase(db, owner);
      const next = update(current);
      assertCurrent();
      return writeUserGitHubConnectionInDatabase(db, owner, next, current);
    },
    database,
    { operationLabel: "users.github.fixture" },
  );
}
