import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createFileMutationClock } from "./file-mutation-clock.test-support.js";
import * as fsSafe from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";
import { linkUpdateCandidatePluginTrees } from "./update-retained-runtime-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectText(file: string, text = "inventoried plugin bytes") {
  expect(await fs.readFile(file, "utf8")).toBe(text);
}

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function link(target: string, file: string, type?: fsSync.symlink.Type) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.symlink(target, file, type);
}

type Stat = fsSync.BigIntStats;
function sameStatFields(actual: Stat, expected: Stat, fields: (keyof Stat)[]) {
  expect(actual).toMatchObject(Object.fromEntries(fields.map((key) => [key, expected[key]])));
}

async function fixture(hardlink = false, beforePlan?: (source: string) => Promise<void>) {
  const root = await fs.realpath(dirs.make("candidate-plugin-copy-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "snapshot");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "plugin");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  const file = path.join(source, "payload.txt");
  await fs.writeFile(file, "inventoried plugin bytes");
  await fs.chmod(file, 0o444);
  if (hardlink) {
    await fs.link(file, `${file}.linked`);
  }
  await beforePlan?.(source);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return {
    file,
    copied: path.join(destination, "payload.txt"),
    capture: path.join(root, "native-capture"),
    destination,
    plan,
    retain: () =>
      linkUpdateCandidatePluginTrees(plan, {
        targetStateDir,
        candidateRoot,
        assertCurrent: () => {},
      }),
    copy: () => copyUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot }),
  };
}

type CopyIn = Awaited<ReturnType<typeof fsSafe.root>>["copyIn"];
function interceptCopies(wrap: (copy: CopyIn) => CopyIn) {
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await openRoot(...args);
    vi.spyOn(root, "copyIn").mockImplementation(wrap(root.copyIn.bind(root)));
    return root;
  });
}

function onceAtCopyBoundary(mutate: () => void, phase: "admission" | "mutation" = "mutation") {
  const mutation = vi.fn(mutate);
  const once = () => {
    if (!mutation.mock.calls.length) {
      mutation();
    }
  };
  interceptCopies((copyIn) => (relative, source, options) => {
    if (phase === "admission") {
      once();
      return copyIn(relative, source, options);
    }
    return copyIn(relative, source, {
      ...options,
      assertBeforeMutation: () => {
        once();
        options?.assertBeforeMutation?.();
      },
    });
  });
  return () => expect(mutation).toHaveBeenCalledOnce();
}

it.for([".MODULES.YAML", ".moduleſ.yaml"])(
  "discovers external stores through alias %s",
  async (alias, context) => {
    let store = "";
    const f = await fixture(false, async (source) => {
      store = path.join(path.dirname(source), "external-store");
      await fs.mkdir(store);
      await fs.writeFile(path.join(store, "entry.js"), "export const value = 1;");
      await fs.writeFile(path.join(source, alias), `virtualStoreDir: ${JSON.stringify(store)}\n`);
      const canonical = await fs
        .stat(path.join(source, ".modules.yaml"))
        .catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
      if (!canonical) {
        context.skip("Requires this metadata alias to resolve on the fixture filesystem");
      }
    });
    expect(f.plan.copies.map(([source]) => source)).toContain(store);
    expect(f.plan.entries.map((entry) => entry.path)).toContain(path.join(store, "entry.js"));
  },
);

it.each(["directory", "invalid YAML"])("rejects a listed .modules.yaml %s", async (kind) => {
  await expect(
    fixture(false, async (source) => {
      const manifest = path.join(source, ".modules.yaml");
      if (kind === "directory") {
        await fs.mkdir(manifest);
      } else {
        await fs.writeFile(manifest, "virtualStoreDir: [");
      }
    }),
  ).rejects.toThrow();
});

