import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  recordCommandProcessFailure,
} from "../process/exec-result.js";
import * as processExec from "../process/exec.js";
import {
  cloneProjectCheckout,
  ProjectCloneError,
  readProjectCheckoutRemoteHead,
  refreshProjectCheckout,
} from "./project-clone-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const projectUrl = "https://github.com/example/project.git";
const pinnedCommit = "a".repeat(40);
const failedClone: processExec.SpawnResult = {
  code: 128,
  stdout: "",
  stderr: "fatal: unable to access repository: The requested URL returned error: 503",
  termination: "exit",
  signal: null,
  killed: false,
};
const successfulGit: processExec.SpawnResult = { ...failedClone, code: 0, stderr: "" };
const capture = (pending: Promise<unknown>) => pending.catch((error: unknown) => error);
const mockGit = () => vi.spyOn(processExec, "runCommandWithTimeout");
const targetPath = () => path.join(dirs.make("openclaw-clone-"), "checkout");
const clone = (target: string, requiredCommit?: string) =>
  cloneProjectCheckout({ url: projectUrl, target, requiredCommit });
const expectFile = (file: string, content: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(content);
const expectMissing = (file: string) =>
  expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
async function writeArtifact(target: string, name: string, content: string, recursive = false) {
  await fs.mkdir(target, { recursive });
  await fs.writeFile(path.join(target, name), content);
}
function fakeRetryClock() {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
}
function uncertainFailure(message: string) {
  return recordCommandProcessFailure(new Error(message), {
    code: null,
    termination: "signal",
    cleanup: "uncertain",
  });
}

it("preserves an existing checkout when its target cannot be inspected", async () => {
  const target = dirs.make("openclaw-clone-target-");
  const sentinel = path.join(target, "existing.txt");
  await fs.writeFile(sentinel, "existing project data");
  vi.spyOn(fs, "lstat").mockRejectedValueOnce(
    Object.assign(new Error("synthetic target inspection failure"), { code: "EACCES" }),
  );
  const command = mockGit().mockResolvedValue({
    ...failedClone,
    stderr: "fatal: destination path already exists and is not an empty directory",
  });
  const error = await capture(clone(target));
  await expectFile(sentinel, "existing project data");
  expect(error).toBeInstanceOf(ProjectCloneError);
  expect(error).toMatchObject({ failure: "clone_failed" });
  expect(command).not.toHaveBeenCalled();
});

it("clones into a genuinely missing target", async () => {
  const target = targetPath();
  mockGit().mockImplementation(async () => {
    await writeArtifact(target, "README.md", "cloned project");
    return successfulGit;
  });
  await clone(target);
  await expectFile(path.join(target, "README.md"), "cloned project");
});

it.each([0, 128])(
  "preserves the checkout when Git cleanup is uncertain (exit %s)",
  async (code) => {
    const target = targetPath();
    const sentinel = path.join(target, "partial.txt");
    const command = mockGit().mockImplementation(async () => {
      await writeArtifact(target, "partial.txt", "owned clone data");
      return { ...failedClone, code, cleanup: "uncertain" };
    });

    const error = await capture(clone(target));
    await expectFile(sentinel, "owned clone data");
    expect(hasCommandProcessCleanupError(error)).toBe(true);
    expect(command).toHaveBeenCalledOnce();
  },
);

it("surfaces failed partial-checkout removal without retrying Git", async () => {
  fakeRetryClock();
  const target = targetPath();
  const sentinel = path.join(target, "partial.txt");
  const command = mockGit().mockImplementation(async () => {
    await writeArtifact(target, "partial.txt", "partial clone", true);
    return failedClone;
  });
  const remove = fs.rm;
  const removalAttempted = Promise.withResolvers<void>();
  vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
    if (location === target) {
      removalAttempted.resolve();
      throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    }
    return remove(location, options);
  });

  const pending = capture(clone(target));
  await removalAttempted.promise;
  await vi.runAllTimersAsync();
  const error = await pending;

  await expectFile(sentinel, "partial clone");
  expect(error).toBeInstanceOf(ProjectCloneError);
  expect(error).toMatchObject({ failure: "clone_failed" });
  expect(error).toHaveProperty("message", expect.stringContaining("remove the partial checkout"));
  expect(command).toHaveBeenCalledOnce();
});

