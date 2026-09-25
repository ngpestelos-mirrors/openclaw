import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as processExec from "../process/exec.js";
import { pathExists } from "../utils.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";

const { runCommandWithTimeout } = processExec;

export async function runFixtureGit(root: string, ...args: string[]) {
  const result = await processExec.runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

export async function resolveCandidateNodeRuntimeForTest(): Promise<{
  path: string;
  version: string;
}> {
  if (!process.versions.bun) {
    return { path: process.execPath, version: process.versions.node };
  }
  const systemNode = await resolveSystemNodeInfo({});
  if (systemNode?.status !== "supported" || !systemNode.version) {
    throw new Error("This candidate runtime test requires a supported system Node");
  }
  return { path: systemNode.path, version: systemNode.version };
}

export async function expectCancelledGitCandidateCleanup({
  phase,
  fixture: { localRoot, baseSha, targetSha },
  pnpmVersion,
  runRealGit,
}: {
  phase: "build" | "locked worktree creation";
  fixture: { localRoot: string; baseSha: string; targetSha: string };
  pnpmVersion: string;
  runRealGit: (cwd: string, ...args: string[]) => Promise<string>;
}) {
  const controller = new AbortController();
  const stopped = new Error("preflight owner stopped");
  const beforeGitMutation = vi.fn(async () => {
    throw new Error("cancelled update reached mutation");
  });
  let buildResult: Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined;
  let worktree: string | undefined;
  const commandSpy = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, optionsOrTimeout) => {
      const options =
        typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
      if (argv[0] !== "pnpm") {
        const result = await runCommandWithTimeout(argv, options);
        if (
          phase === "locked worktree creation" &&
          argv.includes("worktree") &&
          argv.includes("add")
        ) {
          worktree = argv.at(-2);
          assert.ok(worktree);
          // Git can retain this lock when creation is forcibly terminated during checkout.
          await runRealGit(worktree, "worktree", "lock", "--reason", "initializing", worktree);
          controller.abort(stopped);
        }
        if (argv.includes("worktree") && argv.includes("remove")) {
          assert.ok(options.cwd);
          expect(result.code).toBe(0);
          expect(await runRealGit(options.cwd, "worktree", "list", "--porcelain")).not.toContain(
            worktree,
          );
        }
        return result;
      }
      if (argv[1] === "build") {
        worktree = options.cwd;
        buildResult = await runCommandWithTimeout(
          [process.execPath, "-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
          { ...options, onOutputChunk: () => controller.abort(stopped) },
        );
        return buildResult;
      }
      return {
        stdout: argv[1] === "--version" ? pnpmVersion : "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        noOutputTimedOut: false,
      };
    });
  try {
    const commandRunner = await buildUpdateCommandRunner();
    const result = await updateGitCheckout({
      ...commandRunner,
      gitRoot: localRoot,
      timeoutMs: 5000,
      startedAt: Date.now(),
      runCommand: (argv, options) =>
        commandRunner.runCommand(argv, {
          ...options,
          signal: options.signal ?? controller.signal,
        }),
      opts: {
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: targetSha },
        inspectGitTarget: async () => {},
        validateCandidate: async () => {
          throw new Error("cancelled update reached validation");
        },
        beforeGitMutation,
        runGitDoctor: async () => {
          throw new Error("cancelled update reached Doctor");
        },
      },
    });
    expect(controller.signal.reason).toBe(stopped);
    expect(result.status).toBe("error");
    expect(beforeGitMutation).not.toHaveBeenCalled();
  } finally {
    commandSpy.mockRestore();
  }
  if (phase === "build") {
    expect(buildResult?.termination).toBe("signal");
  }
  assert.ok(worktree);
  expect(await pathExists(path.dirname(worktree))).toBe(false);
  expect(await runRealGit(localRoot, "worktree", "list", "--porcelain")).not.toContain(worktree);
  expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
}

export const runtimeImports = [
  "../dist-runtime/identity.cjs",
  "../packages/runtime/dist-runtime/identity.cjs",
  "../node_modules/identity.cjs",
  "workspace-runtime",
  "relative-workspace-runtime",
  "external-runtime",
  "absolute-external-runtime",
  "../packages/runtime/node_modules/external-runtime",
  "virtual-runtime",
];

export type VirtualStoreLayout =
  | "node_modules/.pnpm"
  | "node_modules/.cache/jiti"
  | "node_modules/.vite/deps"
  | ".pnpm"
  | "cache/deps"
  | "../store"
  | "external"
  | "symlink";