it.each(["auto", "off"] as const)(
  "isolates plugin bytes and modes with native copying %s",
  async (nativeMode) => {
    const metadataStat = vi.spyOn(fsSync, "lstatSync");
    const metadataRead = vi.spyOn(fs, "readFile");
    const f = await fixture(true, async (source) => {
      await fs.mkdir(path.join(source, "nested"));
      for (let index = 0; index < 8; index++) {
        await fs.writeFile(path.join(source, "nested", `${index}.txt`), `payload ${index}`);
      }
    });
    const source = path.dirname(f.file);
    expect(
      metadataStat.mock.calls.filter(([file]) => file === path.join(source, "package.json")),
    ).toHaveLength(0);
    expect(
      metadataRead.mock.calls.filter(([file]) => file === path.join(source, ".modules.yaml")),
    ).toHaveLength(0);
    const linked = `${f.file}.linked`;
    const before = await fs.stat(f.file, { bigint: true });
    const mkdir = vi.spyOn(fs, "mkdir");
    // FreeBSD has no native binding; "off" exercises the real portable fallback.
    vi.stubEnv("FS_SAFE_NATIVE_MODE", nativeMode);
    expect(getFsSafeNativeConfig().mode).toBe(nativeMode);
    await f.copy();
    expect(mkdir.mock.calls.length).toBeLessThanOrEqual(
      f.plan.entries.filter((entry) => entry.kind === "directory").length + 1,
    );
    for (let index = 0; index < 8; index++) {
      await expectText(path.join(f.destination, "nested", `${index}.txt`), `payload ${index}`);
    }
    const after = await fs.stat(f.file, { bigint: true });
    const snapshot = await fs.stat(f.copied, { bigint: true });
    await expectText(f.copied);
    await expectText(linked);
    sameStatFields(after, before, ["ino", "mode", "size", "mtimeNs", "ctimeNs"]);
    expect(snapshot.ino).not.toBe(before.ino);
    expect(snapshot.nlink).toBe(1n);
    if (process.platform !== "win32") {
      expect(snapshot.mode & 0o777n).toBe(0o444n);
    }
    expect((await fs.readdir(f.destination)).toSorted()).toEqual([
      "nested",
      "payload.txt",
      "payload.txt.linked",
    ]);
    await fs.chmod(f.copied, 0o600);
    await fs.writeFile(f.copied, "private candidate changes");
    await expectText(f.file);
    await expectText(linked);
    expect((await fs.stat(f.file, { bigint: true })).mode).toBe(before.mode);
    expect((await fs.stat(linked, { bigint: true })).mode).toBe(before.mode);
  },
);

it.each(["file", "symlink"] as const)(
  "preserves a %s inserted before copy admission",
  async (kind) => {
    const f = await fixture();
    const target = f.copied;
    const expectInserted = onceAtCopyBoundary(() => {
      if (kind === "file") {
        fsSync.writeFileSync(target, "existing private bytes", { flag: "wx" });
      } else {
        fsSync.symlinkSync(f.file, target);
      }
    }, "admission");
    await expect(f.copy()).rejects.toThrow();
    expectInserted();
    expect(await fs.readdir(f.destination)).toEqual(["payload.txt"]);
    await expectText(f.file);
    if (kind === "file") {
      await expectText(target, "existing private bytes");
    } else {
      expect(await fs.readlink(target)).toBe(f.file);
    }
  },
);

it.each([
  "mode",
  "same-size content with changed mtime",
  "same-size content with restored mtime",
  "identity",
] as const)("rejects %s mutation before exposing bytes", async (change) => {
  const advanceCtime = createFileMutationClock();
  const f = await fixture(false, async (source) => {
    // Use a representable time so restored-mtime coverage cannot pass on rounding.
    await fs.utimes(path.join(source, "payload.txt"), 1_700_000_000, 1_700_000_000);
  });
  const expectMutated = onceAtCopyBoundary(() => {
    if (change === "identity") {
      fsSync.renameSync(f.file, `${f.file}.original`);
      fsSync.writeFileSync(f.file, "inventoried plugin bytes", { mode: 0o444 });
    } else if (change === "mode") {
      fsSync.chmodSync(f.file, 0o600);
    } else {
      const before = fsSync.lstatSync(f.file, { bigint: true });
      fsSync.chmodSync(f.file, 0o600);
      fsSync.writeFileSync(f.file, "altered but equal bytes!");
      fsSync.chmodSync(f.file, 0o444);
      // A same-tick rewrite can retain its timestamps; force a real fingerprint change.
      fsSync.utimesSync(
        f.file,
        before.atime,
        change === "same-size content with restored mtime"
          ? before.mtime
          : new Date(before.mtime.getTime() + 60_000),
      );
      advanceCtime(before);
      const changed = fsSync.lstatSync(f.file, { bigint: true });
      expect(changed.ctimeNs).not.toBe(before.ctimeNs);
      sameStatFields(changed, before, ["dev", "ino", "size", "mode"]);
      expect(changed.mtimeNs === before.mtimeNs).toBe(
        change === "same-size content with restored mtime",
      );
    }
  });
  await expect(f.copy()).rejects.toThrow("changed after snapshot inventory");
  expectMutated();
  expect(await fs.readdir(f.destination)).toEqual([]);
});