it("removes a settled partial checkout before the normal network retry", async () => {
  fakeRetryClock();
  const target = targetPath();
  const partial = path.join(target, "partial.txt");
  let attempts = 0;
  const command = mockGit().mockImplementation(async () => {
    if (attempts++ === 0) {
      await writeArtifact(target, "partial.txt", "partial clone");
      return failedClone;
    }
    await expectMissing(target);
    await writeArtifact(target, "README.md", "retried checkout");
    return { ...failedClone, code: 0, stderr: "" };
  });
  const remove = fs.rm;
  const removed = Promise.withResolvers<void>();
  vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
    await remove(location, options);
    if (location === target) {
      removed.resolve();
    }
  });

  const pending = clone(target);
  await removed.promise;
  await vi.runAllTimersAsync();
  await pending;

  await expectFile(path.join(target, "README.md"), "retried checkout");
  await expectMissing(partial);
  expect(command).toHaveBeenCalledTimes(2);
});

it("retains a clone when its thrown failure records uncertain cleanup", async () => {
  const target = targetPath();
  const sentinel = path.join(target, "partial.txt");
  const failure = uncertainFailure("synthetic capture failure");
  const command = mockGit().mockImplementation(async () => {
    await writeArtifact(target, "partial.txt", "owned clone data");
    throw failure;
  });

  const error = await capture(clone(target));

  expect(hasCommandProcessCleanupError(error)).toBe(true);
  expect(error).toHaveProperty("cause", failure);
  await expectFile(sentinel, "owned clone data");
  expect(command).toHaveBeenCalledOnce();
});

it.each(["probe", "fetch", "repair"] as const)(
  "retains a pinned checkout after uncertain %s work",
  async (phase) => {
    const target = targetPath();
    const sentinel = path.join(target, "partial.txt");
    const failure = uncertainFailure("synthetic repair capture failure");
    mockGit().mockImplementation(async (argv): Promise<processExec.SpawnResult> => {
      if (argv.includes("clone")) {
        await writeArtifact(target, "partial.txt", "pinned clone data");
        return successfulGit;
      }
      if (argv.includes("rev-list")) {
        return phase === "probe"
          ? { ...successfulGit, stdout: pinnedCommit, cleanup: "uncertain" }
          : { ...failedClone, stderr: "missing commit" };
      }
      if (argv.includes("fetch")) {
        return phase === "fetch"
          ? { ...successfulGit, cleanup: "uncertain" }
          : {
              ...failedClone,
              stderr: "which is in the commit graph file but not in the object database",
            };
      }
      if (argv.includes("for-each-ref")) {
        throw failure;
      }
      throw new Error("unexpected pinned Git command");
    });

    const error = await capture(clone(target, pinnedCommit));

    expect(hasCommandProcessCleanupError(error)).toBe(true);
    if (phase === "repair") {
      expect(error).toHaveProperty("cause", failure);
    }
    await expectFile(sentinel, "pinned clone data");
  },
);

it.each(["uncertain", "settled auth failure"] as const)(
  "cleans or preserves a pinned checkout after %s",
  async (outcome) => {
    const target = targetPath();
    const sentinel = path.join(target, "partial.txt");
    const failure = new CommandProcessCleanupError();
    mockGit().mockImplementation(async (argv) => {
      if (argv.includes("clone")) {
        await writeArtifact(target, "partial.txt", "pinned clone data");
        return successfulGit;
      }
      if (outcome === "uncertain") {
        throw failure;
      }
      return { ...failedClone, stderr: "Authentication failed" };
    });

    const error = await capture(clone(target, pinnedCommit));

    if (outcome === "uncertain") {
      expect(error).toBe(failure);
      await expectFile(sentinel, "pinned clone data");
    } else {
      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toHaveProperty("failure", "auth_required");
      await expectMissing(target);
    }
  },
);

