import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  deleteClawWorkspaceFileInDatabase,
  insertClawWorkspaceFileInDatabase,
  readAllClawWorkspaceFilesInDatabase,
  readClawWorkspaceFileInDatabase,
  readClawWorkspaceFilesInDatabase,
  updateClawWorkspaceFileStatusInDatabase,
  upsertClawWorkspaceFileInDatabase,
} from "./workspace-records.js";
import type { ClawWorkspaceOperations } from "./workspace.worker-contract.js";

export const clawWorkspaceOperations = {
  "clawWorkspace.read": (
    input: ClawWorkspaceOperations["clawWorkspace.read"]["input"],
    { stateOptions },
  ) =>
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readClawWorkspaceFileInDatabase(db, input.agentId, input.path),
      stateOptions(),
    ),
  "clawWorkspace.list": (
    input: ClawWorkspaceOperations["clawWorkspace.list"]["input"],
    { stateOptions },
  ) =>
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        input.agentId === undefined
          ? readAllClawWorkspaceFilesInDatabase(db)
          : readClawWorkspaceFilesInDatabase(db, input.agentId),
      stateOptions(),
    ) ?? [],
  "clawWorkspace.insert": (
    input: ClawWorkspaceOperations["clawWorkspace.insert"]["input"],
    { writeAdmitted },
  ) => writeAdmitted(({ db }) => insertClawWorkspaceFileInDatabase(db, input.record)),
  "clawWorkspace.status": (
    input: ClawWorkspaceOperations["clawWorkspace.status"]["input"],
    { writeAdmitted },
  ) =>
    writeAdmitted(({ db }) =>
      updateClawWorkspaceFileStatusInDatabase(db, input.record, input.expectedStatuses),
    ),
  "clawWorkspace.upsert": (
    input: ClawWorkspaceOperations["clawWorkspace.upsert"]["input"],
    { writeAdmitted },
  ) => writeAdmitted(({ db }) => upsertClawWorkspaceFileInDatabase(db, input.record)),
  "clawWorkspace.delete": (
    input: ClawWorkspaceOperations["clawWorkspace.delete"]["input"],
    { writeAdmitted },
  ) => writeAdmitted(({ db }) => deleteClawWorkspaceFileInDatabase(db, input.agentId, input.path)),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