it.each(["copy", "retain"] as const)(
  "allows inventoried hard-link add/remove/round-trip during %s",
  async (materialize) => {
    const advanceCtime = createFileMutationClock();
    for (const change of ["add", "remove", "round-trip"]) {
      let capture = "";
      const f = await fixture(false, async (source) => {
        capture = path.join(path.dirname(source), "native-capture");
        if (change === "remove") {
          await fs.link(path.join(source, "payload.txt"), capture);
        }
      });
      const before = await fs.lstat(f.file, { bigint: true });
      if (change !== "remove") {
        await fs.link(f.file, capture);
      }
      if (change !== "add") {
        await fs.unlink(capture);
      }
      advanceCtime(before);
      const after = await fs.lstat(f.file, { bigint: true });
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      sameStatFields(after, before, [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "size",
        "birthtimeNs",
        "mtimeNs",
      ]);
      await f[materialize]();
      await expectText(f.copied);
    }
  },
);

it.each(["auto", "off"] as const)(
  "accepts concurrent hard-link capture with native copying %s",
  async (nativeMode) => {
    const f = await fixture();
    const expectLinked = onceAtCopyBoundary(() => {
      fsSync.linkSync(f.file, f.capture);
    });
    vi.stubEnv("FS_SAFE_NATIVE_MODE", nativeMode);
    await f.copy();
    expectLinked();
    await expectText(f.copied);
    expect((await fs.lstat(f.copied, { bigint: true })).ino).not.toBe(
      (await fs.lstat(f.file, { bigint: true })).ino,
    );
  },
);

it.each(["uid", "gid"] as const)("refuses changed inventoried ownership (%s)", async (field) => {
  const f = await fixture();
  const entry = f.plan.entries.find((item) => item.kind === "file");
  expect(entry?.kind).toBe("file");
  if (entry?.kind !== "file") {
    throw new Error("Missing inventoried file");
  }
  entry[field] = (BigInt(entry[field]) + 1n).toString();
  await expect(f.copy()).rejects.toThrow("changed after snapshot inventory");
});

it.skipIf(process.platform !== "linux")(
  "verifies bytes when Linux reports ctime as birthtime without statx",
  async () => {
    const advanceCtime = createFileMutationClock();
    // Compose with the clock implementations; the spies themselves are replaced below.
    const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
    const lstatSync = vi.mocked(fsSync.lstatSync).getMockImplementation()!;
    const fstatSync = vi.mocked(fsSync.fstatSync).getMockImplementation()!;
    const fallbackBirthtime = <T extends fsSync.Stats | fsSync.BigIntStats | undefined>(
      stat: T,
    ): T => {
      if (stat && "birthtimeNs" in stat) {
        stat.birthtimeNs = stat.ctimeNs;
      }
      return stat;
    };
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) =>
      fallbackBirthtime(await lstat(...args)),
    );
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) =>
      fallbackBirthtime(lstatSync(...args)),
    );
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) =>
      fallbackBirthtime(fstatSync(...args)),
    );
    for (const change of ["link", "content", "birthtime"] as const) {
      const f = await fixture(false, async (source) => {
        await fs.utimes(path.join(source, "payload.txt"), 1_700_000_000, 1_700_000_000);
      });
      const before = await fs.lstat(f.file, { bigint: true });
      await fs.link(f.file, f.capture);
      if (change === "content") {
        await fs.chmod(f.file, 0o600);
        await fs.writeFile(f.file, "altered but equal bytes!");
        await fs.chmod(f.file, 0o444);
        await fs.utimes(f.file, before.atime, before.mtime);
      } else if (change === "birthtime") {
        const entry = f.plan.entries.find((item) => item.kind === "file");
        if (entry?.kind !== "file") {
          throw new Error("Missing inventoried file");
        }
        entry.birthtimeNs = (BigInt(entry.birthtimeNs) - 1n).toString();
      }
      advanceCtime(before);
      expect((await fs.lstat(f.file, { bigint: true })).ctimeNs).not.toBe(before.ctimeNs);
      if (change === "link") {
        await f.copy();
        await expectText(f.copied);
      } else {
        await expect(f.copy()).rejects.toThrow("changed after snapshot inventory");
      }
    }
  },
);

