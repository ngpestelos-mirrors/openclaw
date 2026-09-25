import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { isSqliteLockError } from "../infra/sqlite-error-diagnostics.js";
import {
  acquireSqliteStagingToken,
  SQLITE_STAGING_TOKEN_FILES,
  type SqliteStagingToken,
} from "../infra/sqlite-staging-token.js";
import { removeTemporaryArtifacts } from "../infra/temp-artifact-cleanup.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runInPluginSourceCaptureContext } from "./plugin-source-capture-context.js";
import {
  isLegacyPluginSourceCaptureName,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
} from "./plugin-source-capture-path.js";

const CAPTURE_GRACE_MS = 60 * 60 * 1_000;

type Instance = {
  references: number;
  closing?: boolean;
  timer: ReturnType<typeof setInterval>;
  root?: string;
  managedRoot?: string;
  token?: SqliteStagingToken;
};
const { instances, ownedRoots, sweeps, warningBackoff } = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSourceCaptureInstances"),
  () => {
    process.once("exit", () => {
      // Explicit exits cannot await generation disposal. These captures belong
      // only to this exiting process; worker overrides remain with their parent.
      for (const [key, instance] of instances) {
        try {
          const root = retireInstance(key, instance);
          if (root) {
            removeInstanceSync(root);
          }
        } catch (error) {
          process.stderr.write(`Plugin source capture exit cleanup failed: ${String(error)}\n`);
        }
      }
    });
    return {
      instances: new Map<string, Instance>(),
      ownedRoots: new Set<string>(),
      sweeps: new Map<string, Promise<void>>(),
      warningBackoff: new Map<string, { next: number; delay: number }>(),
    };
  },
);

function retireInstance(key: string, instance: Instance): string | undefined {
  instance.closing = true;
  let removalRoot = instance.root;
  // Keep the exact native token available if retirement or close needs a retry.
  try {
    instance.token?.(true);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // Enclosing state can disappear before deferred disposal. Missing ownership
    // permits closing our handle, never deleting residual or replacement files.
    instance.token?.();
    removalRoot = undefined;
  }
  if (instance.root) {
    ownedRoots.delete(instance.root);
  }
  instance.references = 0;
  instances.delete(key);
  clearInterval(instance.timer);
  return removalRoot;
}

function instanceDirectory(stateDir: string): string {
  return path.join(stateDir, "tmp", "plugin-captures");
}

function warn(error: unknown) {
  process.emitWarning(`Plugin source capture cleanup: ${String(error)}`);
}

/** Reclamation owns an existing native token until its captured payload is gone. */
async function reclaimInstance(directory: string, originalDirectory: fs.Stats): Promise<void> {
  const ownerPath = path.join(directory, SQLITE_STAGING_TOKEN_FILES[0]);
  const family = SQLITE_STAGING_TOKEN_FILES.map((file) =>
    fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
  );
  const originalOwner = family[0];
  const captures = path.join(directory, "captures");
  const captured = fs.lstatSync(captures, { throwIfNoEntry: false });
  if (
    (process.getuid && originalDirectory.uid !== process.getuid()) ||
    !originalOwner ||
    family.some(
      (file) =>
        file &&
        (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())),
    ) ||
    (captured && !captured.isDirectory())
  ) {
    return;
  }
  const unchanged = () => {
    const currentDirectory = fs.lstatSync(directory);
    const currentOwner = fs.lstatSync(ownerPath);
    return (
      currentDirectory.dev === originalDirectory.dev &&
      currentDirectory.ino === originalDirectory.ino &&
      currentDirectory.isDirectory() &&
      currentOwner.isFile() &&
      currentOwner.nlink === 1 &&
      currentOwner.dev === originalOwner.dev &&
      currentOwner.ino === originalOwner.ino
    );
  };
  // Reclaim refuses a missing token and never creates a replacement ownership database.
  const release = acquireSqliteStagingToken(directory, "reclaim");
  let released = false;
  ownedRoots.add(directory);
  try {
    if (!unchanged()) {
      return;
    }
    await fsPromises.rm(captures, { recursive: true, force: true });
    release(true);
    released = true;
    // The shipped instance ID is never reused. Windows requires closing before unlink.
    if (unchanged()) {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  } finally {
    try {
      if (!released) {
        release();
      }
    } finally {
      ownedRoots.delete(directory);
    }
  }
}

