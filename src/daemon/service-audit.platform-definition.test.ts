import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import { buildLaunchAgentPlist } from "./launchd-plist.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import {
  resolveLaunchAgentPlistPath,
  resolveLaunchAgentEnvWrapperPath,
} from "./launchd-service-files.js";
import { resolveGatewaySupervisorLogPaths } from "./restart-logs.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildTaskScript,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { resetServiceAuditMocks } from "./test-helpers/service-audit-fixtures.js";

const native = vi.hoisted(() => ({ task: vi.fn(), identity: vi.fn() }));
vi.mock("./schtasks-exec.js", () => ({ execSchtasks: native.task }));
vi.mock("./exec-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./exec-file.js")>()),
  execFileUtf8: native.identity,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(async (_command: string, _args: string[], options: { input: Uint8Array }) =>
    decodeLaunchAgentPlistFixture(options.input),
  ),
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  resetServiceAuditMocks();
  native.task.mockReset();
  native.identity
    .mockReset()
    .mockResolvedValue({ code: 1, stdout: "", stderr: "unmapped account" });
});

async function launchdFixture() {
  const home = temporary.make("openclaw-launchd-definition-");
  const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
  const programArguments = [
    "/usr/bin/node",
    "--max-old-space-size=4096",
    "/opt/openclaw/index.js",
    "gateway",
  ];
  const environment = {
    PATH: "/usr/bin:/bin",
    NODE_OPTIONS: "--max-old-space-size=8192",
    CUSTOM_SETTING: "retained",
  };
  const plistPath = resolveLaunchAgentPlistPath(env);
  const { stdoutPath } = resolveGatewaySupervisorLogPaths(env, { platform: "darwin" });
  const canonical = buildLaunchAgentPlist({
    label: "ai.openclaw.gateway",
    programArguments,
    environment,
    stdoutPath,
    stderrPath: stdoutPath,
  });
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  const audit = () =>
    auditGatewayServiceConfig({
      env,
      platform: "darwin",
      command: { programArguments, environment },
    });
  return { env, plistPath, canonical, audit };
}

it("reports stale launchd policy while retaining operator environment and heap arguments", async () => {
  const { plistPath, canonical, audit } = await launchdFixture();
  const original = canonical.replace(/<key>ExitTimeOut<\/key>\s*<integer>20<\/integer>/u, "");
  await fs.writeFile(plistPath, original);
  const result = await audit();
  expect(result.issues.filter((issue) => issue.definitionKey)).toEqual([
    expect.objectContaining({ definitionKey: "ExitTimeOut", detail: plistPath }),
  ]);
  expect(result.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
  expect(await fs.readFile(plistPath, "utf8")).toBe(original);
});

it.each(["plist", "wrapper"])(
  "preserves and identifies unknown LaunchAgent %s behavior",
  async (kind) => {
    const { env, plistPath, canonical, audit } = await launchdFixture();
    const original =
      kind === "plist"
        ? canonical.replace(
            "<key>RunAtLoad</key>",
            "<key>WatchPaths</key><array><string>/operator/watch</string></array><key>RunAtLoad</key>",
          )
        : canonical;
    await fs.writeFile(plistPath, original);
    const wrapper = resolveLaunchAgentEnvWrapperPath(env, "ai.openclaw.gateway");
    if (kind === "wrapper") {
      await fs.mkdir(path.dirname(wrapper), { recursive: true });
      await fs.writeFile(wrapper, '#!/bin/sh\necho operator-hook\nexec "$@"\n');
    }
    const result = await audit();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        definitionKey: kind === "plist" ? "WatchPaths" : "EnvironmentWrapper",
        rewriteBlocked: true,
      }),
    );
    expect(await fs.readFile(plistPath, "utf8")).toBe(original);
    if (kind === "wrapper") {
      expect(await fs.readFile(wrapper, "utf8")).toContain("operator-hook");
    }
  },
);

async function windowsFixture() {
  const home = temporary.make("openclaw-task-definition-");
  const env = { USERPROFILE: home, OPENCLAW_STATE_DIR: home, USERNAME: "fixture" };
  const command = {
    programArguments: ["node", "--max-old-space-size=4096", "C:\\openclaw\\index.js", "gateway"],
    environment: {
      OPENCLAW_SERVICE_KIND: "gateway",
      NODE_OPTIONS: "--max-old-space-size=8192",
      CUSTOM_SETTING: "retained",
    },
  };
  const scriptPath = resolveTaskScriptPath(env);
  const original = buildTaskScript(command);
  await fs.writeFile(scriptPath, original);
  const canonical = buildScheduledTaskXml({
    taskDescription: "OpenClaw Gateway",
    taskUser: env.USERNAME,
    launchPath: scriptPath,
  });
  const respond = (xml: string) =>
    native.task.mockResolvedValue({
      code: 0,
      stdout: xml,
      stderr: "",
    });
  const audit = () => auditGatewayServiceConfig({ env, command, platform: "win32" });
  return { scriptPath, original, canonical, respond, audit };
}