it("drains concurrent file copies before reporting a failure or publishing links", async () => {
  const f = await fixture(false, async (source) => {
    for (let index = 0; index < 7; index++) {
      await fs.writeFile(path.join(source, `extra-${index}.txt`), `plugin bytes ${index}`);
    }
    await fs.symlink("payload.txt", path.join(source, "payload-link"), "file");
  });
  const peerEntered = createDeferredCore();
  const releasePeers = createDeferredCore();
  const firstFailure = createDeferredCore<unknown>();
  const started: string[] = [];
  const settled = new Set<string>();
  const inFlight: Promise<void>[] = [];
  let settledAtRejection: string[] = [];
  interceptCopies((copyIn) => (relative, source, options) => {
    const first = started.length === 0;
    started.push(relative);
    if (started.length === 2) {
      peerEntered.resolve();
    }
    const copying = (async () => {
      try {
        await peerEntered.promise;
        if (first) {
          await fs.writeFile(path.join(f.destination, path.basename(relative)), "existing bytes", {
            flag: "wx",
          });
        } else {
          await releasePeers.promise;
        }
        await copyIn(relative, source, options);
        if (first) {
          throw new Error("Expected the real copy to reject its occupied destination");
        }
      } catch (error) {
        if (first) {
          firstFailure.resolve(error);
        }
        throw error;
      } finally {
        settled.add(relative);
      }
    })();
    inFlight.push(copying);
    return copying;
  });
  const copying = f.copy().catch((error: unknown) => {
    settledAtRejection = [...settled];
    return error;
  });
  try {
    const failure = await Promise.race([firstFailure.promise, copying]);
    releasePeers.resolve();
    expect(await copying).toBe(failure);
    expect(failure).toMatchObject({ code: "already-exists" });
    expect(started.length).toBeGreaterThan(1);
    expect(started.length).toBeLessThanOrEqual(4);
    expect(settledAtRejection.toSorted()).toEqual(started.toSorted());
    expect((await fs.readdir(f.destination)).toSorted()).toEqual(
      started.map((file) => path.basename(file)).toSorted(),
    );
    await expectText(path.join(f.destination, path.basename(started[0]!)), "existing bytes");
  } finally {
    peerEntered.resolve();
    releasePeers.resolve();
    await Promise.allSettled(inFlight);
    await copying;
  }
});

it.each(["inventory", "bindings", "admission", "completion", "verification"] as const)(
  "settles bounded %s reads before a metadata failure reaches cleanup",
  async (phase) => {
    const peerEntered = createDeferredCore();
    const releasePeers = createDeferredCore();
    const failure = new Error("plugin metadata unavailable");
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    let activeAtRejection: number | undefined;
    let selectedDirectory = "";
    let enabled = phase === "inventory" || phase === "bindings" || phase === "admission";
    const intercept = async <T>(file: unknown, read: () => Promise<T>): Promise<T> => {
      if (
        !enabled ||
        typeof file !== "string" ||
        path.dirname(file) !== selectedDirectory ||
        !path.basename(file).startsWith("read-")
      ) {
        return await read();
      }
      started.push(file);
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (started.length === 1) {
          await read();
          throw failure;
        }
        peerEntered.resolve();
        await releasePeers.promise;
        return await read();
      } finally {
        active -= 1;
      }
    };
    const installReadSpy = () => {
      if (phase === "bindings") {
        const realpath = fs.realpath;
        vi.spyOn(fs, "realpath").mockImplementation((...args) =>
          intercept(args[0], () => realpath(...args)),
        );
      } else {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation((...args) =>
          intercept(args[0], () => lstat(...args)),
        );
      }
    };
    const preparing = fixture(false, async (source) => {
      selectedDirectory = source;
      for (let index = 0; index < 9; index += 1) {
        const file = path.join(source, `read-${index}.txt`);
        if (phase === "bindings") {
          await fs.symlink("payload.txt", file);
        } else {
          await fs.writeFile(file, `plugin payload ${index}`);
        }
      }
      if (phase === "completion") {
        await fs.symlink("payload.txt", path.join(source, "copy-complete"));
      }
      if (phase === "inventory") {
        installReadSpy();
      }
    });
    const operation = (async () => {
      const f = await preparing;
      if (phase !== "inventory") {
        installReadSpy();
      }
      if (phase === "completion") {
        const symlink = fs.symlink;
        vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
          const result = await symlink(...args);
          if (args[1] === path.join(f.destination, "copy-complete")) {
            enabled = true;
          }
          return result;
        });
      } else if (phase === "verification") {
        selectedDirectory = f.destination;
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation((...args) => {
          if (args[0] === f.destination) {
            enabled = true;
          }
          return readdir(...args);
        });
      }
      await f.copy();
    })().catch((error: unknown) => {
      activeAtRejection = active;
      return error;
    });
    try {
      await awaitGateBeforeSettlement(
        peerEntered.promise,
        operation,
        "metadata reads did not overlap before rejection",
      );
      expect(activeAtRejection).toBeUndefined();
      releasePeers.resolve();
      expect(await operation).toBe(failure);
      expect(activeAtRejection).toBe(0);
      expect(started.length).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(4);
    } finally {
      releasePeers.resolve();
      await operation;
    }
  },
);

