import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import { describe, expect, it } from "vitest";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { digestClawValue } from "../claws/digest.js";
import { buildClawRemovalFixture } from "../claws/lifecycle-remove.test-support.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import { persistClawInstallRecord, readClawInstallRecordAsync } from "../claws/provenance.js";
import {
  clawRemovalJournalRequestSchema,
  clawRemovalJournalResultSchema,
} from "../claws/removal-journal-contract.js";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clawsRemovalJournalHandlers } from "./server-methods/claws-removal-journal.js";

describe("Gateway-owned Claw removal journal", () => {
  it.each([
    "acknowledged",
    "lost-reply",
    "stale-install",
    "revoked-request",
    "shared-session-owner",
  ] as const)("preserves journal and lease custody for %s", async (scenario) => {
    await withOpenClawTestState({ label: `claw-journal-${scenario}` }, async (state) => {
      const { plan } = await buildClawRemovalFixture(state.root);
      const sharedStorePath = state.statePath("shared.sqlite");
      await state.writeConfig({
        agents: {
          ownership: "explicit",
          entries: {
            worker: { workspace: plan.agent.workspace },
            ...(scenario === "shared-session-owner" ? { survivor: {} } : {}),
          },
        },
        ...(scenario === "shared-session-owner" ? { session: { store: sharedStorePath } } : {}),
      });
      resetConfigRuntimeState();
      const install = await persistClawInstallRecord(plan);
      if (scenario === "shared-session-owner") {
        openOpenClawAgentDatabase({ agentId: "worker", path: sharedStorePath, env: state.env });
      }
      const config = getRuntimeConfig();
      const cronStorePath = resolveCronJobsStorePathFromConfig(config);
      const phases: string[] = [];
      let committedOperation: string | undefined;
      const journalTransport: AgentDeletionJournalTransport = async (mutation, authority) => {
        phases.push(mutation.kind);
        authority.assertCurrent();
        const request = clawRemovalJournalRequestSchema.parse({
          phase: mutation.kind,
          agentId: mutation.kind === "begin" ? mutation.entry.agentId : mutation.journal.agentId,
          operationId:
            mutation.kind === "begin" ? mutation.operationId : mutation.journal.operationId,
          binding: resolveClawMonitorCleanupBinding(cronStorePath),
          lease: authority.identity,
          sourceIdentity: authority.sourceIdentity,
          expectedInstallDigest: digestClawValue(scenario === "stale-install" ? null : install),
          expectedJournalDigest: digestClawValue(
            mutation.kind === "begin" ? mutation.expectedJournal : mutation.journal,
          ),
          configDigest: digestClawValue(config),
        });
        let response: unknown;
        let failure: ErrorShape | undefined;
        await clawsRemovalJournalHandlers["claws.removalJournal"]({
          params: request,
          context: {
            cronStorePath,
            getRuntimeConfig: () => config,
            isConfigReloadSettled: () => true,
          },
          signal: authority.signal,
          hasCurrentClientAuthority: () => scenario !== "revoked-request",
          respond: (accepted, payload, error) => {
            response = payload;
            failure = accepted ? undefined : error;
          },
        });
        if (failure) {
          const error = new Error(failure.message);
          if (isRecord(failure.details) && failure.details.outcomeUnknown === false) {
            return err(error);
          }
          throw error;
        }
        if (scenario === "lost-reply") {
          committedOperation = readAgentDeletionJournal("worker")?.operationId;
          expect(committedOperation).toBeTruthy();
          throw new Error("Synthetic connection lost after the native journal commit");
        }
        const result = clawRemovalJournalResultSchema.parse(response);
        if (!result.ok) {
          return err(new Error(result.error));
        }
        if (mutation.kind === "begin") {
          expect(result.journal).toMatchObject({
            agentId: request.agentId,
            operationId: request.operationId,
            cleanupCompleted: false,
          });
        } else {
          expect(result.journal).toBeNull();
        }
        return ok(result.journal);
      };
      const removal = withAgentDeletion(
        "worker",
        async (begin) => {
          const deletion = await begin({
            agentId: "worker",
            agentDir: state.agentDir("worker"),
            workspaceDir: plan.agent.workspace,
            sessionsDir: state.sessionsDir("worker"),
            deleteFiles: false,
          });
          expect(readAgentDeletionJournal("worker")).toMatchObject({
            operationId: deletion.entry.operationId,
            workspaceDir: plan.agent.workspace,
            cleanupCompleted: false,
          });
          await deletion.assertCurrentAsync();
          deletion.assertCurrentFinal();
          await deletion.rollback();
        },
        { journalTransport },
      );
      if (scenario === "acknowledged") {
        await removal;
        expect(phases).toEqual(["begin", "rollback"]);
      } else {
        const failures = {
          "stale-install": /changed before mutation/,
          "revoked-request": /request authority/,
          "lost-reply": /unknown/,
          "shared-session-owner":
            /Agent "worker" owns the session database still used by agent "survivor"/,
        };
        await expect(removal).rejects.toThrow(failures[scenario]);
        expect(phases).toEqual(["begin"]);
      }
      const journal = readAgentDeletionJournal("worker");
      const lease = readOpenClawStateLease(openOpenClawStateDatabase().db, {
        scope: "core:agent-deletion",
        key: "worker",
      });
      if (scenario === "lost-reply") {
        expect(journal).toMatchObject({
          operationId: committedOperation,
          cleanupCompleted: false,
        });
        expect(lease).toBeDefined();
      } else {
        expect(journal).toBeUndefined();
        expect(lease).toBeUndefined();
      }
      if (scenario === "shared-session-owner") {
        expect(await readClawInstallRecordAsync("worker")).toEqual(install);
        expect(
          openOpenClawAgentDatabase({ agentId: "worker", path: sharedStorePath, env: state.env })
            .agentId,
        ).toBe("worker");
      }
    });
  });
});
