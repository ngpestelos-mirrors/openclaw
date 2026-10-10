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
import type { ClawRemovalJournalWorkerInput } from "./removal-journal-contract.js";
import type { ClawAddPlan, ClawCronJob, ClawMcpServer } from "./types.js";

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

import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type * as provenanceKernel from "./provenance.kernel.js";
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
      arg0: Parameters<typeof provenanceKernel.persistClawInstallRecord>[0];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.persistClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.persistClawInstallRecord>;
  };
  "clawProvenance.updateInstall": {
    input: {
      arg0: Parameters<typeof provenanceKernel.updateClawInstallRecord>[0];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.updateClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.updateClawInstallRecord>;
  };
  "clawProvenance.installStatus": {
    input: {
      arg0: Parameters<typeof provenanceKernel.updateClawInstallRecordStatus>[0];
      arg1: Parameters<typeof provenanceKernel.updateClawInstallRecordStatus>[1];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.updateClawInstallRecordStatus>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.updateClawInstallRecordStatus>;
  };
  "clawProvenance.deleteInstall": {
    input: {
      arg0: Parameters<typeof provenanceKernel.deleteClawInstallRecord>[0];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.deleteClawInstallRecord>[1]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.deleteClawInstallRecord>;
  };
  "clawProvenance.persistPackage": {
    input: {
      arg0: Parameters<typeof provenanceKernel.persistClawPackageRef>[0];
      arg1: Parameters<typeof provenanceKernel.persistClawPackageRef>[1];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.persistClawPackageRef>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.persistClawPackageRef>;
  };
  "clawProvenance.updatePackageStatus": {
    input: {
      arg0: Parameters<typeof provenanceKernel.updateClawPackageRefStatus>[0];
      arg1: Parameters<typeof provenanceKernel.updateClawPackageRefStatus>[1];
      options: Omit<
        NonNullable<Parameters<typeof provenanceKernel.updateClawPackageRefStatus>[2]>,
        keyof OpenClawStateDatabaseOptions
      >;
      authority?: ClawProvenanceAuthority;
    };
    output: ReturnType<typeof provenanceKernel.updateClawPackageRefStatus>;
  };
};

export type ClawProvenanceReadOperations = {
  "clawProvenance.readCron": { input: { agentId: string }; output: PersistedClawCronRef[] };
  "clawProvenance.readMcp": { input: { agentId: string }; output: PersistedClawMcpServerRef[] };
  "clawProvenance.readMcpByName": { input: { name: string }; output: PersistedClawMcpServerRef[] };
};
