import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as gitExec from "../../infra/git-exec.js";
import * as gitWorker from "../../infra/git-worker.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import * as admissions from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadReads } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { type WorktreeAllocationGuard, withWorktreeAllocationLease } from "./allocation.js";
import * as checkout from "./checkout-materialize.js";
import * as eviction from "./eviction.js";
import * as cleanupLimits from "./gc-limits.js";
import { requireGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { resolveRepository } from "./repository-paths.js";
import { worktreeRunLeaseScope } from "./run-lease-owner.js";
import * as runLease from "./run-lease.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { testing as runLeaseTesting } from "./run-lease.test-support.js";
import { ManagedWorktreeService, type ManagedWorktreeRecord } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import * as snapshotHost from "./snapshot-host.js";
import { interceptWorktreeWorkerOperation } from "./worker-operation.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    runLeaseTesting.resetForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

describe("managed worktree cap eviction", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repoRoot: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let repository: Awaited<ReturnType<typeof resolveRepository>> | undefined;
  const config = { worktreeMaxCount: 1, worktreeAcceleration: false };

  beforeEach(async () => {
    config.worktreeMaxCount = 1;
    repository = undefined;
    root = tempDirs.make("openclaw-worktree-eviction-");
    repoRoot = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env, getConfig: () => config });
  });

  async function createFixture(
    name: string,
    options: Partial<Pick<ManagedWorktreeRecord, "ownerKind" | "ownerId">> = {},
  ) {
    repository ??= await resolveRepository(repoRoot);
    return materializeManagedWorktreeFixture({
      env,
      repoRoot,
      repoFingerprint: repository.fingerprint,
      stateDir: env.OPENCLAW_STATE_DIR!,
      name,
      now: Date.now(),
      ...options,
    });
  }

  const create = (name: string, source = repoRoot, target = service) =>
    target.create({ repoRoot: source, name, baseRef: "HEAD" });
  const read = (directory: string, file = "README.md") =>
    fs.readFile(path.join(directory, file), "utf8");
  const registry = (id: string) => getRegistryWorktree(env, id);
  const liveRecords = async (target = service) =>
    (await target.listRegistryRecords()).filter((record) => record.removedAt === undefined);
  const liveIds = async (target = service) =>
    (await liveRecords(target)).map((record) => record.id);
  const leases = (id: string) =>
    openOpenClawStateDatabase({ env })
      .db.prepare("SELECT lease_key FROM state_leases WHERE scope = ?")
      .all(worktreeRunLeaseScope(id));
  const evict = (record: ManagedWorktreeRecord, guard: WorktreeAllocationGuard) =>
    eviction.evictManagedWorktree({
      env,
      record,
      guard,
      reason: "idle-age",
      now: Date.now,
      getConfig: () => config,
    });
  async function removeExact(record: ManagedWorktreeRecord, target = service, unsaved?: string) {
    const head = await requireGit(record.path, ["rev-parse", "HEAD"]);
    await requireGit(record.path, ["checkout", "--detach", "HEAD"]);
    if (unsaved) {
      await fs.writeFile(path.join(record.path, "unsaved.txt"), unsaved);
    }
    const index = path.resolve(
      record.path,
      await requireGit(record.path, ["rev-parse", "--git-path", "index"]),
    );
    const { ownerKind, ownerId, createdAt, lastActiveAt } = record;
    return target.remove({
      id: record.id,
      reason: "exact fixture",
      exactState: {
        ownerKind,
        ownerId,
        createdAt,
        lastActiveAt,
        head,
        branchHead: head,
        indexSha256: createHash("sha256")
          .update(await fs.readFile(index))
          .digest("hex"),
      },
    });
  }

  it.each(["claim", "snapshot"] as const)(
    "retains uncertain %s custody after caller cancellation",
    async (stage) => {
      const record = await createFixture("uncertain");
      const primary = new SqliteWorkerError(
        "synthetic unknown operation settlement",
        "outcome-unknown",
      );
      const cancellation = new AbortController();
      const claim = runLease.claimWorktreeRemoval;
      let unsettled = false;
      vi.spyOn(runLease, "claimWorktreeRemoval").mockImplementation(async (...args) => {
        await claim(...args);
        if (stage === "claim") {
          unsettled = true;
          cancellation.abort(new Error("caller canceled after the claim"));
        }
      });
      const releaseSpy = vi.spyOn(runLease, "abortWorktreeRemoval");
      if (stage === "snapshot") {
        vi.spyOn(snapshotHost, "captureManagedWorktreeSnapshot").mockImplementation(async () => {
          cancellation.abort(new Error("caller canceled during the uncertain snapshot"));
          throw primary;
        });
      }
      const failure: unknown = await withWorktreeAllocationLease(
        { env, signal: cancellation.signal },
        (guard) =>
          evict(record, {
            ...guard,
            commitGuard: () => {
              if (unsettled) {
                throw primary;
              }
              guard.commitGuard();
            },
          }),
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "outcome-unknown" });
      expect(collectNestedErrorCandidates(failure)).toEqual(expect.arrayContaining([primary]));
      expect(releaseSpy).not.toHaveBeenCalled();
      await expect(acquireWorktreeRunLease(record.id, { env })).rejects.toThrow(/remov/);
      expect(registry(record.id)?.removedAt).toBeUndefined();
      expect(await read(record.path)).toBe("base\n");
    },
  );

  it("settles an admitted purge before releasing custody after caller cancellation", async () => {
    const record = await createFixture("cancel-after-admission");
    const cancellation = new AbortController();
    const execute = gitWorker.runGitWorkerOperation;
    vi.spyOn(gitWorker, "runGitWorkerOperation").mockImplementation((command, options) =>
      execute(command, {
        ...options,
        onEffect: async (effect, context) => {
          const result = await options?.onEffect?.(effect, context);
          if (
            command.type === "worktree.eviction-purge" &&
            effect.type === "worktree.eviction-admit"
          ) {
            cancellation.abort(new Error("caller canceled after purge admission"));
          }
          return result;
        },
      }),
    );
    await expect(
      withWorktreeAllocationLease({ env, signal: cancellation.signal }, (guard) =>
        evict(record, guard),
      ),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    expect(cancellation.signal.aborted).toBe(true);
    expect(registry(record.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(leases(record.id)).toEqual([]);
  });

  it("refuses a new dependency claim when any earlier eviction claim was lost", async () => {
    const [victim, earlier, next] = await materializeManagedWorktreeFixtures({
      env,
      repoRoot,
      stateDir: env.OPENCLAW_STATE_DIR!,
      names: ["batch-victim", "batch-earlier", "batch-next"],
      now: 1,
    });
    const token = "synthetic-eviction-batch";
    await withWorktreeAllocationLease({ env }, async (guard) => {
      const claim = (worktreeId: string) =>
        runLease.claimWorktreeRemoval(env, {
          worktreeId,
          token,
          workerAuthority: guard.workerAuthority,
        });
      await claim(victim!.id);
      await claim(earlier!.id);
      try {
        await runLease.abortWorktreeRemoval(env, earlier!.id, token);
        await expect(
          runLease.claimWorktreeRemoval(env, {
            worktreeId: next!.id,
            token,
            workerAuthority: {
              ...guard.workerAuthority,
              predicates: [{ kind: "removal-claims", ids: [victim!.id, earlier!.id], token }],
            },
          }),
        ).rejects.toThrow("Worktree removal claim changed");
        expect(leases(next!.id)).toEqual([]);
      } finally {
        await runLease.abortWorktreeRemoval(env, victim!.id, token);
      }
    });
  });

  it("keeps a managed source live until its ignored provisioning is safe from eviction", async () => {
    await fs.writeFile(path.join(repoRoot, ".gitignore"), "settings.local\n");
    await fs.writeFile(path.join(repoRoot, ".worktreeinclude"), "settings.local\n");
    await requireGit(repoRoot, ["add", ".gitignore", ".worktreeinclude"]);
    await requireGit(repoRoot, ["commit", "-m", "synthetic provisioning"]);
    await fs.writeFile(path.join(repoRoot, "settings.local"), "source baseline\n");
    const first = await create("source");
    await fs.writeFile(path.join(first.path, "settings.local"), "unique synthetic source bytes\n");
    await fs.writeFile(path.join(first.path, "README.md"), "unsaved source edit\n");
    const original = registry(first.id);
    await expect(create("copy", first.path)).rejects.toThrow(/cap 1.*live owners/);
    expect(registry(first.id)).toEqual(original);
    expect(await read(first.path)).toBe("unsaved source edit\n");
    expect(await read(first.path, "settings.local")).toBe("unique synthetic source bytes\n");
    config.worktreeMaxCount = 2;
    const copied = await create("copy", first.path);
    expect(await read(copied.path, "settings.local")).toBe("unique synthetic source bytes\n");
    expect(registry(first.id)).toEqual(original);
  });

  it("ranks shared heads once per repository when creating at the fleet cap", async () => {
    // Six records make even one Git command per worktree exceed the five-command bound.
    config.worktreeMaxCount = 6;
    const records = await materializeManagedWorktreeFixtures({
      env,
      repoRoot,
      stateDir: env.OPENCLAW_STATE_DIR!,
      names: ["rank-00", "rank-01", "rank-02", "rank-03", "rank-04", "rank-05"],
      now: 1,
    });
    await requireGit(repoRoot, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await requireGit(records.at(-1)!.path, ["checkout", "--detach", "HEAD"]);
    const checkoutPaths = new Set(records.map((record) => record.path));
    const text = vi.spyOn(gitExec, "executeGitCommand");
    const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
    const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
    const created = await create("at-cap");
    const cleanup = [...text.mock.calls, ...bytes.mock.calls, ...buffered.mock.calls].filter(
      (call) => call[2]?.operation === "worktree.cleanup",
    );
    const headProbes = cleanup.filter(
      ([cwd, args]) =>
        checkoutPaths.has(cwd) && args[0] === "rev-parse" && args.includes("HEAD^{commit}"),
    ).length;
    const defaultLookups = cleanup.filter(([, args]) =>
      args.includes("refs/remotes/origin/HEAD^{commit}"),
    ).length;
    const ancestryChecks = cleanup.filter(
      ([, args]) => args[0] === "merge-base" && args.includes("--is-ancestor"),
    ).length;
    const inventory = await service.listRegistryRecords();
    expect(
      inventory
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id)
        .toSorted(),
    ).toEqual([...records.slice(1).map((record) => record.id), created.id].toSorted());
    expect(
      inventory.filter((record) => record.removedAt !== undefined).map((record) => record.id),
    ).toEqual([records[0]!.id]);
    await expect(fs.stat(records[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
    for (const record of [...records.slice(1), created]) {
      expect(await read(record.path)).toBe("base\n");
    }
    // One repository inventory/default, one shared-head classification, and fresh purge checks.
    expect(cleanup.length).toBeLessThanOrEqual(5);
    expect(headProbes).toBe(0);
    expect(defaultLookups).toBeLessThanOrEqual(1);
    expect(ancestryChecks).toBeLessThanOrEqual(1);
  });

  it("uses the current runtime cap when no configuration getter is injected", async () => {
    const first = await createFixture("first");
    const runtimeService = new ManagedWorktreeService({ env });
    try {
      setRuntimeConfigSnapshot({ worktreeMaxCount: 1 });
      const second = await create("second", repoRoot, runtimeService);
      expect(registry(first.id)?.removedAt).toEqual(expect.any(Number));
      setRuntimeConfigSnapshot({ worktreeMaxCount: 2 });
      const third = await create("third", repoRoot, runtimeService);
      expect((await liveIds(runtimeService)).toSorted()).toEqual([second.id, third.id].toSorted());
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("keeps a retained exact source and its live ancestor when restoration needs another slot", async () => {
    config.worktreeMaxCount = 2;
    const outer = await create("outer");
    const nested = new ManagedWorktreeService({
      env,
      getConfig: () => ({ ...config, worktreeRoot: path.join(outer.path, "children") }),
    });
    const child = await create("retained-child", repoRoot, nested);
    const retired = await removeExact(child, nested, "retained child bytes\n");
    const original = registry(outer.id);
    config.worktreeMaxCount = 1;
    await expect(nested.restore({ id: child.id })).rejects.toThrow(/cap 1.*live owners/);
    expect(registry(outer.id)).toEqual(original);
    expect(registry(child.id)?.removedAt).toEqual(expect.any(Number));
    expect(await read(retired.recoveryPath!, "unsaved.txt")).toBe("retained child bytes\n");
    config.worktreeMaxCount = 2;
    const restored = await nested.restore({ id: child.id });
    expect(await read(restored.path, "unsaved.txt")).toBe("retained child bytes\n");
    expect(registry(outer.id)).toEqual(original);
  });

  it("holds one global cap when a pending create publishes during eviction planning", async ({
    signal,
  }) => {
    const otherRepo = await initializeRepository(path.join(root, "other"));
    const otherService = new ManagedWorktreeService({ env, getConfig: () => config });
    const publishing = createDeferred();
    const published = createDeferred();
    const release = createDeferred();
    let held = false;
    const transport = interceptWorktreeWorkerOperation((execute) => async (command, options) => {
      if (command.type === "worktrees.insert" && !held) {
        held = true;
        publishing.resolve();
        await release.promise;
        const result = await execute(command, options);
        published.resolve();
        return result;
      }
      return execute(command, options);
    });
    const first = service.create({ repoRoot, name: "first", baseRef: "HEAD", signal });
    const creations = [first];
    let planning = false;
    const enforce = cleanupLimits.enforceWorktreeCleanupLimits;
    vi.spyOn(cleanupLimits, "enforceWorktreeCleanupLimits").mockImplementation(async (params) => {
      planning = true;
      try {
        return await enforce(params);
      } finally {
        planning = false;
      }
    });
    const readRegistry = registryReads.readRegistryWorktrees;
    let publishedDuringPlanning = false;
    vi.spyOn(registryReads, "readRegistryWorktrees").mockImplementation(async (...args) => {
      const records = await readRegistry(...args);
      if (planning && args[1]?.liveOnly && records.length === 0 && !publishedDuringPlanning) {
        publishedDuringPlanning = true;
        release.resolve();
        await published.promise;
      }
      return records;
    });
    let created: Awaited<typeof first>[];
    try {
      await withinTest(publishing.promise, signal);
      creations.push(
        otherService.create({ repoRoot: otherRepo, name: "second", baseRef: "HEAD", signal }),
      );
      created = await Promise.all(creations);
      expect(publishedDuringPlanning).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled(creations);
      transport.mockRestore();
    }
    const records = await service.listRegistryRecords();
    const active = records.filter((record) => record.removedAt === undefined);
    expect(active).toHaveLength(1);
    expect(records.filter((record) => record.removedAt !== undefined)).toHaveLength(1);
    expect(created.map((record) => record.id).toSorted()).toEqual(
      records.map((record) => record.id).toSorted(),
    );
    expect(await read(active[0]!.path)).toBe("base\n");
    const retired = records.find((record) => record.removedAt !== undefined)!;
    await expect(fs.stat(retired.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots dirty data before purging and restores it while preserving the cap", async () => {
    const dirty = await createFixture("dirty");
    await fs.writeFile(path.join(dirty.path, "README.md"), "unsaved tracked edit\n");
    await fs.writeFile(path.join(dirty.path, "untracked.txt"), "unsaved new file\n");
    const reads = observeMainThreadReads();
    const worktreeReads: string[] = [];
    let grants = 0;
    const createAdmission = admissions.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(admissions, "createSqliteWorkerOperationAdmission")
      .mockImplementation((handler, ...options) =>
        createAdmission(
          (request, grant) => {
            grants += 1;
            reads.clear();
            try {
              return handler(request, grant);
            } finally {
              for (const call of reads.calls) {
                for (const [index, statement] of call.mock.contexts.entries()) {
                  if (
                    statement instanceof StatementSync &&
                    (/\bworktrees\b/u.test(statement.sourceSQL) ||
                      (/\bstate_leases\b/u.test(statement.sourceSQL) &&
                        call.mock.calls[index]?.some(
                          (value) =>
                            typeof value === "string" &&
                            value.includes(worktreeRunLeaseScope(dirty.id)),
                        )))
                  ) {
                    worktreeReads.push(statement.sourceSQL);
                  }
                }
              }
            }
          },
          ...options,
        ),
      );
    const replacement = await create("replacement").finally(() => {
      admission.mockRestore();
      reads.restore();
    });
    expect(grants).toBeGreaterThan(0);
    expect(worktreeReads).toEqual([]);
    const archived = registry(dirty.id)!;
    expect(archived.removedAt).toEqual(expect.any(Number));
    expect(archived.snapshotRef).toMatch(/^refs\/openclaw\/snapshots\//);
    await expect(fs.stat(dirty.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await requireGit(repoRoot, ["show", `${archived.snapshotRef}:untracked.txt`])).toBe(
      "unsaved new file",
    );

    const branchHead = await requireGit(repoRoot, ["rev-parse", `refs/heads/${dirty.branch}`]);
    const materialize = vi
      .spyOn(checkout, "materializeManagedWorktree")
      .mockRejectedValueOnce(new Error("synthetic restore checkout failure"));
    try {
      await expect(service.restore({ id: dirty.id })).rejects.toThrow(
        "synthetic restore checkout failure",
      );
    } finally {
      materialize.mockRestore();
    }
    expect(await requireGit(repoRoot, ["rev-parse", `refs/heads/${dirty.branch}`])).toBe(
      branchHead,
    );
    await expect(fs.stat(dirty.path)).rejects.toMatchObject({ code: "ENOENT" });
    const restored = await service.restore({ id: dirty.id });
    expect(await read(restored.path)).toBe("unsaved tracked edit\n");
    expect(await read(restored.path, "untracked.txt")).toBe("unsaved new file\n");
    expect(registry(replacement.id)?.removedAt).toEqual(expect.any(Number));
    expect(await liveIds()).toEqual([dirty.id]);
  });

  it.each([
    ["advanced branch", /Recorded branch moved/],
    ["missing repository", /source repository no longer exists/],
    ["occupied destination", /occupied/],
    ["missing snapshot", /rev-parse|single revision|snapshot/],
    ["retained exact", /occupied|identity/],
    ["fallback exact", /occupied|identity/],
  ] as const)("preserves the full fleet when %s prevents restoration", async (failure, error) => {
    const archived = await createFixture("archived");
    const exact = failure === "retained exact" || failure === "fallback exact";
    const removed = exact
      ? await removeExact(archived)
      : failure !== "advanced branch"
        ? await service.remove({ id: archived.id, reason: "fixture" })
        : undefined;
    if (failure === "fallback exact") {
      await requireGit(repoRoot, ["worktree", "remove", "--force", "--", removed!.recoveryPath!]);
    }
    const live = await create("live");
    await fs.writeFile(path.join(live.path, "README.md"), "unrelated unsaved data\n");
    const liveBefore = registry(live.id);
    const branch = `refs/heads/${archived.branch}`;
    let advanced: string | undefined;
    if (failure === "advanced branch") {
      const parent = await requireGit(repoRoot, ["rev-parse", branch]);
      advanced = await requireGit(repoRoot, [
        "commit-tree",
        `${parent}^{tree}`,
        "-p",
        parent,
        "-m",
        "synthetic retained branch advance",
      ]);
      await requireGit(repoRoot, ["update-ref", branch, advanced, parent]);
    } else if (failure === "missing snapshot") {
      await requireGit(repoRoot, ["update-ref", "-d", removed!.snapshotRef!]);
    } else if (failure === "missing repository") {
      await fs.rename(repoRoot, path.join(root, "unavailable-repository"));
    } else {
      await fs.mkdir(archived.path, { recursive: true });
      await fs.writeFile(path.join(archived.path, "occupied"), "preserve destination\n");
    }
    await expect(
      failure === "missing snapshot" ? create(archived.name) : service.restore({ id: archived.id }),
    ).rejects.toThrow(error);
    if (advanced) {
      expect(await requireGit(repoRoot, ["rev-parse", branch])).toBe(advanced);
    }
    expect(registry(live.id)).toEqual(liveBefore);
    expect(await read(live.path)).toBe("unrelated unsaved data\n");
    expect(await liveIds()).toEqual([live.id]);
    if (exact) {
      await fs.rm(archived.path, { recursive: true });
      const restored = await service.restore({ id: archived.id });
      expect(await read(restored.path)).toBe("base\n");
      expect(registry(live.id)?.removedAt).toEqual(expect.any(Number));
      expect(await service.restore({ id: archived.id })).toEqual(restored);
      expect(await liveIds()).toEqual([archived.id]);
    }
  });

  it("refuses a create at the cap when the remaining checkout has a live owner", async () => {
    const active = await createFixture("active", {
      ownerKind: "session",
      ownerId: "agent:main:active",
    });
    const lease = await acquireWorktreeRunLease(active.id, { env });
    try {
      await expect(create("refused")).rejects.toThrow(
        /cap 1.*session:agent:main:active.*worktreeMaxCount/,
      );
      expect(registry(active.id)?.removedAt).toBeUndefined();
      expect(await read(active.path)).toBe("base\n");
      expect(await requireGit(repoRoot, ["branch", "--list", "openclaw/refused"])).toBe("");
      expect(await service.listRegistryRecords()).toHaveLength(1);
    } finally {
      await lease.release();
    }
  });
});
