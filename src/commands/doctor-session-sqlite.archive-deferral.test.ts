import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import * as retainedSources from "../infra/deferred-plugin-session-sources.js";
import * as archiveDeferral from "../infra/session-sqlite-migration-archive-deferral.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import * as sqliteReaders from "../infra/session-sqlite-migration-readers.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

beforeEach(() => {
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "off");
});
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedSource(state: OpenClawTestState, shared = false) {
  const fixture = seedDeferredPluginSessionSource(state, shared ? "legacy-root" : "default");
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [],
    resolvedPluginIds: ["fixture-plugin"],
  });
  if (shared) {
    fixture.cfg.session = { store: fixture.storePath };
    fixture.scope.storePath = fixture.storePath;
    fixture.cfg.agents = { ownership: "explicit", entries: { main: { default: true }, work: {} } };
    const records = JSON.parse(fs.readFileSync(fixture.storePath, "utf8"));
    records["agent:work:shared"] = records["agent:main:kept"];
    fs.writeFileSync(fixture.storePath, JSON.stringify(records));
    fixture.originals.set(fixture.storePath, fs.readFileSync(fixture.storePath));
  }
  return fixture;
}

function linkError(
  source: fs.PathLike,
  destination: fs.PathLike,
  code = "EACCES",
  syscall = "link",
) {
  return Object.assign(new Error("injected " + code + ": " + syscall), {
    code,
    syscall,
    path: source,
    dest: destination,
  });
}

function denyArchiveLinks(code = "EACCES", syscall = "link") {
  const link = fsPromises.link;
  return vi.spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
    if (String(destination).includes("session-sqlite-import-archive")) {
      throw linkError(source, destination, code, syscall);
    }
    return link(source, destination);
  });
}

function expectNoArchivePlans(env: NodeJS.ProcessEnv) {
  for (const file of migrationRun.listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = migrationRun.readSessionSqliteMigrationManifest(file)!;
    for (const target of manifest.targets) {
      expect(target.plannedMoves).toEqual([]);
      expect(target.completedMoves).toEqual([]);
    }
  }
}