export async function writeRuntime(directory: string, sha: string, store: string, layout: string) {
  const root = await fs.realpath(directory);
  const dist = path.join(root, "dist");
  const external = path.join(store, sha);
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
  const virtualStore =
    layout === "external"
      ? path.join(store, "virtual-store")
      : path.resolve(root, layout === "symlink" ? ".pnpm" : layout);
  if (layout === "symlink") {
    const linkedStore = path.join(store, "linked-store", sha);
    await fs.mkdir(linkedStore, { recursive: true });
    await fs.rm(virtualStore, { force: true });
    await fs.symlink(linkedStore, virtualStore, "junction");
  }
  const virtualPackage = path.join(virtualStore, sha, "node_modules", "virtual-runtime");
  for (const file of [
    path.join(external, "index.js"),
    path.join(virtualPackage, "index.js"),
    path.join(root, "node_modules", "identity.cjs"),
    path.join(root, "packages", "runtime", "node_modules", "nested.cjs"),
    path.join(root, "dist-runtime", "identity.cjs"),
    path.join(root, "packages", "runtime", "dist-runtime", "identity.cjs"),
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `module.exports = ${JSON.stringify(sha)};`);
  }
  await fs.rm(path.join(root, "node_modules", "workspace-runtime"), { force: true });
  await fs.symlink(
    path.join(root, "packages", "runtime"),
    path.join(root, "node_modules", "workspace-runtime"),
    "junction",
  );
  for (const [relative, target, absolute] of [
    ["node_modules/relative-workspace-runtime", path.join(root, "packages", "runtime"), false],
    ["node_modules/external-runtime", external, false],
    ["node_modules/absolute-external-runtime", external, true],
    ["packages/runtime/node_modules/external-runtime", external, false],
    ["node_modules/virtual-runtime", virtualPackage, false],
  ] as const) {
    const file = path.join(root, relative);
    await fs.rm(file, { force: true });
    await fs.symlink(
      absolute || process.platform === "win32" ? target : path.relative(path.dirname(file), target),
      file,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await Promise.all([
    fs.writeFile(
      path.join(root, "node_modules", ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir:
          process.platform === "win32"
            ? virtualStore
            : path.relative(path.join(root, "node_modules"), virtualStore),
      }),
    ),
    fs.writeFile(
      path.join(dist, "entry.js"),
      runtimeImports
        .map((specifier) => `console.log(require(${JSON.stringify(specifier)}));`)
        .join("\n"),
    ),
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId: sha })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
  ]);
}

export async function expectRuntime(root: string, sha: string) {
  const child = await processExec.runCommandWithTimeout(
    [process.execPath, path.join(root, "dist", "entry.js")],
    {
      timeoutMs: 5000,
    },
  );
  expect(child.code, child.stderr).toBe(0);
  expect(child.stdout.trim().split("\n")).toEqual(runtimeImports.map(() => sha));
}

export function registerGitActivationDoctorOutcomeTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    events: string[];
    isStopped: () => boolean;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    advanceRemote: () => Promise<string>;
    git: (root: string, ...args: string[]) => Promise<string>;
    update: (
      opts: Pick<UpdateRunnerOptions, "runGitDoctor" | "onTransaction">,
    ) => Promise<UpdateRunResult>;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  registerGitRetainedTransactionTests(getFixture);
  it.each(["restore", "complete", "cleanup-failed", "source-changed", "runtime-changed"] as const)(
    "retains the activated Git transaction through finalization: %s",
    async (outcome) => {
      const { root, beforeSha, advanceRemote, git, update, expectNoRuntimeStagingPaths } =
        getFixture();
      const targetSha = await advanceRemote();
      let retained: PackageUpdateTransaction | undefined;
      const result = await update({
        onTransaction: (transaction) => {
          retained = transaction;
        },
      });
      expect(result.status).toBe("ok");
      assert(retained, "Finalization must receive the retained Git runtime transaction");
      await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
      expect(result.gitRuntime).toEqual({
        commit: targetSha,
        distDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      if (outcome === "cleanup-failed") {
        const remove = fs.rm.bind(fs);
        const backupRoot = retained.backupRoot;
        const removal = vi.spyOn(fs, "rm").mockImplementation(async (entry, options) => {
          if (entry === backupRoot) {
            throw Object.assign(new Error("backup cleanup denied"), { code: "EACCES" });
          }
          return remove(entry, options);
        });
        try {
          const warning = await retained.complete({ activationVerified: true }, () => {});
          expect(warning).toMatchObject({
            advisory: {
              kind: "recoverable-maintenance",
              message: expect.stringContaining(backupRoot),
            },
          });
          expect(await retained.complete({ activationVerified: true }, () => {})).toBe(warning);
          await expectRuntime(root, targetSha);
          await expect(fs.stat(backupRoot)).resolves.toBeDefined();
        } finally {
          removal.mockRestore();
        }
        return;
      }
      if (outcome === "complete") {
        await retained.complete({ activationVerified: true }, () => {});
        await expectRuntime(root, targetSha);
        await expectNoRuntimeStagingPaths();
        return;
      }
      if (outcome === "source-changed") {
        await fs.writeFile(path.join(root, "operator-edit.txt"), "preserve this edit\n");
        await expect(retained.rollback(() => {})).rejects.toThrow("changed after activation");
        await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow(
          "changed after activation",
        );
        expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
        expect(await fs.readFile(path.join(root, "operator-edit.txt"), "utf8")).toBe(
          "preserve this edit\n",
        );
        await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
        return;
      } else if (outcome === "runtime-changed") {
        await fs.writeFile(path.join(root, "dist", "operator-chunk.mjs"), "export {};\n");
      }
      const restored = await retained.rollback(() => {});
      expect(restored.exitCode).toBe(0);
      await retained.complete({ activationVerified: false }, () => {});
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      await expectRuntime(root, beforeSha);
      await expectNoRuntimeStagingPaths();
    },
  );
  it.each([
    ["success", undefined],
    ["config-refused", "repair-requires-config-change"],
    ["requester-revoked", "requester-revoked"],
    ["doctor-error", "doctor-failed"],
    ["doctor-zero-exit-timeout", "doctor-failed"],
    ["doctor-zero-exit-output-limit", "doctor-failed"],
    ["doctor-throw", "unexpected-error"],
    ["cleanup-uncertain", undefined],
    ["missing", "doctor-entry-missing"],
  ] as const)(
    "uses the CLI activation Doctor and preserves its outcome: %s",
    async (outcome, reason) => {
      const {
        root,
        beforeSha,
        events,
        isStopped,
        advanceRemote,
        git,
        update,
        expectNoRuntimeStagingPaths,
      } = getFixture();
      const targetSha = await advanceRemote();
      const configChanges: UpdateDoctorConfigChange[] = [{ kind: "key", key: "agents" }];
      const cleanupError = new Error("Doctor child cleanup remains unresolved", {
        cause: new CommandProcessCleanupError(),
      });
      const runGitDoctor = vi.fn(async (doctorRoot: string) => {
        expect(isStopped()).toBe(true);
        await expectRuntime(doctorRoot, targetSha);
        events.push("owned-doctor");
        if (outcome === "requester-revoked") {
          throw new UpdateRequesterRevokedError();
        }
        if (outcome === "doctor-throw") {
          throw new Error("Doctor failed after starting migration");
        }
        if (outcome === "cleanup-uncertain") {
          throw cleanupError;
        }
        if (outcome === "missing") {
          return null;
        }
        return {
          name: "openclaw doctor",
          command: "candidate doctor",
          cwd: doctorRoot,
          durationMs: 1,
          exitCode: outcome === "success" || outcome.startsWith("doctor-zero-exit-") ? 0 : 1,
          ...(outcome === "doctor-zero-exit-timeout" ? { termination: "timeout" as const } : {}),
          ...(outcome === "doctor-zero-exit-output-limit" ? { outputLimitExceeded: true } : {}),
          configChanges,
          ...(outcome === "config-refused"
            ? {
                configWriteRefusal: {
                  reason: "include-ownership",
                  message: "An included file owns the pending config change.",
                  keys: ["agents"],
                },
              }
            : {}),
        };
      });

      const running = update({ runGitDoctor });
      if (outcome === "cleanup-uncertain") {
        await expect(running).rejects.toBe(cleanupError);
        expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
        expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
        expect(await git(root, "rev-parse", "HEAD")).toBe(targetSha);
        await expectRuntime(root, targetSha);
        const backups = (await fs.readdir(root)).filter(
          (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
        );
        expect(backups).toHaveLength(1);
        const backup = backups[0];
        assert(backup);
        expect(
          JSON.parse(
            await fs.readFile(path.join(root, backup, "previous", "build-info.json"), "utf8"),
          ),
        ).toMatchObject({ commit: beforeSha, buildId: beforeSha });
        return;
      }
      const result = await running;

      expect(runGitDoctor).toHaveBeenCalledExactlyOnceWith(root, []);
      expect(events).toEqual(["build", "validate", "stop", "owned-doctor"]);
      expect(result.status).toBe(outcome === "success" ? "ok" : "error");
      expect(result.reason).toBe(reason);
      const expectedSha = outcome === "missing" ? beforeSha : targetSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      await expectRuntime(root, expectedSha);
      await expectNoRuntimeStagingPaths();
      if (outcome !== "success") {
        expect(result.recovery).toMatchObject(
          outcome === "missing"
            ? { serviceRestartSafe: true, buildId: beforeSha }
            : { serviceRestartSafe: false, reason: "state-migration-started" },
        );
      }
      if (outcome !== "requester-revoked" && outcome !== "doctor-throw" && outcome !== "missing") {
        expect(result.steps.find((step) => step.name === "openclaw doctor")?.configChanges).toEqual(
          configChanges,
        );
      }
    },
  );
}

function registerGitRetainedTransactionTests(
  getFixture: () => {
    root: string;
    beforeSha: string;
    advanceRemote: () => Promise<string>;
    update: (opts: Partial<UpdateRunnerOptions>) => Promise<UpdateRunResult>;
    runCommand: CommandRunner;
    setRunCommand: (runner: CommandRunner) => void;
    expectNoRuntimeStagingPaths: () => Promise<void>;
  },
) {
  it.each([
    ["source check", "tracked"],
    ["source check", "untracked"],
    ["checkout", "tracked"],
    ["checkout", "untracked"],
    ["reset", "tracked"],
    ["reset", "untracked"],
    ["before checkout", "tracked"],
    ["before reset", "tracked"],
    ["before reset", "staged"],
  ] as const)("retained rollback preserves %s await edits (%s)", async (phase, kind) => {
    const { root, beforeSha, advanceRemote, update, runCommand, setRunCommand } = getFixture();
    const targetSha = await advanceRemote();
    const relative =
      kind === "untracked"
        ? "operator-edit.txt"
        : phase === "reset"
          ? "openclaw.mjs"
          : "candidate.txt";
    const file = path.join(root, relative);
    const edit = "preserve this operator edit\n";
    let rollingBack = false;
    let edited = false;
    let retained: PackageUpdateTransaction | undefined;
    setRunCommand(async (argv, options) => {
      const matches =
        rollingBack &&
        !edited &&
        argv[0] === "git" &&
        argv[2] === root &&
        ((phase === "source check" && argv.includes("--abbrev-ref")) ||
          ((phase === "checkout" || phase === "before checkout") && argv.includes("checkout")) ||
          ((phase === "reset" || phase === "before reset") &&
            argv.includes("reset") &&
            argv.at(-1) === beforeSha));
      if (matches && phase.startsWith("before ")) {
        await fs.writeFile(file, edit);
        if (kind === "staged") {
          await runFixtureGit(root, "add", relative);
        }
        edited = true;
      }
      const result = await runCommand(argv, options);
      if (matches && !phase.startsWith("before ")) {
        expect(result.code).toBe(0);
        // The child has completed, but the rollback owner has not resumed yet.
        await fs.writeFile(file, edit);
        edited = true;
      }
      return result;
    });
    expect(
      (
        await update({
          onTransaction: (transaction) => {
            retained = transaction;
          },
        })
      ).status,
    ).toBe("ok");
    assert(retained);
    rollingBack = true;
    const failure = await retained
      .rollback(() => {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(edited).toBe(true);
    expect(await fs.readFile(file, "utf8").catch(() => undefined)).toBe(edit);
    if (kind === "staged") {
      expect(await runFixtureGit(root, "show", `:${relative}`)).toBe(edit.trim());
    }
    expect(failure).toBeInstanceOf(Error);
    await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
    expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(
      phase === "reset" ? beforeSha : targetSha,
    );
    expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await expectRuntime(root, targetSha);
    await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
    const distBackup = (await fs.readdir(root)).find(
      (entry) => entry.startsWith("dist.openclaw-update-") && entry.endsWith(".tmp"),
    );
    assert(distBackup);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, distBackup, "previous", "build-info.json"), "utf8"),
      ),
    ).toMatchObject({ commit: beforeSha });
  });

  it.each([
    ["operator-branch", false],
    ["HEAD", false],
    ["operator-branch", true],
  ] as const)(
    "retained rollback restores its own %s lineage (new branch edited: %s)",
    async (branch, branchEdited) => {
      const {
        root,
        beforeSha,
        advanceRemote,
        update,
        expectNoRuntimeStagingPaths,
        runCommand,
        setRunCommand,
      } = getFixture();
      await runFixtureGit(
        root,
        "checkout",
        ...(branch === "HEAD" ? ["--detach", beforeSha] : ["-b", branch]),
      );
      await runFixtureGit(root, "branch", "-D", "main");
      const targetSha = await advanceRemote();
      let edited = false;
      setRunCommand(async (argv, options) => {
        if (
          branchEdited &&
          argv[2] === root &&
          ((argv.includes("branch") && argv.includes("-D")) ||
            (argv.includes("update-ref") && argv.includes("-d")))
        ) {
          await runFixtureGit(root, "update-ref", "refs/heads/main", beforeSha, targetSha);
          edited = true;
        }
        return runCommand(argv, options);
      });
      let retained: PackageUpdateTransaction | undefined;
      expect(
        (
          await update({
            onTransaction: (transaction) => {
              retained = transaction;
            },
          })
        ).status,
      ).toBe("ok");
      assert(retained);
      if (branchEdited) {
        await expect(retained.rollback(() => {})).rejects.toThrow();
        expect(edited).toBe(true);
        expect(await runFixtureGit(root, "rev-parse", "refs/heads/main")).toBe(beforeSha);
        expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
        await expectRuntime(root, targetSha);
        await expect(retained.complete({ activationVerified: false }, () => {})).rejects.toThrow();
        await expect(fs.stat(retained.backupRoot)).resolves.toBeDefined();
        return;
      }
      expect((await retained.rollback(() => {})).exitCode).toBe(0);
      expect(await runFixtureGit(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await runFixtureGit(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
      expect(await runFixtureGit(root, "branch", "--list", "main")).toBe("");
      await expectRuntime(root, beforeSha);
      await retained.complete({ activationVerified: false }, () => {});
      await expectNoRuntimeStagingPaths();
    },
  );
}

export function registerGitRuntimeRestorationTests(
  getFixture: () => {
    directory: string;
    root: string;
    beforeSha: string;
    virtualStoreLayout: VirtualStoreLayout;
    advanceRemote: () => Promise<string>;
    runCommand: CommandRunner;
  },
) {
  it.each([false, true])(
    "retries partial runtime restoration without losing originals (cleanup first: %s)",
    async (cleanupFirst) => {
      const { directory, root, beforeSha, virtualStoreLayout, advanceRemote, runCommand } =
        getFixture();
      const candidateSha = await advanceRemote();
      await runFixtureGit(root, "fetch", "origin");
      const cleanupRoot = path.join(directory, "restore-candidate");
      const candidateRoot = path.join(cleanupRoot, "worktree");
      await fs.mkdir(cleanupRoot);
      await runFixtureGit(root, "worktree", "add", "--detach", candidateRoot, candidateSha);
      await writeRuntime(
        candidateRoot,
        candidateSha,
        path.join(directory, "shared-store"),
        virtualStoreLayout,
      );
      await expectRuntime(candidateRoot, candidateSha);
      const promotion = await prepareGitRuntimePromotion(
        root,
        candidateRoot,
        runCommand,
        5000,
        cleanupRoot,
      );
      await runFixtureGit(root, "worktree", "remove", "--force", candidateRoot);
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      const rename = fs.rename.bind(fs);
      let distBackup: string | undefined;
      let rejectRestore = true;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (rejectRestore && source === distBackup && destination === path.join(root, "dist")) {
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        return rename(source, destination);
      });
      await promotion.activate();
      await expectRuntime(root, candidateSha);
      await expect(promotion.restore()).rejects.toThrow();
      if (cleanupFirst) {
        await promotion.cleanup();
      }
      if (!distBackup) {
        throw new Error("The original dist backup was not observed.");
      }
      expect(
        JSON.parse(await fs.readFile(path.join(distBackup, "build-info.json"), "utf8")),
      ).toMatchObject({
        commit: beforeSha,
      });
      expect(await fs.readFile(path.join(root, "node_modules", "identity.cjs"), "utf8")).toContain(
        beforeSha,
      );
      rejectRestore = false;
      await promotion.restore();
      await expectRuntime(root, beforeSha);
      await promotion.cleanup();
      await expect(fs.stat(path.dirname(distBackup))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
}
