import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { PreparedWorkerSsh } from "./ssh.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { runBoundedInboundRsync } from "./workspace-sync-helpers.js";
import { createWorkerWorkspaceRsyncTransport } from "./workspace-sync-transport.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

afterEach(() => vi.restoreAllMocks());

function result(code = 0): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function createPreparedSsh(): PreparedWorkerSsh {
  let selectedPort = 2222;
  return {
    sshTarget: "worker@example.test",
    scpTarget: "worker@example.test",
    host: "example.test",
    advertisedPorts: [2222, 22],
    get port() {
      return selectedPort;
    },
    identityPath: "/identity",
    knownHostsPath: "/known-hosts",
    selectPort(port) {
      selectedPort = port;
    },
    dispose: async () => {},
  };
}

function createWorkspaceActions(
  run: (argv: string[], options: CommandOptions) => Promise<SpawnResult>,
) {
  const prepared = createPreparedSsh();
  return createWorkerWorkspaceActions({
    bundleHash: "a".repeat(64),
    environmentId: "worker:test",
    ownerSignal: new AbortController().signal,
    waitForPrepared: async () => prepared,
    runner: { run },
    tasks: new Set(),
  });
}

describe("worker workspace command transport retry", () => {
  it.each(["never", "idempotent"] as const)(
    "does not dispatch a %s command after its turn closes during tunnel preparation",
    async (transportRetry) => {
      const run = vi.fn(async () => result());
      let current = true;
      const actions = createWorkerWorkspaceActions({
        bundleHash: "a".repeat(64),
        environmentId: "worker:test",
        ownerSignal: new AbortController().signal,
        waitForPrepared: async () => {
          await Promise.resolve();
          current = false;
          return createPreparedSsh();
        },
        runner: { run },
        tasks: new Set(),
      });
      await expect(
        actions.runWorkspaceCommand({
          argv: ["printf", "stale-attachment"],
          transportRetry,
          assertCurrent: () => {
            if (!current) {
              throw new Error("turn claim closed");
            }
          },
        }),
      ).rejects.toThrow("turn claim closed");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("runs never commands once without changing the selected port", async () => {
    // Pin the clock: the impl derives the dispatch timeout from a Date.now()
    // deadline, so real elapsed ms between admission and dispatch would turn
    // the exact 777 assertion below into a loaded-runner flake.
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const run = vi.fn(async (argv: string[], _options: CommandOptions) =>
      argv.at(-1)?.includes("never-command") ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "never",
        argv: ["printf", "never-command"],
        timeoutMs: 777,
      }),
    ).resolves.toMatchObject({ code: 255, termination: "exit" });
    expect(run).toHaveBeenCalledOnce();
    expect(sshArgvPort(run.mock.calls[0]![0])).toBe(2222);
    // The pinned clock makes the derived dispatch timeout deterministic; a
    // less-than bound would also accept zero and mask a broken deadline.
    expect(run.mock.calls[0]![1].timeoutMs).toBe(777);

    await actions.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["printf", "selection-probe"],
    });
    expect(sshArgvPort(run.mock.calls[1]![0])).toBe(2222);
  });

  it("retries idempotent commands and records the successful port", async () => {
    const run = vi.fn(async (argv: string[]) =>
      argv.at(-1)?.includes("retry-command") && sshArgvPort(argv) === 2222 ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["printf", "retry-command"],
      }),
    ).resolves.toEqual(result());
    expect(run.mock.calls.slice(0, 2).map(([argv]) => sshArgvPort(argv))).toEqual([2222, 22]);

    await actions.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["printf", "selected-port-probe"],
    });
    expect(sshArgvPort(run.mock.calls[2]![0])).toBe(22);
  });

  it("gives an idempotent fallback only the remaining operation timeout", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = vi.fn(async (argv: string[], _options: CommandOptions) => {
      if (sshArgvPort(argv) === 2222) {
        now += 175;
        return result(255);
      }
      return result();
    });
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["printf", "retry-with-deadline"],
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(result());
    expect(run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 825]);
    expect(run.mock.calls[0]![1]).not.toBe(run.mock.calls[1]![1]);
  });
});

