import type { PersistedClawWorkspaceFile } from "./workspace-records.js";

export type ClawWorkspaceOperations = {
  "clawWorkspace.read": {
    input: { agentId: string; path: string };
    output: PersistedClawWorkspaceFile | undefined;
  };
  "clawWorkspace.list": {
    input: { agentId?: string };
    output: PersistedClawWorkspaceFile[];
  };
  "clawWorkspace.insert": {
    input: { record: PersistedClawWorkspaceFile };
    output: void;
  };
  "clawWorkspace.status": {
    input: {
      record: PersistedClawWorkspaceFile;
      expectedStatuses: PersistedClawWorkspaceFile["status"][];
    };
    output: void;
  };
  "clawWorkspace.upsert": {
    input: { record: PersistedClawWorkspaceFile };
    output: void;
  };
  "clawWorkspace.delete": {
    input: { agentId: string; path: string };
    output: void;
  };
};
