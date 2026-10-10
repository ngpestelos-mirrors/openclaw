import type {
  ClawPackageOrigin,
  ClawPackageRefStatus,
  ClawPackageRelationship,
} from "./package-extension-provenance.js";
import type { ClawAgentOrigin } from "./provenance-agent-origin.js";
import type { ClawInstallStatus, PersistedClawInstall } from "./provenance-types.js";
import type { ClawAddPlan } from "./types.js";

export type ClawInstallRecordWriteOptions = {
  status?: ClawInstallStatus;
  nowMs?: number;
  expectedExistingRecord?: PersistedClawInstall;
  expectedExistingPlan?: ClawAddPlan;
  deferLegacyPlanUpgrade?: boolean;
  agentOrigin?: ClawAgentOrigin;
};

export type ClawInstallRecordUpdateOptions = {
  nowMs?: number;
  expectedClaw?: { version: string; integrity: string };
  status?: ClawInstallStatus;
  agentConfigDigest?: string;
};

export type ClawInstallRecordStatusOptions = {
  nowMs?: number;
  expectedStatuses?: ClawInstallStatus[];
};

export type ClawPackageRefWriteOptions = {
  nowMs?: number;
  status?: ClawPackageRefStatus;
  relationship?: ClawPackageRelationship;
  origin?: ClawPackageOrigin;
  independentOwner?: boolean;
};