function removeInstanceSync(root: string): void {
  // A sharing violation must leave the custody token beside any retained payload.
  fs.rmSync(path.join(root, "captures"), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}

async function reclaimInstances(
  root: string,
  recordFailure: (error: unknown) => void,
  legacy = false,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return;
  }
  if (entries.length === 0) {
    return;
  }
  const cutoff = Date.now() - CAPTURE_GRACE_MS;
  let legacyAllowed: boolean | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || (legacy && !isLegacyPluginSourceCaptureName(entry.name))) {
      continue;
    }
    const directory = path.join(root, entry.name);
    try {
      const stat = await fsPromises.lstat(directory);
      const changed = legacy
        ? Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs)
        : stat.mtimeMs;
      if (!stat.isDirectory() || changed > cutoff) {
        continue;
      }
      const canonical = await fsPromises.realpath(directory);
      if (ownedRoots.has(canonical)) {
        continue;
      }
      const tokenPath = path.join(canonical, SQLITE_STAGING_TOKEN_FILES[0]);
      const tokenStat = await fsPromises.lstat(tokenPath).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return undefined;
      });
      if (legacy && tokenStat) {
        continue;
      }
      if (!tokenStat) {
        if (legacy) {
          if (legacyAllowed === undefined) {
            const { inspectOtherOpenClawProcesses } =
              await import("../infra/openclaw-process-census.js");
            const census = inspectOtherOpenClawProcesses();
            legacyAllowed = "error" in census || census.pids.length === 0;
          }
          if (!legacyAllowed) {
            continue;
          }
        }
        // Legacy writers have no token. Probe for Windows sharing violations before
        // removing aged scratch; retain the recognizable name if removal is interrupted.
        const retired = path.join(
          root,
          `${legacy ? PLUGIN_SOURCE_CAPTURE_PREFIX : ""}${randomUUID()}`,
        );
        await fsPromises.rename(canonical, retired);
        await fsPromises.rm(retired, { recursive: true, force: true });
        continue;
      }
      await reclaimInstance(canonical, stat);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !isSqliteLockError(error)) {
        recordFailure(error);
      }
    }
  }
}

/** Coalesce active scans, but throttle diagnostics independently of cleanup retries. */
export function sweepPluginSourceCaptureDirectories(stateDir = resolveStateDir()): Promise<void> {
  const root = path.resolve(instanceDirectory(stateDir));
  let sweep = sweeps.get(root);
  if (!sweep) {
    let failures = 0;
    let firstFailure: unknown;
    const recordFailure = (error: unknown) => {
      if (failures++ === 0) {
        firstFailure = error;
      }
    };
    sweep = reclaimInstances(root, recordFailure)
      .catch(recordFailure)
      .then(async () => {
        const visited = new Set<string>();
        for (const candidate of [path.join(stateDir, "tmp"), tmpdir()]) {
          try {
            const directory = await fsPromises.realpath(candidate);
            if (!visited.has(directory)) {
              visited.add(directory);
              await reclaimInstances(directory, recordFailure, true);
            }
          } catch (error) {
            if (!hasErrnoCode(error, "ENOENT")) {
              recordFailure(error);
            }
          }
        }
      })
      .then(() => {
        if (failures === 0) {
          warningBackoff.delete(root);
          return;
        }
        const now = Date.now();
        const previous = warningBackoff.get(root);
        if (previous && now < previous.next) {
          return;
        }
        const delay = Math.min(
          (previous?.delay ?? CAPTURE_GRACE_MS / 2) * 2,
          24 * CAPTURE_GRACE_MS,
        );
        // Bound diagnostics for processes that inspect many independent profiles.
        if (!previous && warningBackoff.size >= 32) {
          const oldest = warningBackoff.keys().next().value;
          if (oldest !== undefined) {
            warningBackoff.delete(oldest);
          }
        }
        warningBackoff.set(root, { next: now + delay, delay });
        warn(
          `${failures} cleanup failure(s) in ${root}; will retry. First: ${String(firstFailure)}`,
        );
      })
      .finally(() => sweeps.delete(root));
    sweeps.set(root, sweep);
  }
  return sweep;
}

