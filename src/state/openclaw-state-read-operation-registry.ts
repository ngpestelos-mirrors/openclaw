import type { DatabaseSync } from "node:sqlite";
import type { ClawMonitorCleanupReadOperations } from "../claws/monitor-cleanup.read.types.js";
import type { ProactiveJobReceiptReadOperations } from "../cron/proactive-job-receipt.types.js";
import type { RestartSentinelReadOperations } from "../infra/restart-sentinel.read.worker-contract.js";
import type { DiagnosticReadOperations } from "../infra/sqlite-audit-record.read-contract.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { SessionStateReadOperations } from "../sessions/session-state-events.read.worker-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

type Operations = DiagnosticReadOperations &
  ClawMonitorCleanupReadOperations &
  RestartSentinelReadOperations &
  ProactiveJobReceiptReadOperations &
  SessionStateReadOperations;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>({
  sessionState: () =>
    import("../sessions/session-state-events.read.worker.js").then(
      (m) => m.sessionStateReadOperations,
    ),
  clawMonitorCleanup: () =>
    import("../claws/monitor-cleanup.read.worker.js").then(
      (m) => m.clawMonitorCleanupReadOperations,
    ),
  automationProactive: () =>
    import("../cron/proactive-job-receipt.read.worker.js").then(
      (m) => m.proactiveJobReceiptReadOperations,
    ),
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
});
