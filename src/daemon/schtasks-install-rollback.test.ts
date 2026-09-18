import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/service-audit-mocks.js";
import { installScheduledTask, stageScheduledTask } from "./schtasks-install.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildTaskScript,
  encodeWindowsLauncherScript,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
import { resetServiceAuditMocks } from "./test-helpers/service-audit-fixtures.js";

const native = vi.hoisted(() => ({
  exec: vi.fn<typeof import("./schtasks-exec.js").execSchtasks>(),
  run: vi.fn<typeof import("./schtasks-control.js").runScheduledTaskOrThrow>(),
}));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.exec }));
vi.mock("./schtasks-control.js", async (original) => ({
  ...(await original<typeof import("./schtasks-control.js")>()),
  runScheduledTaskOrThrow: native.run,
}));
vi.mock("./schtasks-runtime.js", async (original) => ({
  ...(await original<typeof import("./schtasks-runtime.js")>()),
  isStartupEntryInstalled: async () => false,
}));
vi.mock("../infra/windows-encoding.js", async (original) => ({
  ...(await original<typeof import("../infra/windows-encoding.js")>()),
  resolveWindowsOemCodePage: () => 437,
  resolveWindowsOemEncoding: () => "cp437",
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const supportsPosixModes = process.platform !== "win32";
beforeEach(() => {
  resetServiceAuditMocks();
  native.exec.mockReset();
  native.run.mockReset();
});

it("automatically reconciles zero Scheduled Task retries through the existing installer", async () => {
  const { args, scriptPath, launcherPath } = await fixture();
  const env = {
    ...args.env,
    HOME: args.env.USERPROFILE,
    USERNAME: "task-fixture",
    OPENCLAW_WINDOWS_TASK_NAME: `OpenClaw Gateway ${path.basename(args.env.USERPROFILE)}`,
  };
  const environment = { NODE_OPTIONS: "--max-old-space-size=4096", OPERATOR_SETTING: "retained" };
  const originalArgs = ["node", "/prefix-a/openclaw/dist/index.js", "gateway", "--port", "19305"];
  await fs.writeFile(
    scriptPath,
    encodeWindowsLauncherScript({
      format: "cmd",
      content: buildTaskScript({ programArguments: originalArgs, environment }),
    }),
  );
  await fs.writeFile(
    launcherPath,
    encodeWindowsLauncherScript({
      format: "vbs",
      content: buildHiddenLauncherScript({ scriptPath }),
    }),
  );
  const originalXml = buildScheduledTaskXml({
    taskDescription: "OpenClaw Gateway",
    taskUser: env.USERNAME,
    launchPath: launcherPath,
  })
    .replace("<Count>3</Count>", "<Count>0</Count>")
    .replace("<Interval>PT1M</Interval>", "<Interval>PT0S</Interval>");
  let registeredXml = originalXml;
  native.exec.mockImplementation(async (argv) => {
    if (argv[0] === "/Query" && argv.includes("/XML")) {
      return { code: 0, stdout: registeredXml, stderr: "" };
    }
    if (argv[0] === "/Create") {
      registeredXml = (await fs.readFile(argv.at(-1)!)).subarray(2).toString("utf16le");
    } else if (argv[0] !== "/Change") {
      throw new Error("Unexpected native task operation");
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  native.run.mockResolvedValue("scheduled-task");
  const warn = vi.fn();
  const expected = {
    ...args,
    env,
    environment,
    programArguments: [...args.programArguments, "--port", "19305"],
    warn,
  };
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  try {
    await withEnvAsync({ OPENCLAW_UPDATE_RUN_ID: undefined }, async () => {
      const command = await readScheduledTaskCommand(env, { requireEffective: true });
      if (!command) {
        throw new Error("Missing generated task fixture");
      }
      await withGatewayServiceOperationLock(env, (assertCurrent) =>
        reconcileGatewayServiceDefinition({
          env,
          command,
          expectedCommand: expected,
          automatic: true,
          assertCurrent,
          warn,
          install: async () => {
            await installScheduledTask(expected);
          },
        }),
      );
    });
    expect(registeredXml).toContain("<Count>3</Count>");
    expect(registeredXml).toContain("<Interval>PT1M</Interval>");
    expect(native.run).toHaveBeenCalledOnce();
    expect(await readScheduledTaskCommand(env)).toMatchObject({
      programArguments: expected.programArguments,
      environment,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("RestartOnFailure.Count, RestartOnFailure.Interval"),
    );
    const backups = (await fs.readdir(path.dirname(scriptPath))).filter((file) =>
      file.startsWith(`${path.basename(scriptPath)}.task.xml.reconcile-`),
    );
    expect(backups).toHaveLength(1);
    const backup = path.join(path.dirname(scriptPath), backups[0]!);
    expect((await fs.readFile(backup)).subarray(2).toString("utf16le")).toBe(originalXml);
    if (supportsPosixModes) {
      expect((await fs.stat(backup)).mode & 0o077).toBe(0);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(backup));
  } finally {
    platform.mockRestore();
  }
});

async function fixture() {
  const root = temporary.make("openclaw-task-rollback-");
  const env = {
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
  };
  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = scriptPath.replace(/\.cmd$/u, ".vbs");
  const original = encodeWindowsLauncherScript({
    format: "cmd",
    content: buildTaskScript({
      programArguments: ["node", "/prefix-a/openclaw/dist/index.js", "gateway"],
    }),
  });
  await fs.writeFile(scriptPath, original);
  await fs.writeFile(launcherPath, "original hidden launcher");
  const args = {
    env,
    stdout: new PassThrough(),
    programArguments: ["node", "/prefix-b/openclaw/dist/index.js", "gateway"],
  };
  return { args, scriptPath, launcherPath, original };
}

it("leaves both original launchers intact when staging cannot capture the hidden launcher", async () => {
  const { args, scriptPath, launcherPath, original } = await fixture();
  await fs.unlink(launcherPath);
  await fs.mkdir(launcherPath);
  await expect(stageScheduledTask(args)).rejects.toThrow();
  expect(await fs.readFile(scriptPath)).toEqual(original);
  expect((await fs.stat(launcherPath)).isDirectory()).toBe(true);
});

it.each(["registration", "xml-upgrade", "run"])(
  "retains the prior definition when %s fails",
  async (failure) => {
    const runAttempted = failure === "run";
    const { args, scriptPath, launcherPath, original } = await fixture();
    const originalXml =
      "<Task><Settings><Enabled>false</Enabled></Settings><Actions><Exec><Command>original</Command></Exec></Actions></Task>";
    native.exec.mockImplementation(async (command) => {
      if (command[0] === "/Query") {
        return { code: 0, stdout: originalXml, stderr: "" };
      }
      if (command[0] === "/Create" && command.includes("/XML")) {
        const xml = await fs.readFile(command.at(-1)!);
        if (xml.subarray(2).toString("utf16le") === originalXml) {
          return { code: 0, stdout: "", stderr: "" };
        }
      }
      return runAttempted || (failure === "xml-upgrade" && command[0] === "/Change")
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 2, stdout: "", stderr: "registration rejected" };
    });
    native.run.mockRejectedValue(new Error("run completion unknown"));
    const warn = vi.fn();
    await expect(installScheduledTask({ ...args, warn })).rejects.toThrow(
      runAttempted ? "run completion unknown" : "registration rejected",
    );
    expect(await fs.readFile(`${scriptPath}.bak`)).toEqual(original);
    expect(await fs.readFile(`${launcherPath}.bak`, "utf8")).toBe("original hidden launcher");
    expect((await fs.readFile(`${scriptPath}.task.xml.bak`)).subarray(2).toString("utf16le")).toBe(
      originalXml,
    );
    if (runAttempted) {
      expect(await fs.readFile(scriptPath)).not.toEqual(original);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("queued task may still start"));
    } else {
      expect(await fs.readFile(scriptPath)).toEqual(original);
      expect(await fs.readFile(launcherPath, "utf8")).toBe("original hidden launcher");
      expect(native.run).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  },
);