it("copies a linked workspace dependency without reading or changing Git update transactions", async () => {
  let dependency = "";
  let abandoned = "";
  let rollback = "";
  const sdkLink = "../../../../packages/plugin-sdk";
  const transaction = (name: string, id: string) => `${name}.openclaw-update-${id}.tmp`;
  const required = transaction("store", "00000000-0000-4000-8000-000000000011");
  const f = await fixture(false, async (source) => {
    const workspace = path.join(path.dirname(source), "workspace");
    dependency = path.join(workspace, "extensions", "a2a");
    const sdk = path.join(workspace, "packages", "plugin-sdk");
    await write(path.join(sdk, "package.json"), '{"name":"@openclaw/plugin-sdk"}');
    await write(path.join(dependency, "package.json"), '{"name":"workspace-dependency"}');
    await write(path.join(dependency, "data.txt"), "live dependency");
    await link(sdkLink, path.join(dependency, "node_modules", "@openclaw", "plugin-sdk"));
    await link(dependency, path.join(source, "node_modules", "workspace-dependency"), "junction");

    // Promotion links describe the final destination, not the intermediate candidate directory.
    abandoned = path.join(
      dependency,
      transaction("node_modules", "00000000-0000-4000-8000-000000000009"),
    );
    const stagedSdk = path.join(abandoned, "candidate", "@openclaw", "plugin-sdk");
    await link(sdkLink, stagedSdk);
    rollback = path.join(dependency, transaction("dist", "00000000-0000-4000-8000-000000000010"));
    await write(path.join(rollback, "previous", "keep.txt"), "rollback bytes");
    await write(path.join(dependency, "ordinary.tmp", "asset.txt"), "plugin asset");
    await write(path.join(source, required, "required.txt"), "explicit dependency");
    await fs.symlink(path.join(required, "required.txt"), path.join(source, "required.txt"));
  });
  await f.copy();
  await expectText(path.join(f.destination, "required.txt"), "explicit dependency");
  const copied = path.join(f.destination, "node_modules", "workspace-dependency");
  await expectText(path.join(copied, "data.txt"), "live dependency");
  await expectText(path.join(copied, "ordinary.tmp", "asset.txt"), "plugin asset");
  expect(await fs.readdir(copied)).not.toContain(path.basename(abandoned));
  expect(await fs.readdir(copied)).not.toContain(path.basename(rollback));
  expect(await fs.readlink(path.join(abandoned, "candidate", "@openclaw", "plugin-sdk"))).toBe(
    sdkLink,
  );
  await expectText(path.join(rollback, "previous", "keep.txt"), "rollback bytes");
  await fs.writeFile(path.join(copied, "data.txt"), "private candidate data");
  await expectText(path.join(dependency, "data.txt"), "live dependency");
});

it("still rejects a missing dependency beneath node_modules.openclaw-update-operator.tmp", async () => {
  await expect(
    fixture(false, async (source) => {
      const nested = path.join(source, "node_modules.openclaw-update-operator.tmp");
      await fs.mkdir(nested);
      await fs.symlink(
        path.join(path.dirname(source), "missing-dependency"),
        path.join(nested, "required"),
      );
    }),
  ).rejects.toThrow("Cannot privately copy plugin dependency");
});