it.each(["fetch", "repair", "inventory", "success", "auth failure", "cleanup failure"] as const)(
  "retains or cleans refresh staging after %s",
  async (phase) => {
    const root = dirs.make("openclaw-refresh-cleanup-");
    const target = path.join(root, "checkout");
    const objects = path.join(root, "objects");
    await fs.mkdir(target);
    await fs.mkdir(objects);
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    const failure = uncertainFailure("synthetic repair capture failure");
    const cleanupFailure = new Error("synthetic staging removal failure");
    let staging = "";
    let managedInventories = 0;
    const published: (string | Uint8Array | undefined)[] = [];
    mockGit().mockImplementation(async (argv, options): Promise<processExec.SpawnResult> => {
      const cwd = argv[argv.indexOf("-C") + 1];
      if (argv.includes("--git-path")) {
        return { ...successfulGit, stdout: objects };
      }
      if (argv.includes("--show-object-format")) {
        return { ...successfulGit, stdout: "sha1" };
      }
      if (argv.includes("config")) {
        return { ...successfulGit, code: 1 };
      }
      if (argv.includes("init") && cwd) {
        staging = cwd;
        await fs.writeFile(path.join(staging, "partial.txt"), "owned staging data");
        return successfulGit;
      }
      if (argv.includes("for-each-ref")) {
        if (cwd === target) {
          if (phase === "repair" && managedInventories++ > 0) {
            throw failure;
          }
          return {
            ...successfulGit,
            stdout: phase === "repair" ? `refs/remotes/origin/main ${pinnedCommit}` : "",
          };
        }
        return {
          ...successfulGit,
          stdout: `refs/remotes/origin/main ${pinnedCommit}`,
          cleanup: phase === "inventory" ? "uncertain" : undefined,
        };
      }
      if (argv.includes("update-ref")) {
        if (cwd === staging) {
          return {
            ...failedClone,
            stderr: "which is in the commit graph file but not in the object database",
          };
        }
        published.push(typeof options === "number" ? undefined : options.input);
        return successfulGit;
      }
      if (argv.includes("fetch")) {
        if (phase === "auth failure") {
          return { ...failedClone, stderr: "Authentication failed" };
        }
        return {
          ...successfulGit,
          cleanup: phase === "fetch" ? "uncertain" : undefined,
        };
      }
      throw new Error("unexpected refresh Git command");
    });
    const remove = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (location, options) => {
      if (phase === "cleanup failure" && location === staging) {
        throw cleanupFailure;
      }
      return remove(location, options);
    });

    const error = await capture(refreshProjectCheckout({ target, url: projectUrl }));

    if (!staging) {
      throw new Error("refresh did not initialize its staging directory");
    }
    if (phase === "fetch" || phase === "repair" || phase === "inventory") {
      expect(hasCommandProcessCleanupError(error)).toBe(true);
      if (phase === "repair") {
        expect(error).toHaveProperty("cause", failure);
      }
      expect(published).toEqual([]);
      await expectFile(path.join(staging, "partial.txt"), "owned staging data");
    } else if (phase === "cleanup failure") {
      expect(error).toBe(cleanupFailure);
      expect(published).toEqual([`update refs/remotes/origin/main ${pinnedCommit}\n`]);
    } else {
      expect(published).toEqual(
        phase === "success" ? [`update refs/remotes/origin/main ${pinnedCommit}\n`] : [],
      );
      if (phase === "success") {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(ProjectCloneError);
        expect(error).toHaveProperty("failure", "auth_required");
      }
      await expectMissing(staging);
    }
  },
);

it.each(["uncertain", "present", "absent"] as const)(
  "observes the remote head when its outcome is %s",
  async (outcome) => {
    mockGit().mockResolvedValue({
      ...successfulGit,
      stdout: outcome === "absent" ? "" : `${pinnedCommit}\trefs/heads/main\n`,
      ...(outcome === "uncertain" ? { cleanup: "uncertain" } : {}),
    });
    const observed = readProjectCheckoutRemoteHead({
      target: dirs.make("openclaw-head-cleanup-"),
      url: projectUrl,
      branch: "main",
    });

    if (outcome === "uncertain") {
      await expect(observed).rejects.toBeInstanceOf(CommandProcessCleanupError);
    } else {
      await expect(observed).resolves.toBe(outcome === "present" ? pinnedCommit : undefined);
    }
  },
);