describe("session archive hard-link refusal", () => {
  it.each(["EACCES", "EPERM"])(
    "retains exact originals on %s, admits SQLite, and never replays or repeats the notice",
    async (code) => {
      await withOpenClawTestState({ label: "session-archive-link-denial" }, async (state) => {
        const { cfg, storePath, originals, scope } = seedSource(state);
        const identities = new Map(
          [...originals.keys()].map((file) => [file, fs.statSync(file).ino]),
        );
        const denied = denyArchiveLinks(code);
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const imported = await run();
        expect(denied).toHaveBeenCalledTimes(1);
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({
            code: "plugin_migration_source_retained",
            message: expect.stringContaining("filesystem refused archive hard links"),
          }),
        ]);
        const target = imported.targets.find((item) => item.storePath === storePath)!;
        const receipt = readDeferredPluginSessionImport({
          cfg,
          env: state.env,
          target,
          sqlitePath: target.sqlitePath,
        });
        expect(receipt?.pluginIds).toEqual([]);
        expect(() =>
          assertSessionStoreMigrationComplete({ cfg, env: state.env, operation: "doctor" }),
        ).not.toThrow();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.sessionId,
        ).toBe("legacy-kept");
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
          expect(fs.statSync(file)).toMatchObject({ ino: identities.get(file), nlink: 1 });
        }
        expectNoArchivePlans(state.env);
        expect(inspectSessionSqliteRecovery({ cfg, env: state.env }).artifacts).toEqual([]);
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "SQLite edit survives" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        const retried = await run();
        expect(retried.totals.importedEntries).toBe(0);
        expect(retried.totals.importedTranscriptEvents).toBe(0);
        expect(retried.targets.flatMap((item) => item.issues)).toEqual([]);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("SQLite edit survives");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        const inspected = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "inspect",
        });
        expect(inspected.targets.flatMap((item) => item.issues)).toEqual([]);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expectNoArchivePlans(state.env);
        denied.mockRestore();
        const archived = await run();
        expect(archived.totals.importedEntries).toBe(0);
        expect(archived.targets.flatMap((item) => item.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        closeOpenClawAgentDatabasesForTest();
        const cleanup = await retireSessionSqliteRecovery({
          env: state.env,
          preview: inspectSessionSqliteRecovery({ cfg, env: state.env }),
          readConfig: async () => cfg,
          confirm: async () => true,
        });
        expect(cleanup.status).toBe("complete");
      });
    },
  );

  it("does not publish only one owner of a shared retained import", async () => {
    await withOpenClawTestState(
      { label: "session-link-deferral-receipt-atomicity" },
      async (state) => {
        const { cfg, storePath, originals } = seedSource(state, true);
        denyArchiveLinks();
        const record = retainedSources.recordDeferredPluginSessionImport;
        let calls = 0;
        vi.spyOn(retainedSources, "recordDeferredPluginSessionImport").mockImplementation(
          (params) => {
            if (++calls === 2) {
              throw new Error("interrupted between shared-owner receipts");
            }
            return record(params);
          },
        );
        await expect(
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" }),
        ).rejects.toThrow("interrupted between shared-owner receipts");
        for (const agentId of ["main", "work"]) {
          const target = { agentId, storePath };
          expect(
            readDeferredPluginSessionImport({
              cfg,
              env: state.env,
              target,
              sqlitePath: sqliteReaders.resolveTargetSqlitePath(target, state.env),
            }),
          ).toBeUndefined();
        }
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
      },
    );
  });

  it("records the real plugin obligation arriving at the denied link without clearing it", async () => {
    await withOpenClawTestState({ label: "session-link-denial-live-plugin" }, async (state) => {
      const { cfg, storePath } = seedSource(state);
      const link = fsPromises.link;
      vi.spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
        if (!String(destination).includes("session-sqlite-import-archive")) {
          return link(source, destination);
        }
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [
            {
              pluginId: "late-plugin",
              reason: "New migration work",
              command: "openclaw doctor --fix",
            },
          ],
        });
        throw linkError(source, destination);
      });
      const report = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      const target = report.targets.find((item) => item.storePath === storePath)!;
      expect(
        readDeferredPluginSessionImport({
          cfg,
          env: state.env,
          target,
          sqlitePath: target.sqlitePath,
        })?.pluginIds,
      ).toEqual(["late-plugin"]);
      expect(
        readDeferredPluginMigrations({ env: state.env }).map((plugin) => plugin.pluginId),
      ).toEqual(["late-plugin"]);
      expectNoArchivePlans(state.env);
      const retried = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(retried.totals.importedEntries).toBe(0);
      expect(
        retried.targets
          .flatMap((item) => item.issues)
          .some((issue) => issue.message.includes("filesystem refused archive hard links")),
      ).toBe(false);
    });
  });

  it("does not certify a database replaced after import validation", async () => {
    await withOpenClawTestState(
      { label: "session-link-denial-database-custody" },
      async (state) => {
        const { cfg, storePath } = seedSource(state);
        const target = { agentId: "main", storePath };
        const sqlitePath = sqliteReaders.resolveTargetSqlitePath(target, state.env);
        const link = fsPromises.link;
        vi.spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
          if (!String(destination).includes("session-sqlite-import-archive")) {
            return link(source, destination);
          }
          closeOpenClawAgentDatabasesForTest();
          fs.renameSync(sqlitePath, sqlitePath + ".original");
          fs.copyFileSync(sqlitePath + ".original", sqlitePath);
          throw linkError(source, destination);
        });
        await expect(
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" }),
        ).rejects.toThrow("database changed before archive deferral");
        expect(
          readDeferredPluginSessionImport({ cfg, env: state.env, target, sqlitePath }),
        ).toBeUndefined();
        expect(fs.existsSync(storePath)).toBe(true);
      },
    );
  });

  it("defers an index-only import before its first publication", async () => {
    await withOpenClawTestState({ label: "session-index-link-denial" }, async (state) => {
      const { cfg, storePath } = seedSource(state);
      fs.writeFileSync(
        storePath,
        JSON.stringify({ "agent:main:metadata": { sessionId: "metadata", updatedAt: 20 } }),
      );
      for (const name of ["legacy-kept.jsonl", "legacy-deleted.jsonl"]) {
        fs.unlinkSync(path.join(path.dirname(storePath), name));
      }
      const original = fs.readFileSync(storePath);
      const denied = denyArchiveLinks("EPERM");
      const report = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(denied.mock.calls[0]?.[0]).toBe(storePath);
      expect(report.totals.importedEntries).toBe(1);
      expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
        expect.objectContaining({ code: "legacy_store_archive_failed" }),
      );
      expect(fs.readFileSync(storePath)).toEqual(original);
      expectNoArchivePlans(state.env);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    });
  });

  it.each(["import", "restore", "cleanup"] as const)(
    "withdraws every shared unpublished plan after interrupted deferral via %s",
    async (mode) => {
      await withOpenClawTestState(
        { label: "session-link-deferral-interruption" },
        async (state) => {
          const { cfg, originals, storePath } = seedSource(state, true);
          for (const name of [
            "orphan.jsonl",
            "legacy-kept.trajectory.jsonl",
            "legacy-kept.trajectory-path.json",
          ]) {
            const file = path.join(path.dirname(storePath), name);
            const bytes = Buffer.from(JSON.stringify({ artifact: name }) + "\n");
            fs.writeFileSync(file, bytes);
            originals.set(file, bytes);
          }
          denyArchiveLinks();
          const withdraw = archiveDeferral.withdrawUnpublishedMigrationMoves;
          const interrupted = vi
            .spyOn(archiveDeferral, "withdrawUnpublishedMigrationMoves")
            .mockImplementation((run, moves) => {
              if (moves.length > 0) {
                throw new Error("interrupted after receipt before manifest withdrawal");
              }
              return withdraw(run, moves);
            });
          await expect(
            runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" }),
          ).rejects.toThrow("interrupted after receipt");
          interrupted.mockRestore();
          const paths = migrationRun.listSessionSqliteMigrationManifestPaths(state.env);
          const manifest = migrationRun.readSessionSqliteMigrationManifest(paths[0]!)!;
          const shared = manifest.targets.filter((target) =>
            target.plannedMoves.some((move) => move.sourcePath.endsWith("legacy-kept.jsonl")),
          );
          expect(shared.map((target) => target.agentId).toSorted()).toEqual(["main", "work"]);
          for (const target of shared) {
            expect(
              readDeferredPluginSessionImport({
                cfg,
                env: state.env,
                target,
                sqlitePath: target.sqlitePath,
              })?.pluginIds,
            ).toEqual([]);
          }
          if (mode === "cleanup") {
            closeOpenClawAgentDatabasesForTest();
            const cleanup = await retireSessionSqliteRecovery({
              env: state.env,
              preview: inspectSessionSqliteRecovery({ cfg, env: state.env }),
              readConfig: async () => cfg,
              confirm: async () => true,
            });
            expect(cleanup.status).toBe("complete");
            expect(cleanup.totals.removedFiles).toBe(0);
          } else {
            const resumed = await runDoctorSessionSqlite({
              cfg,
              env: state.env,
              allAgents: true,
              mode,
            });
            expect(resumed.totals.importedEntries).toBe(0);
            expect(
              resumed.targets
                .flatMap((item) => item.issues)
                .filter((issue) => issue.message.includes("filesystem refused archive hard links")),
            ).toEqual([]);
            expect(resumed.targets.flatMap((target) => target.restore?.conflicts ?? [])).toEqual(
              [],
            );
          }
          expectNoArchivePlans(state.env);
          expect(inspectSessionSqliteRecovery({ cfg, env: state.env }).artifacts).toEqual([]);
          for (const [file, bytes] of originals) {
            expect(fs.readFileSync(file)).toEqual(bytes);
            expect(fs.statSync(file).nlink).toBe(1);
          }
        },
      );
    },
  );

  it.each([
    "native-auto",
    "open",
    "fsync",
    "unlink",
    "wrong-path",
    "changed-source",
    "aliased-source",
    "post-publication",
    "partial-publication",
  ])("does not defer %s failures", async (phase) => {
    if (phase === "native-auto") {
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "auto");
      vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "auto");
    }
    await withOpenClawTestState({ label: "session-link-denial-boundary" }, async (state) => {
      const { cfg, storePath } = seedSource(state);
      const link = fsPromises.link;
      if (phase === "native-auto") {
        vi.spyOn(migrationArtifact, "moveMigrationArtifact").mockImplementation(
          async (source, destination) => {
            throw linkError(source, destination);
          },
        );
      } else if (phase === "post-publication") {
        __setFsSafeTestHooksForTest({
          afterPublishTargetCreated: (_method, destination) => {
            throw linkError(path.join(path.dirname(storePath), "legacy-kept.jsonl"), destination);
          },
        });
      } else {
        vi.spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
          if (
            !String(destination).includes("session-sqlite-import-archive") ||
            (phase === "partial-publication" && String(source).endsWith("legacy-kept.jsonl"))
          ) {
            return link(source, destination);
          }
          if (phase === "changed-source") {
            const bytes = fs.readFileSync(source);
            fs.renameSync(source, String(source) + ".original");
            fs.writeFileSync(source, bytes);
          } else if (phase === "aliased-source") {
            fs.linkSync(source, String(source) + ".alias");
          }
          throw linkError(
            phase === "wrong-path" ? "unrelated-source" : source,
            destination,
            "EACCES",
            ["open", "fsync", "unlink"].includes(phase) ? phase : "link",
          );
        });
      }
      const report = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      const target = report.targets.find((item) => item.storePath === storePath)!;
      expect(
        readDeferredPluginSessionImport({
          cfg,
          env: state.env,
          target,
          sqlitePath: target.sqlitePath,
        }),
      ).toBeUndefined();
      expect(
        report.targets
          .flatMap((item) => item.issues)
          .some((issue) => issue.code.endsWith("archive_failed")),
      ).toBe(true);
      expect(
        report.targets
          .flatMap((item) => item.issues)
          .filter((issue) => issue.message.includes("filesystem refused archive hard links")),
      ).toEqual([]);
    });
  });

  it.each(["unselected", "failed"])("does not certify a shared %s owner", async (kind) => {
    await withOpenClawTestState({ label: "session-link-denial-owner-fence" }, async (state) => {
      const { cfg, storePath } = seedSource(state, true);
      const snapshot = sqliteReaders.readOnlySqliteValidationSnapshot;
      if (kind === "failed") {
        vi.spyOn(sqliteReaders, "readOnlySqliteValidationSnapshot").mockImplementation((target) => {
          const result = snapshot(target);
          return target.agentId === "work" &&
            result.ok &&
            result.snapshot.sessionIdsBySessionKey.has("agent:work:shared")
            ? { ok: false, error: new Error("failed shared owner validation") }
            : result;
        });
      }
      const denied = denyArchiveLinks();
      const report = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        mode: "import",
        ...(kind === "unselected" ? { agent: "main" } : { allAgents: true }),
      });
      expect(denied).not.toHaveBeenCalled();
      for (const target of report.targets) {
        expect(
          readDeferredPluginSessionImport({
            cfg,
            env: state.env,
            target,
            sqlitePath: target.sqlitePath,
          }),
        ).toBeUndefined();
      }
      expect(fs.existsSync(storePath)).toBe(true);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow();
    });
  });
});
