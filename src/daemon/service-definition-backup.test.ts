import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { buildScheduledTaskXml, resolveTaskScriptPath } from "./schtasks-layout.js";
import {
  captureGatewayServiceDefinitionBackup,
  readGatewayServiceDefinitionPublication,
} from "./service-definition-backup.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";

const native = vi.hoisted(() => ({
  task: vi.fn<typeof import("./schtasks-exec.js").execSchtasks>(),
  reload: vi.fn<typeof import("./systemd-exec.js").reloadSystemdUserManager>(),
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
vi.mock("./systemd-exec.js", async (original) => ({
  ...(await original<typeof import("./systemd-exec.js")>()),
  reloadSystemdUserManager: native.reload,
}));
vi.mock("./systemd-scope.js", () => ({ assertNoSystemGatewayOwnership: async () => {} }));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const supportsPosixModes = process.platform !== "win32";
beforeEach(() => {
  native.task.mockReset();
  native.reload.mockReset();
});

async function fixture(platform: "linux" | "darwin" | "win32") {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const root = temporary.make("openclaw-definition-backup-");
  const env = { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const primary =
    platform === "linux"
      ? resolveSystemdUnitPath(env)
      : platform === "darwin"
        ? resolveLaunchAgentPlistPath(env)
        : resolveTaskScriptPath(env);
  const label = resolveLaunchAgentLabel(env);
  const files =
    platform === "linux"
      ? [primary, path.join(env.OPENCLAW_STATE_DIR, "gateway.systemd.env")]
      : platform === "darwin"
        ? [
            primary,
            resolveLaunchAgentEnvFilePath(env, label),
            resolveLaunchAgentEnvWrapperPath(env, label),
          ]
        : [primary, primary.replace(/\.cmd$/u, ".vbs")];
  const originals = new Map(files.map((file) => [file, `previous ${path.basename(file)}\n`]));
  for (const [file, contents] of originals) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, { mode: file.endsWith(".sh") ? 0o700 : 0o600 });
  }
  const originalXml = buildScheduledTaskXml({
    taskDescription: "OpenClaw Gateway",
    taskUser: "fixture-user",
    launchPath: primary,
  }).replace("<Count>3</Count>", "<Count>0</Count>");
  let xml = originalXml;
  native.task.mockImplementation(async (args) => {
    if (args[0] === "/Query") {
      return { code: 0, stdout: xml, stderr: "" };
    }
    if (args[0] === "/Create") {
      xml = (await fs.readFile(args.at(-1)!)).subarray(2).toString("utf16le");
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error("Unexpected native task mutation");
  });
  return {
    env,
    primary,
    files,
    originals,
    originalXml,
    readXml: () => xml,
    setXml: (value: string) => {
      xml = value;
    },
    command: { sourcePath: primary, programArguments: ["node", "/old/openclaw", "gateway"] },
  };
}

it.each(
  (["linux", "darwin", "win32"] as const).flatMap((platform) =>
    (["publication", "original"] as const).map((seal) => ({ platform, seal })),
  ),
)(
  "restores $platform definitions and ancillary files after $seal sealing",
  async ({ platform, seal }) => {
    const current = await fixture(platform);
    const backup = await captureGatewayServiceDefinitionBackup({
      ...current,
      assertCurrent: () => {},
    });
    expect(backup.backupPaths).toHaveLength(current.files.length + (platform === "win32" ? 1 : 0));
    for (const [index, backupPath] of backup.backupPaths.entries()) {
      if (index < current.files.length) {
        expect(await fs.readFile(backupPath, "utf8")).toBe(
          current.originals.get(current.files[index]!),
        );
      } else {
        expect((await fs.readFile(backupPath)).subarray(2).toString("utf16le")).toBe(
          current.originalXml,
        );
      }
      if (supportsPosixModes) {
        expect((await fs.stat(backupPath)).mode & 0o077).toBe(0);
      }
    }
    const modes = await Promise.all(current.files.map(async (file) => (await fs.stat(file)).mode));
    for (const file of current.files) {
      await fs.writeFile(file, "candidate definition\n");
    }
    if (platform === "win32") {
      current.setXml(current.originalXml.replace("<Count>0</Count>", "<Count>3</Count>"));
    }
    const expectedXml =
      platform === "win32" && seal === "original"
        ? current.originalXml.replace(
            /(<Settings>[\s\S]*?<Enabled>)true(<\/Enabled>)/u,
            "$1false$2",
          )
        : current.originalXml;
    if (seal === "original") {
      for (const file of current.files) {
        await fs.writeFile(file, current.originals.get(file)!);
        await fs.utimes(file, 0, 0);
      }
      expect((await fs.stat(current.primary)).mtimeMs).toBe(0);
      current.setXml(expectedXml);
    }
    await backup.seal(
      seal === "original" ? "original" : await readGatewayServiceDefinitionPublication(current),
    );
    await backup.restore();
    for (const [index, file] of current.files.entries()) {
      expect(await fs.readFile(file, "utf8")).toBe(current.originals.get(file));
      expect((await fs.stat(file)).mode).toBe(modes[index]);
    }
    expect(current.readXml()).toBe(expectedXml);
    expect(native.reload).toHaveBeenCalledTimes(platform === "linux" ? 1 : 0);
  },
);

it("removes only the unchanged generated environment created by the rewrite", async () => {
  const current = await fixture("linux");
  const generated = current.files[1]!;
  await fs.unlink(generated);
  const backup = await captureGatewayServiceDefinitionBackup({
    ...current,
    assertCurrent: () => {},
  });
  await fs.writeFile(generated, "NODE_OPTIONS=--max-old-space-size=2048\n");
  await fs.writeFile(current.primary, "candidate definition\n");
  await backup.seal(await readGatewayServiceDefinitionPublication(current));
  await backup.restore();
  await expect(fs.stat(generated)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(current.primary, "utf8")).toBe(current.originals.get(current.primary));
});

it.each(["before", "after"] as const)(
  "restores task policy while preserving suspension %s sealing",
  async (when) => {
    const current = await fixture("win32");
    const backup = await captureGatewayServiceDefinitionBackup({
      ...current,
      assertCurrent: () => {},
    });
    const candidateXml = current.originalXml.replace("<Count>0</Count>", "<Count>3</Count>");
    current.setXml(candidateXml);
    const publication = await readGatewayServiceDefinitionPublication(current);
    const suspend = (xml: string) =>
      xml.replace(/(<Settings>[\s\S]*?<Enabled>)true(<\/Enabled>)/u, "$1false$2");
    if (when === "before") {
      current.setXml(suspend(candidateXml));
    }
    await backup.seal(publication);
    current.setXml(suspend(candidateXml));
    await backup.restore();
    expect(current.readXml()).toBe(suspend(current.originalXml));
    expect(current.readXml()).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>/u);
    expect(native.task.mock.calls.filter(([args]) => args[0] === "/Create")).toHaveLength(1);
    expect(native.task.mock.calls.some(([args]) => args.includes("/ENABLE"))).toBe(false);
  },
);

it.each(
  (["file", "task XML"] as const).flatMap((changed) =>
    (["publication", "original"] as const).map((seal) => ({ changed, seal })),
  ),
)("rejects an intervening $changed edit during $seal sealing", async ({ changed, seal }) => {
  const current = await fixture(changed === "file" ? "linux" : "win32");
  const backup = await captureGatewayServiceDefinitionBackup({
    ...current,
    assertCurrent: () => {},
  });
  const currentDefinition =
    seal === "original" ? current.originals.get(current.primary)! : "candidate definition\n";
  await fs.writeFile(current.primary, currentDefinition);
  const publication = await readGatewayServiceDefinitionPublication(current);
  if (changed === "file") {
    await fs.writeFile(current.primary, "operator edit\n");
  } else {
    current.setXml(
      current.originalXml.replace("<Interval>PT1M</Interval>", "<Interval>PT2M</Interval>"),
    );
  }
  await expect(backup.seal(seal === "original" ? "original" : publication)).rejects.toThrow(
    seal === "original" ? /not restored/i : /changed/i,
  );
  await expect(backup.restore()).rejects.toThrow("not sealed");
  expect(await fs.readFile(current.primary, "utf8")).toBe(
    changed === "file" ? "operator edit\n" : currentDefinition,
  );
  if (changed === "task XML") {
    expect(current.readXml()).toContain("<Interval>PT2M</Interval>");
  }
  expect(native.reload).not.toHaveBeenCalled();
  expect(native.task.mock.calls.some(([args]) => args[0] === "/Create")).toBe(false);
});

it.each(["managed file", "drop-in", "task XML", "authority"] as const)(
  "preserves later %s changes instead of overwriting them during rollback",
  async (changed) => {
    const current = await fixture(changed === "task XML" ? "win32" : "linux");
    const dropIn = `${current.primary}.d/operator.conf`;
    await fs.mkdir(path.dirname(dropIn));
    await fs.writeFile(dropIn, "[Service]\nEnvironment=OPERATOR=before\n");
    let active = true;
    const backup = await captureGatewayServiceDefinitionBackup({
      ...current,
      command: { ...current.command, definitionPaths: [current.primary, dropIn] },
      assertCurrent: () => {
        if (!active) {
          throw new Error("Update authority closed");
        }
      },
    });
    await fs.writeFile(current.primary, "candidate definition\n");
    await backup.seal(await readGatewayServiceDefinitionPublication(current));
    if (changed === "managed file") {
      await fs.writeFile(current.primary, "operator edit\n");
    } else if (changed === "drop-in") {
      await fs.writeFile(dropIn, "[Service]\nEnvironment=OPERATOR=after\n");
    } else if (changed === "task XML") {
      current.setXml(
        current.originalXml.replace("<Interval>PT1M</Interval>", "<Interval>PT2M</Interval>"),
      );
    } else {
      active = false;
    }
    await expect(backup.restore()).rejects.toThrow(
      changed === "authority" ? "authority closed" : /changed/i,
    );
    expect(await fs.readFile(current.primary, "utf8")).toBe(
      changed === "managed file" ? "operator edit\n" : "candidate definition\n",
    );
    expect(native.reload).not.toHaveBeenCalled();
    expect(native.task.mock.calls.some(([args]) => args[0] === "/Create")).toBe(false);
  },
);