describe("worker workspace rsync transport retry", () => {
  it("gives an outbound fallback only the remaining operation timeout", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runTask = vi.fn(async (argv: string[], _options: CommandOptions) => {
      if (rsyncArgvPort(argv) === 2222) {
        now += 200;
        return result(255);
      }
      return result();
    });
    const transport = createWorkerWorkspaceRsyncTransport({
      ownerSignal: new AbortController().signal,
      runTask,
      timeoutMs: 1_000,
    });

    await expect(
      transport.runRsync(createPreparedSsh(), (rsyncSsh) => [
        "rsync",
        "-e",
        rsyncSsh,
        "source",
        "worker:destination",
      ]),
    ).resolves.toEqual(result());
    expect(runTask.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 800]);
    expect(runTask.mock.calls[0]![1]).not.toBe(runTask.mock.calls[1]![1]);
  });

  it("gives an inbound fallback only the remaining operation timeout", async () => {
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rsync-budget-"));
    try {
      let now = 3_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const runTask = vi.fn(async (argv: string[], _options: CommandOptions) => {
        if (rsyncArgvPort(argv) === 2222) {
          now += 125;
          return result(255);
        }
        return result();
      });
      const transport = createWorkerWorkspaceRsyncTransport({
        ownerSignal: new AbortController().signal,
        runTask,
        timeoutMs: 1_000,
      });

      await expect(
        transport.runBoundedInboundRsync({
          prepared: createPreparedSsh(),
          argv: (rsyncSsh) => ["rsync", "-e", rsyncSsh, "worker:source", destinationRoot],
          destinationRoot,
          entryLimit: 1,
          totalByteLimit: 1,
        }),
      ).resolves.toEqual(result());
      expect(runTask.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 875]);
      expect(runTask.mock.calls[0]![1]).not.toBe(runTask.mock.calls[1]![1]);
    } finally {
      await fs.rm(destinationRoot, { recursive: true, force: true });
    }
  });
});

