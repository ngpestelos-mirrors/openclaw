// Controlled service/compiler responses; the published shell, candidate CLI and transaction stay real.
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.LEGACY_FIXTURE_ROOT;
const source = process.env.LEGACY_FIXTURE_SOURCE;
const mode = process.env.LEGACY_FIXTURE_MODE;
const self = import.meta.url;
export const event = (name) => fs.appendFileSync(path.join(root, "events"), `${name}\n`);
const running = () => !fs.existsSync(path.join(root, "stopped"));
export function readState(_service, options = {}) {
  const sibling = options.env?.OPENCLAW_PROFILE === "sibling";
  const selectedRoot =
    ["disjoint", "sibling"].includes(mode) && !sibling ? path.join(root, "foreign") : root;
  return {
    env: { ...process.env, OPENCLAW_PROFILE: sibling ? "sibling" : "selected" },
    command: {
      programArguments: [process.execPath, path.join(selectedRoot, "dist/entry.js"), "gateway"],
    },
    running: running(),
    installed: true,
    loadState: { status: "loaded" },
    runtime: {
      status: running() ? "running" : "stopped",
      pid: running() ? process.pid : undefined,
    },
  };
}
export async function inspect() {
  if (["disjoint", "sibling", "unavailable"].includes(mode)) return null;
  return {
    ...readState(),
    verdict: { kind: "owned", root, fingerprint: "original", refreshDefinition: false },
  };
}
export async function stop(params) {
  assert.equal(params.expectedService.serviceUpdateVerdict.fingerprint, "original");
  assert.equal(params.expectedService.serviceEnv.OPENCLAW_PROFILE, "selected");
  event("stop");
  fs.writeFileSync(path.join(root, "stopped"), "stopped");
  if (mode === "partial-stop" || mode === "native-unjoined") {
    params.onStopped({
      stopped: true,
      serviceEnv: readState().env,
      serviceUpdateVerdict: params.expectedService.serviceUpdateVerdict,
    });
    if (mode === "native-unjoined") {
      const { CommandProcessCleanupError } = await import(
        pathToFileURL(path.join(source, "src/process/exec-result.ts")).href
      );
      throw new CommandProcessCleanupError();
    }
    throw new Error("fixture stop rejected after native mutation");
  }
  const mutationAbort = mode.startsWith("begin-")
    ? new (
        await import(
          pathToFileURL(path.join(source, "src/cli/update-cli/update-command-windows-task.ts")).href
        )
      ).UpdateCommandAbort()
    : undefined;
  let restored = false;
  return {
    stopped: true,
    serviceEnv: readState().env,
    serviceUpdateVerdict: params.expectedService.serviceUpdateVerdict,
    windowsTaskAutoStartRecovery: {
      assertRecoveryCurrent() {
        if (["begin-closed", "begin-delegated", "begin-lost"].includes(mode)) {
          throw new Error(`fixture recovery ${mode.slice(6)}`);
        }
      },
      beginMutation() {
        event("mutation");
        if (mutationAbort) throw mutationAbort;
      },
      async restore(safe, guard) {
        if (["begin-closed", "begin-delegated"].includes(mode)) return;
        if (mode === "begin-lost") throw new Error("fixture recovery lost");
        assert.equal(safe, true);
        await guard();
        if (!restored) {
          restored = true;
          event("enable");
          if (mode === "enable-failure") throw new Error("fixture enable failed after dispatch");
        }
      },
      async complete(safe) {
        event(`complete:${safe}`);
        if (!safe && restored) event("disable");
        if (mode === "build-throw-settle") throw new Error("fixture native completion failed");
      },
      interrupted: () => mode === "begin-abort" || mode === "begin-unjoined",
    },
  };
}

