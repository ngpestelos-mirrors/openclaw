import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { abortWorktreeRemoval, claimWorktreeRemoval } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("ManagedWorktreeService naming", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-naming-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses readable defaults and numbers colliding inferred names", async () => {
    const fallback = await service.create({ repoRoot: repo, baseRef: "HEAD" });
    await service.create({ repoRoot: repo, name: "release-planning", baseRef: "HEAD" });
    const second = await service.create({
      repoRoot: repo,
      suggestedName: "release-planning",
      baseRef: "HEAD",
    });

    expect(fallback.name).toMatch(
      /^[a-z]+-(?:barnacle|claw|crab|crayfish|krill|langoustine|lobster|prawn|shrimp|shell)$/,
    );
    expect(second.name).toBe("release-planning-2");
  });

  it("numbers inferred names around unmanaged Git and filesystem collisions", async () => {
    const anchor = await service.create({ repoRoot: repo, name: "anchor", baseRef: "HEAD" });
    await git(repo, "branch", "openclaw/release-planning");
    await fs.mkdir(path.join(path.dirname(anchor.path), "release-planning-2"));

    const created = await service.create({
      repoRoot: repo,
      suggestedName: "release-planning",
      baseRef: "HEAD",
    });

    expect(created.name).toBe("release-planning-3");
  });

  it("serializes concurrent inferred-name creation", async () => {
    const created = await Promise.all([
      service.create({ repoRoot: repo, suggestedName: "concurrent-task", baseRef: "HEAD" }),
      service.create({ repoRoot: repo, suggestedName: "concurrent-task", baseRef: "HEAD" }),
    ]);

    expect(created.map((record) => record.name).toSorted()).toEqual([
      "concurrent-task",
      "concurrent-task-2",
    ]);
  });

  it("reuses concurrent inferred names for the same owner", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:session-1",
    };
    const created = await Promise.all([
      service.create({ ...owner, suggestedName: "first-session-title" }),
      service.create({ ...owner, suggestedName: "second-session-title" }),
    ]);

    expect(created[0]?.id).toBe(created[1]?.id);
    expect(created[0]?.name).toMatch(/^(?:first|second)-session-title$/);
    expect(
      (await service.list()).filter((record) => record.ownerId === owner.ownerId),
    ).toHaveLength(1);
  });

  it("shares an explicit session name without giving manual callers ownership", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:session-1",
    });
    const shared = await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:session-2",
    });

    expect(shared.id).toBe(created.id);
    expect(service.listSessionBindings(created.id, { activeOnly: true })).toEqual([
      "agent:main:session-1",
      "agent:main:session-2",
    ]);
    expect(service.findLiveByOwner("session", "agent:main:session-2")?.id).toBe(created.id);
    await expect(service.create({ repoRoot: repo, name: "shared-name" })).rejects.toThrow(
      /already in use by session/,
    );

    await expect(
      service.removeIfLosslessByPath(created.path, {
        ownerKind: "session",
        ownerId: "agent:main:session-1",
      }),
    ).resolves.toBe(false);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
  });

  it("authorizes the actual membership set before binding a shared name", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "guarded-share",
      ownerKind: "session",
      ownerId: "agent:main:session-1",
    });
    const observed: string[][] = [];

    await expect(
      service.create({
        repoRoot: repo,
        name: "guarded-share",
        ownerKind: "session",
        ownerId: "agent:main:session-2",
        sessionBindingGuard: (_record, sessionKeys) => {
          observed.push([...sessionKeys]);
          throw new Error("sharing denied");
        },
      }),
    ).rejects.toThrow("sharing denied");

    expect(observed).toEqual([["agent:main:session-1"]]);
    expect(service.listSessionBindings(created.id)).toEqual(["agent:main:session-1"]);
  });

  it("fences lossless removal against a newly attached peer", async () => {
    const firstKey = "agent:main:session-1";
    const created = await service.create({
      repoRoot: repo,
      name: "removal-fence",
      ownerKind: "session",
      ownerId: firstKey,
    });
    await service.create({
      repoRoot: repo,
      name: "removal-fence",
      ownerKind: "session",
      ownerId: "agent:main:session-2",
    });

    await expect(
      service.removeIfLossless(created.id, { expectedActiveSessionKeys: [firstKey] }),
    ).resolves.toBe(false);
    await expect(fs.access(created.path)).resolves.toBeUndefined();
    expect(service.listSessionBindings(created.id, { activeOnly: true })).toHaveLength(2);
  });

  it("rejects session attachment while removal owns the checkout", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "claimed-removal",
      ownerKind: "session",
      ownerId: "agent:main:session-1",
    });
    claimWorktreeRemoval(env, { worktreeId: created.id, token: "test-removal" });
    try {
      await expect(
        service.create({
          repoRoot: repo,
          name: "claimed-removal",
          ownerKind: "session",
          ownerId: "agent:main:session-2",
        }),
      ).rejects.toThrow("removal is in progress");
      expect(service.listSessionBindings(created.id)).toEqual(["agent:main:session-1"]);
    } finally {
      abortWorktreeRemoval(env, created.id, "test-removal");
    }
  });

  it("upgrades and reopens a legacy owner row through explicit bindings", async () => {
    const ownerKey = "agent:main:legacy-owner";
    const peerKey = "agent:main:legacy-peer";
    const created = await service.create({
      repoRoot: repo,
      name: "legacy-share",
      ownerKind: "session",
      ownerId: ownerKey,
    });
    openOpenClawStateDatabase({ env }).db.exec("DROP TABLE worktree_session_bindings");
    expect(service.listSessionBindings(created.id)).toEqual([ownerKey]);

    await service.create({
      repoRoot: repo,
      name: "legacy-share",
      ownerKind: "session",
      ownerId: peerKey,
    });
    closeOpenClawStateDatabaseForTest();

    expect(service.listSessionBindings(created.id, { activeOnly: true })).toEqual([
      ownerKey,
      peerKey,
    ]);
  });

  it("upgrades a released v17 owner row and publishes the rollback fence", async () => {
    const ownerKey = "agent:main:v17-owner";
    const peerKey = "agent:main:v17-peer";
    const created = await service.create({
      repoRoot: repo,
      name: "v17-share",
      ownerKind: "session",
      ownerId: ownerKey,
    });
    const database = openOpenClawStateDatabase({ env }).db;
    database.exec(`
      DROP TABLE worktree_session_bindings;
      PRAGMA user_version = 17;
      UPDATE schema_meta SET schema_version = 17 WHERE meta_key = 'primary';
      INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES ('state.schema.contentVersion', '17', 1)
      ON CONFLICT(state_key) DO UPDATE SET value_json = '17', updated_at_ms = 1;
    `);
    closeOpenClawStateDatabaseForTest();

    expect(service.listSessionBindings(created.id)).toEqual([ownerKey]);
    const migrated = openOpenClawStateDatabase({ env }).db;
    expect(migrated.prepare("PRAGMA user_version").get()).toEqual({ user_version: 18 });
    expect(
      migrated.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
    ).toEqual({ schema_version: 18 });

    await service.create({
      repoRoot: repo,
      name: "v17-share",
      ownerKind: "session",
      ownerId: peerKey,
    });
    expect(service.listSessionBindings(created.id, { activeOnly: true })).toEqual([
      ownerKey,
      peerKey,
    ]);
  });

  it.each(["create", "list", "gc"] as const)(
    "retires vanished checkout bindings before replacement through %s reconciliation",
    async (reconciliation) => {
      const ownerId = `agent:main:vanished-${reconciliation}`;
      const request = {
        repoRoot: repo,
        suggestedName: `vanished-${reconciliation}`,
        ownerKind: "session" as const,
        ownerId,
      };
      const created = await service.create(request);
      await fs.rm(created.path, { recursive: true, force: true });

      if (reconciliation === "list") {
        await service.list();
      } else if (reconciliation === "gc") {
        await service.gc();
      }
      const replacement = await service.create(request);

      expect(replacement.id).not.toBe(created.id);
      expect(service.listSessionBindings(created.id, { activeOnly: true })).toEqual([]);
      expect(service.listSessionBindings(replacement.id, { activeOnly: true })).toEqual([ownerId]);
      await expect(fs.access(replacement.path)).resolves.toBeUndefined();
    },
  );

  it("numbers a generated name colliding with the owner's removed record", async () => {
    const owner = {
      repoRoot: repo,
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:main",
    };
    const first = await service.create({ ...owner, suggestedName: "same-title" });
    await service.remove({ id: first.id, reason: "session-reset" });

    const successor = await service.create({ ...owner, suggestedName: "same-title" });

    expect(successor.id).not.toBe(first.id);
    expect(successor.name).toBe("same-title-2");
    expect((await service.list()).find((record) => record.id === first.id)?.removedAt).toEqual(
      expect.any(Number),
    );
  });

  it("serializes overlapping numeric suffix families", async () => {
    await service.create({ repoRoot: repo, name: "task", baseRef: "HEAD" });

    const created = await Promise.all([
      service.create({ repoRoot: repo, suggestedName: "task", baseRef: "HEAD" }),
      service.create({ repoRoot: repo, suggestedName: "task-2", baseRef: "HEAD" }),
    ]);
    const names = created.map((record) => record.name);

    expect(new Set(names).size).toBe(2);
    expect(names).toContain("task-2");
    expect(names.every((name) => /^task-(?:2-2|3|2)$/.test(name))).toBe(true);
  });
});