describe("bounded inbound workspace transfer", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["within", "bytes", "entries"] as const)(
    "continues the same quota scan after a listed leaf disappears (%s limit)",
    async (limit) => {
      const destinationRoot = await fs.realpath(tempDirs.make("openclaw-rsync-disappearance-"));
      const names = new Set([
        `${path.basename(destinationRoot)}-a`,
        `${path.basename(destinationRoot)}-b`,
      ]);
      await Promise.all(
        [...names].map((name) => fs.writeFile(path.join(destinationRoot, name), "data")),
      );
      const lstat = fsSync.lstatSync.bind(fsSync);
      let removed = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (!removed && names.has(path.basename(String(args[0])))) {
          fsSync.unlinkSync(args[0]);
          removed = true;
        }
        return lstat(...args);
      });

      const transfer = runBoundedInboundRsync({
        argv: ["rsync"],
        destinationRoot,
        entryLimit: limit === "entries" ? 1 : 10,
        totalByteLimit: limit === "bytes" ? 1 : 100,
        ownerSignal: new AbortController().signal,
        runTask: async () => result(),
        timeoutMs: 10_000,
      });
      if (limit === "within") {
        await expect(transfer).resolves.toEqual(result());
      } else {
        await expect(transfer).rejects.toThrow("inbound transfer exceeds");
      }
      expect(removed).toBe(true);
      expect(await fs.readdir(destinationRoot)).toHaveLength(1);
    },
  );

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "joins the writer before reporting a real directory read denial",
    async () => {
      const destinationRoot = tempDirs.make("openclaw-rsync-denied-");
      const unreadable = path.join(destinationRoot, "unreadable");
      await fs.mkdir(unreadable);
      await fs.writeFile(path.join(unreadable, "payload"), "data");
      await fs.chmod(unreadable, 0);
      const aborted = createDeferredCore();
      const releaseWriter = createDeferredCore();
      let writerSettled = false;
      let reported = false;
      const transfer = runBoundedInboundRsync({
        argv: ["rsync"],
        destinationRoot,
        entryLimit: 10,
        totalByteLimit: 100,
        ownerSignal: new AbortController().signal,
        runTask: async (_argv, { signal }) => {
          signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
          await releaseWriter.promise;
          writerSettled = true;
          throw new Error("transfer cancelled");
        },
        timeoutMs: 10_000,
      });
      const observed = transfer.finally(() => {
        reported = true;
      });
      void observed.catch(() => {});
      try {
        await withTestTimeout(
          aborted.promise,
          10_000,
          "directory read denial did not cancel transfer",
        );
        expect(reported).toBe(false);
        expect(writerSettled).toBe(false);
        releaseWriter.resolve();
        await expect(observed).rejects.toThrow(/denied/i);
        expect(writerSettled).toBe(true);
      } finally {
        releaseWriter.resolve();
        await observed.catch(() => {});
        await fs.chmod(unreadable, 0o700);
      }
    },
  );

  it.each(["root", "nested"] as const)(
    "rejects a replaced %s directory instead of ignoring its missing leaf",
    async (scope) => {
      const parent = await fs.realpath(tempDirs.make("openclaw-rsync-replaced-"));
      const destinationRoot = path.join(parent, "destination");
      const current = scope === "root" ? destinationRoot : path.join(destinationRoot, "nested");
      await fs.mkdir(current, { recursive: true });
      const leaf = path.join(current, "temporary.json");
      await fs.writeFile(leaf, "data");
      const lstat = fsSync.lstatSync.bind(fsSync);
      let replaced = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        if (!replaced && args[0] === leaf) {
          fsSync.renameSync(current, path.join(parent, "previous"));
          fsSync.mkdirSync(current);
          replaced = true;
        }
        return lstat(...args);
      });

      await expect(
        runBoundedInboundRsync({
          argv: ["rsync"],
          destinationRoot,
          entryLimit: 10,
          totalByteLimit: 100,
          ownerSignal: new AbortController().signal,
          runTask: async () => result(),
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(/changed/);
      expect(replaced).toBe(true);
    },
  );

  it("counts symlinks as entries without following their targets", async () => {
    const parent = tempDirs.make("openclaw-rsync-symlink-");
    const destinationRoot = path.join(parent, "destination");
    const outside = path.join(parent, "outside");
    await fs.mkdir(destinationRoot);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "oversized"), "over quota");
    await fs.symlink(outside, path.join(destinationRoot, "link"), "junction");
    const transfer = (entryLimit: number) =>
      runBoundedInboundRsync({
        argv: ["rsync"],
        destinationRoot,
        entryLimit,
        totalByteLimit: 1,
        ownerSignal: new AbortController().signal,
        runTask: async () => result(),
        timeoutMs: 10_000,
      });
    await expect(transfer(1)).resolves.toEqual(result());
    await expect(transfer(0)).rejects.toThrow("inbound transfer exceeds");
  });

  it("aborts and joins a transfer before reporting a failed directory scan", async () => {
    vi.useFakeTimers();
    const destinationRoot = path.join(tempDirs.make("openclaw-rsync-scan-"), "missing");
    let transferSignal: AbortSignal | undefined;
    let settled = false;
    try {
      const operation = runBoundedInboundRsync({
        argv: ["rsync"],
        destinationRoot,
        entryLimit: 10,
        totalByteLimit: 100,
        ownerSignal: new AbortController().signal,
        runTask: async (_argv, { signal }) => {
          transferSignal = signal;
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          settled = true;
          throw new Error("transfer cancelled");
        },
        timeoutMs: 10_000,
      });
      const failed = expect(operation).rejects.not.toThrow("transfer cancelled");
      await vi.advanceTimersByTimeAsync(25);
      await failed;
      expect(transferSignal?.aborted).toBe(true);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight transfer when the destination crosses quota", async () => {
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rsync-quota-"));
    let transferSignal: AbortSignal | undefined;
    try {
      const runTask = vi.fn(async (_argv: string[], options: CommandOptions) => {
        transferSignal = options.signal;
        await fs.writeFile(path.join(destinationRoot, "oversized"), "over quota");
        return await new Promise<SpawnResult>((_resolve, reject) => {
          const abort = () => {
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) {
            abort();
          }
        });
      });

      await expect(
        runBoundedInboundRsync({
          argv: ["rsync"],
          destinationRoot,
          entryLimit: 10,
          totalByteLimit: 1,
          ownerSignal: new AbortController().signal,
          runTask,
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("inbound transfer exceeds");
      expect(transferSignal?.aborted).toBe(true);
    } finally {
      await fs.rm(destinationRoot, { recursive: true, force: true });
    }
  });

  it.each(["bytes", "entries"])(
    "rejects a completed transfer exceeding its %s quota",
    async (limit) => {
      const destinationRoot = tempDirs.make("openclaw-rsync-final-quota-");
      const runTask = async () => {
        await fs.writeFile(path.join(destinationRoot, "oversized"), "over quota");
        return result();
      };

      await expect(
        runBoundedInboundRsync({
          argv: ["rsync"],
          destinationRoot,
          entryLimit: limit === "entries" ? 0 : 10,
          totalByteLimit: limit === "bytes" ? 1 : 100,
          ownerSignal: new AbortController().signal,
          runTask,
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("inbound transfer exceeds");
    },
  );
});
