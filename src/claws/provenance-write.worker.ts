import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { assertAgentDeletionWorkerPredicate } from "../state/agent-deletion.worker.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
} from "../state/claw-package-lifecycle-lease-key.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  assertOpenClawStateLeaseWorkerOwnedInTransaction,
  assertOpenClawStateLeasesWorkerOwnedInTransaction,
} from "../state/openclaw-state-lease-worker.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import * as cronKernel from "./cron.kernel.js";
import { rowToRef, selectMcpRefs } from "./mcp-records.js";
import * as mcpKernel from "./mcp.kernel.js";
import { updateClawPackageRefStatusInDatabase } from "./package-status.kernel.js";
import { replaceClawPackageRefExpectedInDatabase } from "./package-update-provenance.kernel.js";
import { releaseAdoptedClawInstallRecordInDatabase } from "./provenance-adopted-release.kernel.js";
import {
  readClawInstallRecordFromDatabase,
  readClawOrphanWorkspaceInDatabase,
} from "./provenance-read.kernel.js";
import { runClawProvenanceWriteTransaction } from "./provenance-write-transaction.js";
import type { ClawProvenanceWriteOperations } from "./provenance-write.worker-contract.js";
import * as provenanceKernel from "./provenance.kernel.js";
import { mutateClawRemovalJournalInWorker } from "./removal-journal.worker.js";

