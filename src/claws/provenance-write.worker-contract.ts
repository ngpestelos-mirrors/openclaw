import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { PersistedClawCronRef } from "./cron-records.js";
import type * as cronKernel from "./cron.kernel.js";
import type { PersistedClawMcpServerRef } from "./mcp-records.js";
import type * as mcpKernel from "./mcp.kernel.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";
import type {
  ClawInstallRecordStatusOptions,
  ClawInstallRecordUpdateOptions,
  ClawInstallRecordWriteOptions,
  ClawPackageRefWriteOptions,
} from "./provenance-write.types.js";
import type { ClawRemovalJournalWorkerInput } from "./removal-journal-contract.js";
import type { ClawAddPlan, ClawCronJob, ClawMcpServer, ResolvedClawPackage } from "./types.js";

export type ClawProvenanceWriteOperations = ClawProvenanceMutationOperations &
  ClawProvenanceReadOperations & {
    "clawProvenance.removalJournal": {
      input: ClawRemovalJournalWorkerInput;
      output: { nonce: string };
    };
    "clawProvenance.packageStatus": {
      input: {
        ref: PersistedClawPackageRef;
        status: ClawPackageRefStatus;
        nowMs?: number;
        lease: OpenClawStateLeaseIdentity;
        deletion?: AgentDeletionWorkerGuard;
      };
      output: PersistedClawPackageRef;
    };
    "clawProvenance.reconcileMcp": {
      input: { agentId: string; digests: Record<string, string>; nowMs?: number };
      output: PersistedClawMcpServerRef[];
    };
  };

export type ClawProvenanceAuthority = {
  lease?: OpenClawStateLeaseIdentity;
  deletion?: AgentDeletionWorkerGuard;
};
export type ClawProvenanceMutationOperations = {
  "clawProvenance.releaseAdopted": {
    input: { agentId: string; expectedPlanIntegrity: string; authority?: ClawProvenanceAuthority };
    output: void;
  };
  "clawProvenance.cronPending": {
    input: {
      plan: ClawAddPlan;
      job: ClawCronJob;
      nowMs?: number;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawCronRef;
  };
  "clawProvenance.cronUpdate": {
    input: {
      ref: PersistedClawCronRef;
      update: Parameters<typeof cronKernel.updateRef>[1];
      nowMs?: number;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawCronRef;
  };
  "clawProvenance.cronDelete": {
    input: { agentId: string; manifestId: string; authority?: ClawProvenanceAuthority };
    output: void;
  };
  "clawProvenance.cronRemoved": {
    input: {
      agentId: string;
      manifestId: string;
      nowMs?: number;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawCronRef | undefined;
  };
  "clawProvenance.cronUpsert": {
    input: { ref: PersistedClawCronRef; authority?: ClawProvenanceAuthority };
    output: void;
  };
  "clawProvenance.mcpPending": {
    input: {
      plan: ClawAddPlan;
      name: string;
      server: ClawMcpServer;
      ownership: Parameters<typeof mcpKernel.persistPendingRef>[3];
      nowMs?: number;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawMcpServerRef;
  };
  "clawProvenance.mcpUpdate": {
    input: {
      ref: PersistedClawMcpServerRef;
      update: Parameters<typeof mcpKernel.updateRef>[1];
      nowMs?: number;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawMcpServerRef;
  };
  "clawProvenance.mcpDelete": {
    input: { agentId: string; name: string; authority?: ClawProvenanceAuthority };
    output: void;
  };
  "clawProvenance.mcpUpsert": {
    input: { ref: PersistedClawMcpServerRef; authority?: ClawProvenanceAuthority };
    output: void;
  };
  "clawProvenance.replacePackageRef": {
    input: {
      expected?: PersistedClawPackageRef;
      replacement?: PersistedClawPackageRef;
      authority?: ClawProvenanceAuthority;
    };
    output: void;
  };

  "clawProvenance.persistInstall": {
    input: {
      arg0: ClawAddPlan;
      options: ClawInstallRecordWriteOptions;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawInstall;
  };
  "clawProvenance.updateInstall": {
    input: {
      arg0: ClawAddPlan;
      options: ClawInstallRecordUpdateOptions;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawInstall;
  };
  "clawProvenance.installStatus": {
    input: {
      arg0: string;
      arg1: ClawInstallStatus;
      options: ClawInstallRecordStatusOptions;
      authority?: ClawProvenanceAuthority;
    };
    output: void;
  };
  "clawProvenance.deleteInstall": {
    input: {
      arg0: string;
      options: Pick<ClawInstallRecordStatusOptions, "expectedStatuses">;
      authority?: ClawProvenanceAuthority;
    };
    output: void;
  };
  "clawProvenance.persistPackage": {
    input: {
      arg0: ClawAddPlan;
      arg1: ResolvedClawPackage;
      options: ClawPackageRefWriteOptions;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawPackageRef;
  };
  "clawProvenance.updatePackageStatus": {
    input: {
      arg0: PersistedClawPackageRef;
      arg1: ClawPackageRefStatus;
      options: Pick<ClawPackageRefWriteOptions, "nowMs">;
      authority?: ClawProvenanceAuthority;
    };
    output: PersistedClawPackageRef;
  };
};

export type ClawProvenanceReadOperations = {
  "clawProvenance.readCron": { input: { agentId: string }; output: PersistedClawCronRef[] };
  "clawProvenance.readMcp": { input: { agentId: string }; output: PersistedClawMcpServerRef[] };
  "clawProvenance.readMcpByName": { input: { name: string }; output: PersistedClawMcpServerRef[] };
};
