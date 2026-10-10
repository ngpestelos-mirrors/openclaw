import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { createClawUpdatePlanFixture } from "./resource-update.test-helpers.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import type { ClawUpdateAction } from "./update-plan-types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { applyClawWorkspaceUpdate } from "./workspace-update.js";
import { readClawWorkspaceFilesAsync } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

describe("applyClawWorkspaceUpdate", () => {
  it.each(["apply", "rollback"] as const)(
    "stops mutation and preserves the unknown worker outcome during %s",
    async (phase) => {
      const root = tempDirs.make("openclaw-claw-workspace-uncertain-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const paths = ["first.md", "second.md", "third.md"];
      for (const path of paths) {
        await writeFile(join(root, path), `new ${path}\n`);
      }
      const parsed = parseClawManifest({
        schemaVersion: 1,
        agent: { id: "worker" },
        workspace: { files: paths.map((path) => ({ path, source: path })) },
      });
      if (!parsed.ok) {
        throw new Error("fixture manifest invalid");
      }
      const target = await buildClawAddPlan({
        manifest: parsed.manifest,
        source: {
          kind: "package",
          name: "@acme/worker",
          version: "2.0.0",
          packageRoot: root,
          manifestPath: join(root, "openclaw.claw.json"),
          integrityKind: "artifact",
          integrity: "sha256:target",
          byteLength: 1,
        },
        context: { workspace },
      });
      const update = createClawUpdatePlanFixture(
        target.actions
          .filter((action) => action.kind === "workspaceFile")
          .map((action): ClawUpdateAction => ({
            kind: "workspaceFile",
            id: action.id,
            action: "add",
            target: action.target,
            blocked: false,
            reason: "new file",
            currentPresent: false,
            desiredDigest: action.digest,
          })),
      );
      if (phase === "rollback") {
        await writeFile(join(root, "third.md"), "changed after planning");
      }
      const unknown = new SqliteWorkerError(
        "Workspace write outcome is unknown",
        "outcome-unknown",
      );
      let uncertaintyReported = false;
      const mutationsAfterUncertainty: string[] = [];
      probe.command(workerStore, async (command, args, scope) => {
        if (uncertaintyReported && command.type !== "clawWorkspace.list") {
          mutationsAfterUncertainty.push(command.type);
        }
        const result = await scope.execute(command, args);
        if (
          !uncertaintyReported &&
          command.type === (phase === "apply" ? "clawWorkspace.upsert" : "clawWorkspace.delete")
        ) {
          uncertaintyReported = true;
          throw unknown;
        }
        return result;
      });
      const options = { env: { OPENCLAW_STATE_DIR: join(root, "state") } };

      await expect(applyClawWorkspaceUpdate(update, target, options)).rejects.toBe(unknown);
      expect(mutationsAfterUncertainty).toEqual([]);
      await expect(readFile(join(workspace, "first.md"), "utf8")).resolves.toBe("new first.md\n");
      await expect(access(join(workspace, "second.md"))).rejects.toThrow();
      await expect(access(join(workspace, "third.md"))).rejects.toThrow();
      expect(await readClawWorkspaceFilesAsync("worker", options)).toEqual([
        expect.objectContaining({ path: "first.md", status: "complete" }),
      ]);
    },
  );

  it.each([false, true])(
    "restores add/change/remove files and provenance after request cancellation: %s",
    async (cancelled) => {
      const root = tempDirs.make("openclaw-claw-workspace-update-");
      const currentRoot = join(root, "current");
      const targetRoot = join(root, "target");
      await mkdir(currentRoot);
      await mkdir(targetRoot);
      await writeFile(join(currentRoot, "SOUL.md"), "current soul\n", "utf8");
      await writeFile(join(currentRoot, "OLD.md"), "old\n", "utf8");
      const targetSoul = Buffer.from("target soul\n");
      await writeFile(
        join(targetRoot, "CLAW.md"),
        Buffer.concat([
          Buffer.from("---\nschemaVersion: 1\nagent: { id: worker }\n---\n"),
          targetSoul,
        ]),
      );
      await writeFile(join(targetRoot, "NEW.md"), "new\n", "utf8");

      const currentParsed = parseClawManifest({
        schemaVersion: 1,
        agent: { id: "worker" },
        workspace: {
          bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } },
          files: [{ source: "OLD.md", path: "OLD.md" }],
        },
      });
      const targetParsed = parseClawManifest({
        schemaVersion: 1,
        agent: { id: "worker" },
        workspace: {
          files: [{ source: "NEW.md", path: "NEW.md" }],
        },
      });
      if (!currentParsed.ok || !targetParsed.ok) {
        throw new Error("fixture manifest invalid");
      }
      const currentSource: ClawSourceIdentity = {
        kind: "package",
        name: "@acme/worker",
        version: "1.0.0",
        packageRoot: currentRoot,
        manifestPath: join(currentRoot, "openclaw.claw.json"),
        integrityKind: "artifact",
        integrity: "sha256:current",
        byteLength: 1,
      };
      const targetSource: ClawSourceIdentity = {
        ...currentSource,
        version: "2.0.0",
        packageRoot: targetRoot,
        manifestPath: join(targetRoot, "CLAW.md"),
        integrity: "sha256:target",
      };
      const workspace = join(root, "workspace");
      const env = { OPENCLAW_STATE_DIR: join(root, "state") };
      const currentAddPlan = await buildClawAddPlan({
        manifest: currentParsed.manifest,
        source: currentSource,
        context: { workspace },
      });
      let config: OpenClawConfig = {};
      const added = await applyClawAddPlan(currentAddPlan, {
        env,
        nowMs: 10,
        consentPlanIntegrity: currentAddPlan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      expect(added).toMatchObject({ status: "complete" });
      const originalFiles = await readClawWorkspaceFilesAsync("worker", { env });
      const updatePlan = await buildClawUpdatePlan({
        agentId: "worker",
        targetManifest: targetParsed.manifest,
        targetClawMarkdownBody: targetSoul,
        targetSource,
        config,
        sourceMcpServers: {},
        stateOptions: { env },
      });
      const targetAddPlan = await buildClawAddPlan({
        manifest: targetParsed.manifest,
        clawMarkdownBody: targetSoul,
        source: targetSource,
        context: { agentId: "worker", workspace },
      });
      expect(JSON.stringify(updatePlan)).not.toContain("target soul");

      const sql = observeMainThreadSql();
      sql.calibrate();
      try {
        const request = new AbortController();
        const options = {
          env,
          nowMs: 20,
          signal: request.signal,
          assertCurrent: () => request.signal.throwIfAborted(),
          assertSettlementCurrent: () => undefined,
          runSettlement: <T>(run: () => Promise<T>) => run(),
        };
        const execution = await applyClawWorkspaceUpdate(updatePlan, targetAddPlan, options);

        await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("target soul\n");
        await expect(readFile(join(workspace, "NEW.md"), "utf8")).resolves.toBe("new\n");
        await expect(access(join(workspace, "OLD.md"))).rejects.toThrow();
        expect(await readClawWorkspaceFilesAsync("worker", { env })).toEqual([
          expect.objectContaining({ path: "NEW.md", sourcePath: "NEW.md" }),
          expect.objectContaining({ path: "SOUL.md", sourcePath: "CLAW.md" }),
        ]);

        if (cancelled) {
          request.abort(new Error("Claw request cancelled"));
        }
        await execution.rollback();

        await expect(readFile(join(workspace, "SOUL.md"), "utf8")).resolves.toBe("current soul\n");
        await expect(readFile(join(workspace, "OLD.md"), "utf8")).resolves.toBe("old\n");
        await expect(access(join(workspace, "NEW.md"))).rejects.toThrow();
        expect(await readClawWorkspaceFilesAsync("worker", { env })).toEqual(originalFiles);

        sql.expectIdle();
      } finally {
        sql.restore();
      }

      await rm(join(workspace, "OLD.md"));
      await expect(
        applyClawWorkspaceUpdate(updatePlan, targetAddPlan, { env, nowMs: 30 }),
      ).rejects.toThrow("disappeared after planning");
    },
  );
});