export const clawProvenanceOperations = {
  "clawProvenance.releaseAdopted": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      releaseAdoptedClawInstallRecordInDatabase(
        database,
        input.agentId,
        input.expectedPlanIntegrity,
      ),
    ),
  "clawProvenance.cronPending": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      cronKernel.persistPendingRef(input.plan, input.job, { database, nowMs: input.nowMs }),
    ),
  "clawProvenance.cronUpdate": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      cronKernel.updateRef(input.ref, input.update, { database, nowMs: input.nowMs }),
    ),
  "clawProvenance.cronDelete": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      cronKernel.deleteClawCronRef(input.agentId, input.manifestId, { database }),
    ),
  "clawProvenance.cronRemoved": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      cronKernel.markClawCronRefRemoved(input.agentId, input.manifestId, {
        database,
        nowMs: input.nowMs,
      }),
    ),
  "clawProvenance.cronUpsert": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      cronKernel.upsertClawCronRef(input.ref, { database }),
    ),
  "clawProvenance.mcpPending": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      mcpKernel.persistPendingRef(input.plan, input.name, input.server, input.ownership, {
        database,
        nowMs: input.nowMs,
      }),
    ),
  "clawProvenance.mcpUpdate": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      mcpKernel.updateRef(input.ref, input.update, { database, nowMs: input.nowMs }),
    ),
  "clawProvenance.mcpDelete": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      mcpKernel.deleteClawMcpServerRef(input.agentId, input.name, { database }),
    ),
  "clawProvenance.mcpUpsert": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      mcpKernel.upsertClawMcpServerRef(input.ref, { database }),
    ),
  "clawProvenance.replacePackageRef": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      replaceClawPackageRefExpectedInDatabase(database.db, input.expected, input.replacement),
    ),
  "clawProvenance.readCron": (input, { stateOptions }) =>
    withExistingOpenClawStateDatabaseReadOnly(
      (database) => cronKernel.readClawCronRefsInDatabase(database.db, input.agentId, true),
      stateOptions(),
    ) ?? [],
  "clawProvenance.readMcp": (input, { stateOptions }) =>
    withExistingOpenClawStateDatabaseReadOnly(
      (database) => mcpKernel.readMcpRefsByIdentity(database.db, "agent_id", input.agentId, true),
      stateOptions(),
    ) ?? [],
  "clawProvenance.readMcpByName": (input, { stateOptions }) =>
    withExistingOpenClawStateDatabaseReadOnly(
      (database) => mcpKernel.readMcpRefsByIdentity(database.db, "name", input.name, true),
      stateOptions(),
    ) ?? [],

  "clawProvenance.persistInstall": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.persistClawInstallRecord(input.arg0, { ...input.options, database }),
    ),
  "clawProvenance.updateInstall": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.updateClawInstallRecord(input.arg0, { ...input.options, database }),
    ),
  "clawProvenance.installStatus": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.updateClawInstallRecordStatus(input.arg0, input.arg1, {
        ...input.options,
        database,
      }),
    ),
  "clawProvenance.deleteInstall": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.deleteClawInstallRecord(input.arg0, { ...input.options, database }),
    ),
  "clawProvenance.persistPackage": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.persistClawPackageRef(input.arg0, input.arg1, {
        ...input.options,
        database,
      }),
    ),
  "clawProvenance.updatePackageStatus": (input, context) =>
    runClawProvenanceWriteTransaction(context, input.authority, (database) =>
      provenanceKernel.updateClawPackageRefStatus(input.arg0, input.arg1, {
        ...input.options,
        database,
      }),
    ),

  "clawProvenance.removalJournal": (
    input: ClawProvenanceWriteOperations["clawProvenance.removalJournal"]["input"],
    { open, stateOptions },
  ) => mutateClawRemovalJournalInWorker(open(), input, stateOptions()),
  "clawProvenance.packageStatus": (
    input: ClawProvenanceWriteOperations["clawProvenance.packageStatus"]["input"],
    { open, stateOptions },
  ) =>
    runOpenClawStateWriteTransaction(
      (database) => {
        const { db } = database;
        const ref = input.ref;
        const artifact =
          ref.kind === "plugin"
            ? { kind: ref.kind, source: ref.source, ref: ref.ref }
            : {
                kind: ref.kind,
                source: ref.source,
                ref: ref.ref,
                workspace:
                  readClawInstallRecordFromDatabase(db, ref.agentId)?.workspace ??
                  readClawOrphanWorkspaceInDatabase(db, ref.agentId)?.workspace ??
                  "",
              };
        if (
          (artifact.kind === "skill" && !artifact.workspace) ||
          input.lease.scope !== CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE ||
          input.lease.key !== clawPackageLifecycleLeaseKey(artifact)
        ) {
          throw new Error("Claw package claim does not match the held artifact lease");
        }
        const assertLeases = (stage: "transaction" | "commit") => {
          if (input.deletion) {
            if (
              input.deletion.predicate.agentId !== ref.agentId ||
              input.deletion.lease.scope !== "core:agent-deletion" ||
              input.deletion.lease.key !== ref.agentId
            ) {
              throw new Error("Claw package write does not belong to its deletion");
            }
            assertOpenClawStateLeasesWorkerOwnedInTransaction(
              db,
              [input.deletion.lease, input.lease],
              stage,
            );
            assertAgentDeletionWorkerPredicate(database, input.deletion.predicate);
          } else {
            assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.lease, "write", stage);
          }
        };
        assertLeases("transaction");
        const row = executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("claw_package_refs")
            .select(["relationship", "origin", "independent_owner", "package_integrity"])
            .where("agent_id", "=", ref.agentId)
            .where("package_kind", "=", ref.kind)
            .where("package_source", "=", ref.source)
            .where("package_ref", "=", ref.ref)
            .where("package_version", "=", ref.version),
        );
        if (
          !row ||
          row.package_integrity !== ref.integrity ||
          row.relationship !== ref.relationship ||
          row.origin !== ref.origin ||
          Boolean(row.independent_owner) !== ref.independentOwner
        ) {
          throw new Error(
            `Package ${ref.ref}@${ref.version} ownership changed before its status write.`,
          );
        }
        const result = updateClawPackageRefStatusInDatabase(
          db,
          ref,
          input.status,
          input.nowMs ?? Date.now(),
        );
        assertLeases("commit");
        return result;
      },
      { database: open(), ...stateOptions() },
    ),
  "clawProvenance.reconcileMcp": (
    input: ClawProvenanceWriteOperations["clawProvenance.reconcileMcp"]["input"],
    context,
  ) =>
    context.writeAdmitted(({ db }) => {
      const refs = executeSqliteQuerySync(
        db,
        selectMcpRefs(db).where("agent_id", "=", input.agentId).orderBy("name"),
      ).rows.map(rowToRef);
      for (const ref of refs) {
        if (ref.status !== "pending" || input.digests[ref.name] !== ref.configDigest) {
          continue;
        }
        const updatedAtMs = input.nowMs ?? Date.now();
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("claw_mcp_server_refs")
            .set({ status: "complete", error: null, updated_at_ms: updatedAtMs })
            .where("agent_id", "=", ref.agentId)
            .where("name", "=", ref.name),
        );
        ref.status = "complete";
        ref.updatedAtMs = updatedAtMs;
        delete ref.error;
      }
      return refs;
    }),
} satisfies {
  [Key in keyof ClawProvenanceWriteOperations]: (
    input: ClawProvenanceWriteOperations[Key]["input"],
    context: WorkerWriteOperationContext,
  ) => ClawProvenanceWriteOperations[Key]["output"];
};
