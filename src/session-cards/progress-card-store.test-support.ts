import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { writeSessionProgressCard as writeInTransaction } from "./progress-card-store.js";

export function writeSessionProgressCard(...args: Parameters<typeof writeInTransaction>) {
  return runSqliteImmediateTransactionSync(args[0], () => writeInTransaction(...args));
}
