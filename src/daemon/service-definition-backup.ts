import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import {
  readScheduledTaskDefinition,
  restoreScheduledTaskDefinition,
} from "./schtasks-install-files.js";
import { resolveTaskScriptPath, setScheduledTaskXmlEnabled } from "./schtasks-layout.js";
import { readServiceFileState, type GatewayServiceDefinitionPublication } from "./service-stage.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
  type GatewayServiceEnv,
} from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";
import { reloadSystemdUserManager } from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import {
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";

export type GatewayServiceDefinitionBackup = {
  backupPaths: string[];
  seal: (publication: GatewayServiceDefinitionPublication | "original") => Promise<void>;
  restore: () => Promise<void>;
};

function definitionFiles(env: GatewayServiceEnv, command: GatewayServiceCommandConfig) {
  const environment = resolveManagedGatewayServiceCommand(command)?.environment;
  const renderEnv = { ...env, ...environment };
  if (process.platform === "linux") {
    return [
      resolveSystemdUnitPath(env),
      resolveSystemdEnvironmentFilePath({ stateDir: resolveStateDir(renderEnv), environment }),
    ];
  }
  if (process.platform === "darwin") {
    const label = resolveLaunchAgentLabel(env);
    return [
      resolveLaunchAgentPlistPath(env),
      resolveLaunchAgentEnvFilePath(env, label),
      resolveLaunchAgentEnvWrapperPath(env, label),
    ];
  }
  if (process.platform === "win32") {
    const script = resolveTaskScriptPath(renderEnv);
    const parsed = path.parse(script);
    return [...new Set([script, path.join(parsed.dir, `${parsed.name}.vbs`)])];
  }
  throw new Error("Managed service definition backup is unavailable on this platform.");
}

function taskPolicySha256(xml: string | null): string | null {
  return xml === null ? null : sha256Hex(setScheduledTaskXmlEnabled(xml, false));
}

/** Capture inside the installer's native operation lock, before another writer can enter. */
export async function readGatewayServiceDefinitionPublication(params: {
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig;
}): Promise<GatewayServiceDefinitionPublication> {
  const files = await Promise.all(
    definitionFiles(params.env, params.command).map(async (sourcePath) => ({
      sourcePath,
      after: await readServiceFileState(sourcePath),
    })),
  );
  const xml = process.platform === "win32" ? await readScheduledTaskDefinition(params.env) : null;
  if (!files[0]?.after || (process.platform === "win32" && xml === null)) {
    throw new Error(
      "The installed service definition is unavailable for publication verification.",
    );
  }
  return { files, taskPolicySha256: taskPolicySha256(xml) };
}

async function snapshotFile(file: string, managed: boolean) {
  const state = await readServiceFileState(file);
  const contents = managed && state ? await fs.readFile(file) : null;
  if (contents && sha256Hex(contents) !== state?.sha256) {
    throw new Error(`Service definition changed during backup: ${file}`);
  }
  return {
    file,
    expected: state,
    original: managed ? (state && contents ? { state, contents } : null) : undefined,
  };
}

/** Retain exact installer inputs; the caller owns the operation lock and native stop/start. */
export async function captureGatewayServiceDefinitionBackup(params: {
  env: GatewayServiceEnv;
  command: GatewayServiceCommandConfig;
  assertCurrent: () => void;
}): Promise<GatewayServiceDefinitionBackup> {
  const platform = process.platform;
  const assertCurrent = () => {
    params.assertCurrent();
    assertGatewayServiceUpdateCurrent();
  };
  assertCurrent();
  const files = definitionFiles(params.env, params.command);
  const primary = files[0]!;
  const source = params.command.sourcePath;
  if (source && path.resolve(source) !== path.resolve(primary)) {
    throw new Error(`Service definition is not the managed rewrite target: ${primary}`);
  }
  const snapshots = await Promise.all(
    [...new Set([...files, ...(params.command.definitionPaths ?? [])])].map((file) =>
      snapshotFile(file, files.includes(file)),
    ),
  );
  if (!snapshots[0]?.original) {
    throw new Error(`The installed service definition is unavailable: ${primary}`);
  }
  const readXml = async () =>
    platform === "win32" ? await readScheduledTaskDefinition(params.env) : null;
  const originalXml = await readXml();
  if (platform === "win32" && originalXml === null) {
    throw new Error("The installed Scheduled Task XML is unavailable for backup.");
  }
  const suffix = `.reconcile-${randomUUID()}.bak`;
  const backups = snapshots.flatMap(({ file, original }) =>
    original ? [{ file, contents: original.contents }] : [],
  );
  const xmlFile = `${primary}.task.xml`;
  if (originalXml !== null) {
    backups.push({
      file: xmlFile,
      contents: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(originalXml, "utf16le")]),
    });
  }
  const backupPaths = await Promise.all(
    backups.map(async ({ file, contents }) => {
      const backup = `${file}${suffix}`;
      assertCurrent();
      await fs.writeFile(backup, contents, { flag: "wx", mode: 0o600, flush: true });
      return backup;
    }),
  );

  let expectedXml = taskPolicySha256(originalXml);
  const assertUnchanged = async () => {
    for (const { file, expected } of snapshots) {
      if (!isDeepStrictEqual(expected, await readServiceFileState(file))) {
        throw new Error(`Service definition changed; preserved the newer edit at ${file}`);
      }
    }
    if (taskPolicySha256(await readXml()) !== expectedXml) {
      throw new Error("Scheduled Task changed; preserved the newer definition.");
    }
    assertCurrent();
  };
  await assertUnchanged();
  let sealed = false;
  let restored = false;
  return {
    backupPaths,
    seal: async (publication) => {
      if (sealed) {
        throw new Error("Service definition backup is already sealed.");
      }
      const verifyOriginal = publication === "original";
      const published = verifyOriginal
        ? await readGatewayServiceDefinitionPublication(params)
        : structuredClone(publication);
      if (
        !isDeepStrictEqual(
          published.files.map((file) => file.sourcePath).toSorted(),
          files.toSorted(),
        ) ||
        (platform === "win32" && published.taskPolicySha256 === null)
      ) {
        throw new Error("Service publication does not match the captured managed artifacts.");
      }
      if (verifyOriginal && published.taskPolicySha256 !== taskPolicySha256(originalXml)) {
        throw new Error("Scheduled Task policy was not restored to its original definition.");
      }
      for (const snapshot of snapshots) {
        if (snapshot.original !== undefined) {
          const after = published.files.find((file) => file.sourcePath === snapshot.file)!.after;
          if (
            verifyOriginal &&
            (after?.sha256 !== snapshot.original?.state.sha256 ||
              after?.mode !== snapshot.original?.state.mode)
          ) {
            throw new Error(
              `Service definition was not restored to its original content and mode: ${snapshot.file}`,
            );
          }
          snapshot.expected = after;
        }
      }
      expectedXml = published.taskPolicySha256;
      await assertUnchanged();
      sealed = true;
    },
    restore: async () => {
      if (restored) {
        return;
      }
      if (!sealed) {
        throw new Error("Service rewrite was not sealed; retained its backup for recovery.");
      }
      await assertUnchanged();
      if (platform === "linux") {
        await assertNoSystemGatewayOwnership(params.env);
      }
      // Restore ancillary inputs before the definition that references them.
      for (const snapshot of snapshots.toReversed()) {
        if (
          snapshot.original === undefined ||
          isDeepStrictEqual(snapshot.original?.state ?? null, snapshot.expected)
        ) {
          continue;
        }
        if (snapshot.original === null) {
          await assertUnchanged();
          await fs.unlink(snapshot.file);
        } else {
          const dirMode = (await fs.stat(path.dirname(snapshot.file))).mode;
          await assertUnchanged();
          replaceFileAtomicSync({
            filePath: snapshot.file,
            content: snapshot.original.contents,
            mode: snapshot.original.state.mode,
            dirMode,
            syncTempFile: true,
            syncParentDir: true,
            beforeRename: assertCurrent,
          });
        }
        snapshot.expected = await readServiceFileState(snapshot.file);
      }
      await assertUnchanged();
      if (originalXml !== null) {
        await restoreScheduledTaskDefinition({
          env: params.env,
          xml: originalXml,
          backupPath: `${xmlFile}${suffix}`,
          preserveEnabled: true,
          beforeMutation: assertUnchanged,
          assertCurrent,
        });
      } else if (platform === "linux") {
        assertCurrent();
        await reloadSystemdUserManager(params.env);
      }
      assertCurrent();
      restored = true;
    },
  };
}