it("finds the older Scheduled Task retry policy without losing recognized operator settings", async () => {
  const { scriptPath, original, canonical, respond, audit } = await windowsFixture();
  respond(
    canonical
      .replace("<Count>3</Count>", "<Count>0</Count>")
      .replace("<Interval>PT1M</Interval>", "<Interval>PT0S</Interval>"),
  );
  const result = await audit();
  expect(
    result.issues.filter((issue) => issue.definitionKey).map((issue) => issue.definitionKey),
  ).toEqual(["RestartOnFailure.Count", "RestartOnFailure.Interval"]);
  expect(result.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
  expect(await fs.readFile(scriptPath, "utf8")).toBe(original);
});

it.each(["native action", "launcher command"])(
  "preserves an unknown Scheduled Task %s",
  async (kind) => {
    const { scriptPath, original, canonical, respond, audit } = await windowsFixture();
    respond(
      kind === "native action"
        ? canonical.replace(
            "</Actions>",
            "<Exec><Command>operator-hook.exe</Command></Exec></Actions>",
          )
        : canonical,
    );
    const installed = kind === "launcher command" ? original + "echo operator-hook\r\n" : original;
    await fs.writeFile(scriptPath, installed);
    const result = await audit();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        definitionKey: kind === "native action" ? "Actions.Exec" : "TaskScript",
        rewriteBlocked: true,
      }),
    );
    expect(await fs.readFile(scriptPath, "utf8")).toBe(installed);
  },
);

it.each([
  {
    key: "Principals.Principal.GroupId",
    edit: (xml: string) =>
      xml.replace(
        "<UserId>fixture</UserId>\n      <LogonType>InteractiveToken</LogonType>",
        "<GroupId>S-1-5-32-544</GroupId>",
      ),
  },
  {
    key: "Principals.Principal.UserId",
    edit: (xml: string) =>
      xml.replaceAll("<UserId>fixture</UserId>", "<UserId>different-user</UserId>"),
  },
  {
    key: "Principals.Principal.@id",
    edit: (xml: string) => xml.replace('Principal id="Author"', 'Principal id="operator"'),
  },
  {
    key: "Actions.@Context",
    edit: (xml: string) => xml.replace('Actions Context="Author"', 'Actions Context="operator"'),
  },
])("preserves Scheduled Task identity edit $key", async ({ key, edit }) => {
  const { canonical, respond, audit } = await windowsFixture();
  respond(edit(canonical));
  expect((await audit()).issues).toContainEqual(
    expect.objectContaining({ definitionKey: key, rewriteBlocked: true }),
  );
});

it("recognizes Task Scheduler SID normalization for the installer's account", async () => {
  const { canonical, respond, audit } = await windowsFixture();
  const sid = "S-1-5-21-123-456-789-1001";
  native.identity.mockResolvedValue({ code: 0, stdout: `${sid}\n`, stderr: "" });
  respond(
    canonical
      .replaceAll("<UserId>fixture</UserId>", `<UserId>${sid}</UserId>`)
      .replace("<Count>3</Count>", "<Count>0</Count>"),
  );
  const issues = (await audit()).issues;
  expect(issues.some((issue) => issue.rewriteBlocked)).toBe(false);
  expect(issues).toContainEqual(
    expect.objectContaining({ definitionKey: "RestartOnFailure.Count" }),
  );
});