const exportsFromSelf = (names) => `export { ${names} } from ${JSON.stringify(self)};`;
const modules = new Map([
  [
    "src/cli/update-cli/update-command-service-plan",
    exportsFromSelf("inspect as readManagedGatewayServiceForUpdate") +
      `export const observedSystemdManagerUid = () => undefined;
    export function assertGatewayServiceAdmissionUnchanged(before, verdict) {
      if (before.serviceUpdateVerdict.fingerprint !== verdict.fingerprint) throw new Error('native fingerprint changed');
    }`,
  ],
  [
    "src/cli/update-cli/update-command-service-maintenance",
    exportsFromSelf("stop as maybeStopManagedServiceBeforeMutableUpdate") +
      `
    export const createWindowsTaskAutoStartGuard = ({root, before}) => async () => {
      if (before.serviceUpdateVerdict.root !== root) throw new Error('wrong restoration root');
    };
    export const maybeResumeWindowsTaskAutoStartAfterPackageUpdate = (state, safe, guard) => state.windowsTaskAutoStartRecovery?.restore(safe, guard);`,
  ],
  [
    "src/cli/update-cli/update-command-service-revalidation",
    `export async function revalidateManagedGatewayServiceAfterUpdate({preManagedServiceStop}) { return ${JSON.stringify(mode)} === 'drift' ? {...preManagedServiceStop.serviceUpdateVerdict, fingerprint:'replacement'} : preManagedServiceStop.serviceUpdateVerdict; }`,
  ],
  [
    "src/daemon/service",
    exportsFromSelf("readState as readGatewayServiceState") +
      "export const resolveGatewayService = () => ({});",
  ],
  [
    "src/daemon/managed-gateway-bindings",
    `export const discoverManagedGatewayBindings = async () => ${JSON.stringify(mode === "sibling" ? [{ profile: "sibling", env: { OPENCLAW_PROFILE: "sibling" } }] : [])};`,
  ],
]);
const memoryUrl = pathToFileURL(path.join(source, "scripts/lib/process-memory.mts")).href;
// The compiler is synthetic; its capacity must not depend on other CI workers.
modules.set(
  "scripts/lib/process-memory",
  `import { readProcessMemoryCapacity as actual } from ${JSON.stringify(memoryUrl + "?original")};
  export function readProcessMemoryCapacity() {
    const bytes = 16 * 1024 ** 3;
    return actual({
      cgroupMemoryLimitBytes: bytes,
      procMemTotalBytes: bytes,
      availableMemoryBytes: bytes,
    });
  }`,
);
const managedUrl = pathToFileURL(path.join(source, "scripts/lib/managed-child-process.mts")).href;
const compilerResponse = `
  export * from ${JSON.stringify(managedUrl + "?original")};
  import { runManagedCommand as actual } from ${JSON.stringify(managedUrl + "?original")};
  import fs from 'node:fs';
  import path from 'node:path';
  import { event } from ${JSON.stringify(self)};
  let invoked = false;
  export async function runManagedCommand(options) {
    if (options.bin === 'bash') {
      if (${JSON.stringify(mode)} === 'begin-unjoined') {
        event('restart-unjoined');
        const { CommandProcessCleanupError } = await import(${JSON.stringify(pathToFileURL(path.join(source, "src/process/exec-result.ts")).href)});
        throw new CommandProcessCleanupError();
      }
      return actual(options);
    }
    if (!invoked) {
      invoked = true;
      event('build');
      if (${JSON.stringify(mode)} === 'unjoined') throw Object.assign(new Error('fixture writers unjoined'), {processTreeState:'indeterminate'});
      fs.writeFileSync(path.join(${JSON.stringify(root)}, 'dist/entry.js'), 'new runtime\\n');
      fs.writeFileSync(path.join(${JSON.stringify(root)}, 'build-env.json'), JSON.stringify({
        npm_execpath: options.env?.npm_execpath,
        workspace: options.env?.NPM_CONFIG_WORKSPACE_DIR,
      }));
      if (${JSON.stringify(mode)} === 'build-throw-restore') {
        fs.rmSync(path.join(${JSON.stringify(root)}, 'dist'), {recursive:true, force:true});
        fs.symlinkSync(path.join(${JSON.stringify(root)}, 'foreign/dist'), path.join(${JSON.stringify(root)}, 'dist'));
      }
      if (${JSON.stringify(mode)}.startsWith('build-throw-')) throw new Error('fixture compiler rejected');
    }
    return ${JSON.stringify(mode)} === 'failure' ? 17 : 0;
  }`;
modules.set("scripts/lib/managed-child-process", compilerResponse);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.includes("?original")) return next(specifier, context);
    const candidate =
      specifier.startsWith(".") && context.parentURL
        ? new URL(specifier, context.parentURL).href
        : specifier;
    for (const [name, body] of modules) {
      const stem = pathToFileURL(path.join(source, name)).href;
      if ([".js", ".ts", ".mts"].some((extension) => candidate === stem + extension)) {
        return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});