function createCaptureDirectory(instance: Instance, stateDir: string, prefix: string): string {
  if (instance.root) {
    return fs.mkdtempSync(path.join(instance.root, "captures", prefix));
  }
  const prepare = (fallback: boolean): string => {
    let directory: string | undefined;
    let token: SqliteStagingToken | undefined;
    try {
      if (fallback) {
        directory = fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-captures-"));
      } else {
        const parent = instanceDirectory(stateDir);
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        instance.managedRoot = fs.realpathSync(parent);
        const candidate = path.join(instance.managedRoot, randomUUID());
        fs.mkdirSync(candidate, { mode: 0o700 });
        directory = candidate;
      }
      const canonical = fs.realpathSync(directory);
      token = acquireSqliteStagingToken(canonical, "create");
      const captures = path.join(canonical, "captures");
      fs.mkdirSync(captures, { mode: 0o700 });
      const capture = fs.mkdtempSync(path.join(captures, prefix));
      instance.root = canonical;
      instance.token = token;
      ownedRoots.add(canonical);
      return capture;
    } catch (error) {
      try {
        token?.(true);
      } catch (releaseError) {
        instance.root = directory;
        instance.token = token;
        instance.closing = true;
        if (directory) {
          ownedRoots.add(directory);
        }
        throw new AggregateError(
          [error, releaseError],
          "Plugin source preparation cleanup failed",
          {
            cause: releaseError,
          },
        );
      }
      if (directory) {
        try {
          removeInstanceSync(directory);
        } catch (cleanupError) {
          warn(cleanupError);
        }
      }
      throw error;
    }
  };
  try {
    return prepare(false);
  } catch (error) {
    if (instance.closing) {
      throw error;
    }
    // The fallback covers the whole allocation, including the token and first capture.
    // Fallback instances have ordinary disposal, but no cross-instance automatic sweep.
    warn(error);
    return prepare(true);
  }
}

/** Metadata and its captures share custody; standalone CLI captures own their own lifetime. */
export function retainPluginSourceCaptureInstance(stateDir = resolveStateDir()) {
  const key = path.resolve(stateDir);
  let instance = instances.get(key);
  if (instance?.closing) {
    throw new Error(
      "Plugin source instance cleanup is incomplete; retry cleanup before creating captures",
    );
  }
  if (!instance) {
    const timer = runInPluginSourceCaptureContext(() =>
      setInterval(() => void sweepPluginSourceCaptureDirectories(key), CAPTURE_GRACE_MS),
    );
    timer.unref();
    instance = { references: 0, timer };
    instances.set(key, instance);
    void sweepPluginSourceCaptureDirectories(key);
  }
  instance.references += 1;
  const retained = instance;
  let released = false;
  const retire = () => {
    if (released) {
      return undefined;
    }
    if (retained.references > 1) {
      retained.references -= 1;
      released = true;
      return undefined;
    }
    const root = retireInstance(key, retained);
    released = true;
    return root;
  };
  return {
    get managedRoot() {
      return retained.managedRoot;
    },
    createDirectory(prefix = PLUGIN_SOURCE_CAPTURE_PREFIX) {
      if (released || retained.closing) {
        throw new Error("Plugin source instance has been released");
      }
      return createCaptureDirectory(retained, key, prefix);
    },
    release() {
      const root = retire();
      if (root) {
        removeInstanceSync(root);
      }
    },
    async releaseAsync() {
      const root = retire();
      if (root) {
        try {
          await fsPromises.rm(path.join(root, "captures"), { recursive: true, force: true });
          await fsPromises.rm(root, { recursive: true, force: true });
        } catch (error) {
          warn(error);
        }
      }
    },
  };
}

/** The producer retains this root until its worker has confirmed exit. */
export function createPluginSourceCaptureRoot(stateDir: string, prefix: string) {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    const directory = instance.createDirectory(prefix);
    return {
      directory,
      managedRoot: instance.managedRoot,
      release: async () => {
        await removeTemporaryArtifacts(directory, "Plugin source worker");
        await instance.releaseAsync();
      },
    };
  } catch (error) {
    instance.release();
    throw error;
  }
}