it.each(["v2026.7.1-2", "v2026.9.4", "customized legacy"])(
  "audits the %s hidden launcher without losing unknown edits",
  async (version) => {
    const { scriptPath, original, canonical, respond, audit } = await windowsFixture();
    const hiddenPath = scriptPath.replace(/\.cmd$/u, ".vbs");
    const legacy = version !== "v2026.9.4";
    // Captured generated shape: v2026.7.1-2 src/daemon/schtasks.ts:439-448.
    const launcher = legacy
      ? `CreateObject("WScript.Shell").Run """${scriptPath.replaceAll('"', '""')}""", 0, False\r\n`
      : buildHiddenLauncherScript({ scriptPath, taskSupervisor: true });
    await fs.writeFile(
      hiddenPath,
      launcher + (version === "customized legacy" ? 'WScript.Echo "operator hook"\r\n' : ""),
    );
    if (legacy) {
      await fs.writeFile(
        scriptPath,
        original
          .replace(" --task-supervisor < NUL", "")
          .replace(
            "@echo off\r\n",
            '@echo off\r\nset "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=1"\r\n',
          ),
      );
    }
    respond(
      canonical.replace(scriptPath, hiddenPath).replace("<Count>3</Count>", "<Count>0</Count>"),
    );
    const issues = (await audit()).issues;
    expect(issues).toContainEqual(
      expect.objectContaining({ definitionKey: "RestartOnFailure.Count" }),
    );
    expect(issues.some((issue) => issue.rewriteBlocked)).toBe(version === "customized legacy");
    if (version === "customized legacy") {
      expect(issues).toContainEqual(
        expect.objectContaining({ definitionKey: "TaskLauncher", rewriteBlocked: true }),
      );
    }
  },
);

it.each([false, true])(
  "migrates released task defaults while preserving additional operator policy (custom=%s)",
  async (custom) => {
    const { canonical, respond, audit } = await windowsFixture();
    let xml = canonical
      .replace(
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>",
      )
      .replace(
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>",
      )
      .replace("<LogonType>InteractiveToken</LogonType>", "<LogonType>S4U</LogonType>")
      .replace(/\s*<RestartOnFailure>[\s\S]*?<\/RestartOnFailure>/u, "");
    if (custom) {
      xml = xml.replace(
        "<StartWhenAvailable>false</StartWhenAvailable>",
        "<StartWhenAvailable>true</StartWhenAvailable>",
      );
    }
    respond(xml);
    const issues = (await audit()).issues;
    expect(
      issues.filter((issue) => !issue.rewriteBlocked).map((issue) => issue.definitionKey),
    ).toEqual(
      expect.arrayContaining([
        "DisallowStartIfOnBatteries",
        "StopIfGoingOnBatteries",
        "Principals.Principal.LogonType",
        "RestartOnFailure.Count",
        "RestartOnFailure.Interval",
      ]),
    );
    expect(issues.some((issue) => issue.rewriteBlocked)).toBe(custom);
    if (custom) {
      expect(issues).toContainEqual(
        expect.objectContaining({
          definitionKey: "Settings.StartWhenAvailable",
          rewriteBlocked: true,
        }),
      );
    }
  },
);

it.each([
  { key: "StandardOutPath", value: "/operator/output.log", blocked: true },
  { key: "StandardErrorPath", value: "/operator/error.log", blocked: true },
  { key: "StandardErrorPath", value: "/dev/null", blocked: false },
])(
  "distinguishes released launchd log policy from an operator $key edit ($value)",
  async ({ key, value, blocked }) => {
    const { canonical, plistPath, audit } = await launchdFixture();
    const definition = canonical.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*</string>`, "u"),
      `$1${value}</string>`,
    );
    await fs.writeFile(plistPath, definition);
    const findings = (await audit()).issues;
    expect(findings).toContainEqual(expect.objectContaining({ definitionKey: key }));
    expect(findings.some((issue) => issue.rewriteBlocked)).toBe(blocked);
    expect(await fs.readFile(plistPath, "utf8")).toBe(definition);
  },
);

it.each([
  { key: "ExitTimeOut", value: 600 },
  { key: "ThrottleInterval", value: 120 },
])("preserves a custom launchd $key scalar", async ({ key, value }) => {
  const { canonical, plistPath, audit } = await launchdFixture();
  const definition = canonical.replace(
    new RegExp(`(<key>${key}</key>\\s*<integer>)[^<]*</integer>`, "u"),
    `$1${value}</integer>`,
  );
  await fs.writeFile(plistPath, definition);
  expect((await audit()).issues).toContainEqual(
    expect.objectContaining({ definitionKey: key, rewriteBlocked: true }),
  );
  expect(await fs.readFile(plistPath, "utf8")).toBe(definition);
});

it.each([
  { count: "9", interval: "PT1M", key: "Count" },
  { count: "0", interval: "PT5M", key: "Interval" },
])("preserves custom Scheduled Task retry $key", async ({ count, interval, key }) => {
  const { canonical, respond, audit } = await windowsFixture();
  respond(
    canonical
      .replace("<Count>3</Count>", `<Count>${count}</Count>`)
      .replace("<Interval>PT1M</Interval>", `<Interval>${interval}</Interval>`),
  );
  expect((await audit()).issues).toContainEqual(
    expect.objectContaining({ definitionKey: `RestartOnFailure.${key}`, rewriteBlocked: true }),
  );
});
