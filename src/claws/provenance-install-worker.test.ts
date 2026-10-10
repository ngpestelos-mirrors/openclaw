import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as worker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { readCachedClawInstallSchemaVersions } from "./provenance-runtime-read.js";
import {
  persistClawInstallRecord,
  readClawInstallRecordAsync,
  updateClawInstallRecord,
  deleteClawInstallRecord,
} from "./provenance.js";
import { addPlan } from "./update-apply.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
afterEach(() => vi.restoreAllMocks());
let sequence = 0;
function fixture() {
  const root = dirs.make("claw-install-worker-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  openOpenClawStateDatabase(options);
  const id = `worker-${++sequence}`;
  const plan = {
    ...addPlan,
    agent: { ...addPlan.agent, finalId: id, config: { ...addPlan.agent.config, id } },
  };
  return { options, plan };
}

describe("Claw install worker ownership", () => {
  it("publishes committed create, update, and deletion facts even when the ordinary result is lost", async () => {
    const { options, plan } = fixture();
    const error = new Error("ordinary result lost");
    probe.command(worker, async (command, args, scope) => {
      const result = await scope.execute(command, args);
      if (
        command.type === "clawProvenance.persistInstall" ||
        command.type === "clawProvenance.updateInstall" ||
        command.type === "clawProvenance.deleteInstall"
      ) {
        throw error;
      }
      return result;
    });
    const sql = observeMainThreadSql();
    sql.calibrate();
    try {
      await expect(persistClawInstallRecord(plan, options)).rejects.toThrow("ordinary result lost");
      const first = await readClawInstallRecordAsync(plan.agent.finalId, options);
      expect(first).toBeDefined();
      expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
        kind: "ready",
        schemaVersions: new Map([
          [
            plan.agent.finalId,
            {
              kind: "ok",
              schemaVersion: first!.schemaVersion,
              agentConfigDigest: first!.agentConfigDigest,
            },
          ],
        ]),
      });
      const updated = {
        ...plan,
        agent: { ...plan.agent, config: { ...plan.agent.config, name: "Changed" } },
      };
      await expect(updateClawInstallRecord(updated, options)).rejects.toThrow(
        "ordinary result lost",
      );
      const next = await readClawInstallRecordAsync(plan.agent.finalId, options);
      expect(next?.agentConfigDigest).not.toBe(first?.agentConfigDigest);
      expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
        kind: "ready",
        schemaVersions: new Map([
          [
            plan.agent.finalId,
            {
              kind: "ok",
              schemaVersion: next!.schemaVersion,
              agentConfigDigest: next!.agentConfigDigest,
            },
          ],
        ]),
      });
      await expect(deleteClawInstallRecord(plan.agent.finalId, options)).rejects.toThrow(
        "ordinary result lost",
      );
      expect(await readClawInstallRecordAsync(plan.agent.finalId, options)).toBeUndefined();
      expect(readCachedClawInstallSchemaVersions(options)).toMatchObject({
        kind: "ready",
        schemaVersions: new Map(),
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back creation when its routed owner retires at %s",
    async (stage) => {
      const { options, plan } = fixture();
      let retired = false;
      probe.admission(workerAdmission, (request, grant, admit) => {
        retired ||= request.stage === stage;
        admit(request, grant);
      });
      await expect(
        persistClawInstallRecord(plan, {
          ...options,
          assertCurrent: () => {
            if (retired) {
              throw new Error("owner retired");
            }
          },
        }),
      ).rejects.toThrow("owner retired");
      expect(retired).toBe(true);
      expect(await readClawInstallRecordAsync(plan.agent.finalId, options)).toBeUndefined();
    },
  );
});
