import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { z } from "zod";
import { hashFile } from "../../scripts/lib/gateway-bench-installed-package.ts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { normalizeWindowsTaskIdentity } from "./constants.js";
import {
  installedStatusSchema,
  type parseInstalledPreview,
} from "./schtasks.installed-package.test-support.js";

export const doctorReportSchema = z.object({
  checksRun: z.number().int().positive(),
  findings: z.array(
    z.object({
      checkId: z.string(),
      severity: z.string(),
      target: z.string().optional(),
      message: z.string(),
    }),
  ),
});
export type InstalledTask = {
  profile: string;
  taskName: string;
  stateDir: string;
  configPath: string;
  scriptPath: string;
  gatewayPort: number;
  rootDir: string;
  installRoot: string;
  entry: string;
  env: NodeJS.ProcessEnv;
};
export async function inspectDisabledDiscoveryTasks(params: {
  selected: InstalledTask;
  preview: (task: InstalledTask) => Promise<ReturnType<typeof parseInstalledPreview>>;
  doctor: (task: InstalledTask) => Promise<z.infer<typeof doctorReportSchema>>;
  cleanupTask: (
    task: Pick<InstalledTask, "rootDir" | "stateDir" | "scriptPath" | "taskName">,
    probePath: string,
    eventsPath: string,
  ) => Promise<void>;
  owners: {
    reserveLoopbackPort: () => Promise<number>;
    canBindLoopbackPort: (port: number) => Promise<boolean>;
  };
  id: string;
  cellIndex: number;
  key: string;
  rootDir: string;
  installRoot: string;
  admissions: Array<Record<string, unknown>>;
  admissionPath: string;
}) {
  const {
    selected,
    preview,
    doctor,
    cleanupTask,
    owners,
    id,
    cellIndex,
    key,
    rootDir,
    installRoot,
    admissions,
    admissionPath,
  } = params;
  const { resolveGatewayWindowsTaskName } = await import("./constants.js");
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { resolveTaskScriptPath } = await import("./schtasks.js");
  const { quoteCmdScriptArg } = await import("./cmd-argv.js");
  const { buildTaskScript } = await import("./schtasks-layout.js");
  const { encodeWindowsLauncherScript } = await import("../infra/windows-launcher-encoding.js");
  const { probeScheduledTaskExists } = await import("./schtasks-state-probe.js");
  const { readTaskXml, readTaskPrincipal } =
    await import("./schtasks.integration-observation.test-support.js");
  const { readGatewayServiceState, resolveGatewayService } = await import("./service.js");
  const selectedXml = await readTaskXml(selected.taskName);
  assert.ok(selectedXml);
  const selectedConfig = await fs.readFile(selected.configPath);
  const command = /<Command>([^<]+)<\/Command>/u.exec(selectedXml);
  assert.ok(command);
  assert.equal(selectedXml.match(/<Command>/gu)?.length, 1);
  const fixtures: Array<
    Pick<InstalledTask, "profile" | "taskName" | "stateDir" | "rootDir" | "scriptPath"> & {
      role: "non-gateway" | "missing" | "direct" | "extra";
      gateway?: InstalledTask;
      configBefore?: Buffer;
      scriptHash?: string;
      observedXml?: string;
    }
  > = [];
  let inspectionFailure: Error | undefined;
  let report: z.infer<typeof doctorReportSchema> | undefined;
  let nonGatewayScriptHash: string | undefined;
  let directInspection: Record<string, unknown> | undefined;
  try {
    for (const role of ["non-gateway", "missing", "direct", "extra"] as const) {
      const profile: string = ["schtasks-int", id, cellIndex, role].join("-");
      const taskName: string =
        role === "non-gateway"
          ? `OpenClaw Helper (${profile})`
          : role === "extra"
            ? `NativeExtra-${id}-${cellIndex}`
            : resolveGatewayWindowsTaskName(profile);
      const stateDir = path.join(os.userInfo().homedir, `.openclaw-${profile}`);
      const fixtureRoot = path.join(rootDir, role);
      const scriptPath = path.join(fixtureRoot, `${role}.cmd`);
      assert.equal(probeScheduledTaskExists(taskName), false);
      await fs.mkdir(stateDir);
      await fs.mkdir(fixtureRoot);
      if (role === "non-gateway") {
        await fs.writeFile(
          scriptPath,
          encodeWindowsLauncherScript({
            format: "cmd",
            content: `@echo off\r\n${quoteCmdScriptArg(process.execPath)} --version\r\n`,
          }),
        );
        nonGatewayScriptHash = await hashFile(scriptPath);
      } else {
        await assert.rejects(fs.access(scriptPath), { code: "ENOENT" });
      }
      const fixture: (typeof fixtures)[number] = {
        role,
        profile,
        taskName,
        stateDir,
        rootDir: fixtureRoot,
        scriptPath,
      };
      if (role === "direct" || role === "extra") {
        const gatewayPort = await owners.reserveLoopbackPort();
        const configPath = path.join(stateDir, "openclaw.json");
        const env = {
          ...selected.env,
          OPENCLAW_PROFILE: profile,
          OPENCLAW_WINDOWS_TASK_NAME: taskName,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_PORT: String(gatewayPort),
        };
        fixture.gateway = { ...selected, ...fixture, configPath, gatewayPort, env };
        const config = JSON.parse(selectedConfig.toString());
        config.gateway.port = gatewayPort;
        await fs.writeFile(configPath, JSON.stringify(config));
        fixture.configBefore = await fs.readFile(configPath);
        await assert.rejects(fs.access(resolveTaskScriptPath(env)), { code: "ENOENT" });
      }
      fixtures.push(fixture);
      admissions.push({
        taskInitiallyAbsent: true,
        cell: key,
        role,
        profile,
        taskName,
        stateDir,
        rootDir: fixtureRoot,
        installRoot,
        entry: selected.entry,
        scriptPath,
        ...(fixture.gateway ? { cleanupNeedle: profile } : {}),
      });
      await fs.writeFile(admissionPath, JSON.stringify(admissions, null, 2));
      const escapeXml = (value: string) =>
        value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const argv = fixture.gateway
        ? [
            process.execPath,
            selected.entry,
            "--profile",
            profile,
            "gateway",
            "--port",
            String(fixture.gateway.gatewayPort),
          ]
        : undefined;
      if (role === "extra" && fixture.gateway && argv) {
        await fs.writeFile(
          scriptPath,
          encodeWindowsLauncherScript({
            format: "cmd",
            content: buildTaskScript({
              programArguments: argv,
              workingDirectory: fixtureRoot,
              environment: fixture.gateway.env,
            }),
          }),
        );
        fixture.scriptHash = await hashFile(scriptPath);
      }
      const argumentsText = argv
        ?.slice(1)
        .map((arg) => `"${arg}"`)
        .join(" ");
      const action =
        role === "direct" && argv
          ? `<Command>${escapeXml(process.execPath)}</Command><Arguments>${escapeXml(argumentsText ?? "")}</Arguments><WorkingDirectory>${escapeXml(fixtureRoot)}</WorkingDirectory>`
          : `<Command>${escapeXml(scriptPath)}</Command>`;
      const definition: string = selectedXml
        .replace(/<Arguments>[\s\S]*?<\/Arguments>/u, "")
        .replace(/<WorkingDirectory>[\s\S]*?<\/WorkingDirectory>/u, argv ? "" : "$&")
        .replace(command[0], action)
        .replace(/<Triggers>[\s\S]*?<\/Triggers>/u, "<Triggers />")
        .replace(/<URI>[^<]*<\/URI>/u, `<URI>\\${taskName}</URI>`)
        .replaceAll("<Enabled>true</Enabled>", "<Enabled>false</Enabled>")
        .replace(
          "<AllowStartOnDemand>true</AllowStartOnDemand>",
          "<AllowStartOnDemand>false</AllowStartOnDemand>",
        );
      assert.ok(definition.includes("<Triggers />"));
      assert.ok(definition.includes("<AllowStartOnDemand>false</AllowStartOnDemand>"));
      const definitionPath = path.join(fixtureRoot, "task.xml");
      await fs.writeFile(definitionPath, `\uFEFF${definition}`, "utf16le");
      // No trigger or on-demand launch is admitted for these diagnostic definitions.
      assert.equal(
        (await execSchtasks(["/Create", "/TN", taskName, "/XML", definitionPath])).code,
        0,
      );
      assert.equal(readTaskPrincipal(taskName).enabled, false);
      fixture.observedXml = (await readTaskXml(taskName)) ?? undefined;
      assert.ok(fixture.observedXml);
      if (role === "direct" && fixture.gateway && argv) {
        const direct = fixture.gateway;
        const configBefore = await fs.readFile(direct.configPath);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        const state = await readGatewayServiceState(resolveGatewayService(), {
          env: direct.env,
          requireEffective: true,
          requireLoadedCommand: true,
        });
        assert.deepEqual(state.command, {
          programArguments: argv,
          workingDirectory: fixtureRoot,
        });
        assert.equal(state.installed, true);
        assert.equal(state.runtime?.status, "stopped");
        assert.equal(state.runtime?.pid, undefined);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        const directPreview = await preview(direct);
        assert.ok(
          directPreview.notes.some((note) =>
            note.includes("Gateway service inspection is unavailable"),
          ),
        );
        assert.deepEqual(await fs.readFile(direct.configPath), configBefore);
        assert.equal(await owners.canBindLoopbackPort(direct.gatewayPort), true);
        directInspection = {
          command: state.command,
          runtime: state.runtime,
          preview: directPreview,
        };
      }
    }
    report = await doctor(selected);
    assert.equal(report.checksRun, 1);
    const nonGateway = fixtures.find((fixture) => fixture.role === "non-gateway");
    assert.ok(nonGateway);
    const missing = fixtures.find((fixture) => fixture.role === "missing");
    assert.ok(missing);
    assert.equal(
      report.findings.some((finding) => finding.target === "\\" + nonGateway.taskName),
      false,
    );
    const missingFindings = report.findings.filter(
      (finding) => finding.target === "\\" + missing.taskName,
    );
    assert.equal(missingFindings.length, 1);
    const missingFinding = missingFindings[0];
    assert.ok(missingFinding);
    assert.equal(missingFinding.checkId, "core/doctor/gateway-services/extra");
    assert.equal(missingFinding.severity, "warning");
    assert.match(missingFinding.message, /inspection incomplete/i);
    assert.equal(
      report.findings.some((finding) => finding.target === "\\" + selected.taskName),
      false,
    );
    const extra = fixtures.find((fixture) => fixture.role === "extra");
    assert.ok(extra);
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.target === "\\" + extra.taskName &&
          finding.severity === "info" &&
          finding.checkId === "core/doctor/gateway-services/extra",
      ),
    );
    assert.equal(await hashFile(nonGateway.scriptPath), nonGatewayScriptHash);
    await assert.rejects(fs.access(missing.scriptPath), { code: "ENOENT" });
    for (const fixture of fixtures) {
      if (fixture.gateway) {
        assert.deepEqual(await fs.readFile(fixture.gateway.configPath), fixture.configBefore);
        assert.equal(await owners.canBindLoopbackPort(fixture.gateway.gatewayPort), true);
      }
      if (fixture.scriptHash) {
        assert.equal(await hashFile(fixture.scriptPath), fixture.scriptHash);
      }
      assert.equal(readTaskPrincipal(fixture.taskName).enabled, false);
      assert.equal(await readTaskXml(fixture.taskName), fixture.observedXml);
    }
    assert.equal(await readTaskXml(selected.taskName), selectedXml);
    assert.deepEqual(await fs.readFile(selected.configPath), selectedConfig);
  } catch (error) {
    inspectionFailure = toErrorObject(error, "Installed Scheduled Task fixture failed");
  }
  for (const fixture of fixtures.toReversed()) {
    try {
      await cleanupTask(
        fixture,
        fixture.gateway ? fixture.profile : fixture.scriptPath,
        path.join(fixture.rootDir, "unused-events"),
      );
    } catch (error) {
      inspectionFailure = new AggregateError(
        inspectionFailure ? [inspectionFailure, error] : [error],
        "Disabled discovery task cleanup failed",
      );
    }
  }
  if (inspectionFailure) {
    throw inspectionFailure;
  }
  assert.ok(report);
  assert.ok(directInspection);
  return {
    report,
    directInspection,
    nonGatewayScriptHash,
    definitionsUnchanged: true,
    tasksDisabledThroughoutInspection: true,
    launcherExecutionRequested: false,
    missingDefinitionScope:
      "ENOENT for an owned registered CMD path; no access-denied or ACL claim",
  };
}

type InstalledStartupInspectionArgs = {
  selected: InstalledTask;
  launcher: InstalledTask;
  doctor: (task: InstalledTask) => Promise<z.infer<typeof doctorReportSchema>>;
  deepStatus: (task: InstalledTask) => Promise<unknown>;
  lifetime: Pick<ReturnType<typeof createFixtureLifetime>, "verifyCleanup">;
  admissions: Array<Record<string, unknown>>;
  admissionPath: string;
};

const startupStatusExtrasSchema = z.object({
  extraServices: z.array(
    z.object({
      platform: z.string(),
      label: z.string(),
      detail: z.string(),
      scope: z.string(),
      windowsStartupEntry: z.string().optional(),
    }),
  ),
});

async function withInstalledStartupEntries(
  params: InstalledStartupInspectionArgs,
  includeAlias: boolean,
  inspect: (startupPaths: string[]) => Promise<Record<string, unknown>>,
) {
  const { selected, launcher, lifetime, admissions, admissionPath } = params;
  const { buildStartupLauncherScript, resolveStartupEntryPath, resolveTaskLauncherScriptPath } =
    await import("./schtasks-layout.js");
  const { encodeWindowsLauncherScript } = await import("../infra/windows-launcher-encoding.js");
  const { probeScheduledTaskExists } = await import("./schtasks-state-probe.js");
  const { readTaskXml } = await import("./schtasks.integration-observation.test-support.js");
  const launcherPath = resolveTaskLauncherScriptPath(launcher.env, launcher.scriptPath);
  assert.notEqual(launcherPath, launcher.scriptPath);
  const sourcePaths = [launcher.scriptPath, launcherPath];
  const sourceHashes = await Promise.all(sourcePaths.map((pathname) => hashFile(pathname)));
  const snapshots = await Promise.all(
    [...new Set([selected, launcher])].map(async (task) => {
      assert.equal(probeScheduledTaskExists(task.taskName), true);
      const xml = await readTaskXml(task.taskName);
      assert.ok(xml);
      return { task, xml, config: await fs.readFile(task.configPath) };
    }),
  );
  const startupPaths = [
    resolveStartupEntryPath(launcher.env, "cmd"),
    resolveStartupEntryPath(launcher.env, "vbs"),
  ];
  const startupBytes = [
    encodeWindowsLauncherScript({
      format: "cmd",
      content: buildStartupLauncherScript({ scriptPath: launcher.scriptPath }),
    }),
    await fs.readFile(launcherPath),
  ];
  if (includeAlias) {
    startupPaths.push(startupPaths[1]!.replace(/\.vbs$/u, ".sibling.vbs"));
    startupBytes.push(startupBytes[1]!);
  }
  for (const pathname of startupPaths) {
    await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
  }
  const matches = admissions.filter((record) => record.taskName === launcher.taskName);
  assert.equal(matches.length, 1);
  const admission = matches[0];
  assert.ok(admission);
  assert.ok(admission.role === "selected" || admission.role === "peer");
  if (admission.startupEntryPaths !== undefined) {
    assert.equal(admission.startupEntriesInitiallyAbsent, true);
    assert.deepEqual(admission.startupEntryPaths, startupPaths.slice(0, 2));
  }
  // Admission precedes creation; the workflow removes only these exact owned files.
  admission.startupEntriesInitiallyAbsent = true;
  admission.startupEntryPaths = startupPaths;
  await fs.writeFile(admissionPath, JSON.stringify(admissions, null, 2));
  const createdPaths: string[] = [];
  let failure: Error | undefined;
  let observation: Record<string, unknown> | undefined;
  try {
    await fs.mkdir(path.dirname(startupPaths[0]!), { recursive: true });
    for (const [index, pathname] of startupPaths.entries()) {
      const handle = await fs.open(pathname, "wx");
      createdPaths.push(pathname);
      try {
        await handle.writeFile(startupBytes[index]!);
      } finally {
        await handle.close();
      }
    }
    observation = await inspect(startupPaths);
    for (const snapshot of snapshots) {
      assert.equal(probeScheduledTaskExists(snapshot.task.taskName), true);
      assert.equal(await readTaskXml(snapshot.task.taskName), snapshot.xml);
      assert.deepEqual(await fs.readFile(snapshot.task.configPath), snapshot.config);
    }
    assert.deepEqual(
      await Promise.all(sourcePaths.map((pathname) => hashFile(pathname))),
      sourceHashes,
    );
    for (const [index, pathname] of startupPaths.entries()) {
      assert.deepEqual(await fs.readFile(pathname), startupBytes[index]);
    }
  } catch (error) {
    failure = toErrorObject(error, "Installed Startup diagnostics failed");
  }
  try {
    await lifetime.verifyCleanup(async () => {
      const results = await Promise.allSettled(
        createdPaths.map(async (pathname) => {
          await fs.rm(pathname);
          await assert.rejects(fs.lstat(pathname), { code: "ENOENT" });
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "Startup sibling cleanup failed");
      }
    });
  } catch (error) {
    failure = new AggregateError(failure ? [failure, error] : [error], "Startup fixture failed");
  }
  if (failure) {
    throw failure;
  }
  assert.ok(observation);
  return {
    ...observation,
    sourcePaths,
    sourceSha256: sourceHashes,
    startupEntryPaths: startupPaths,
    taskDefinitionsRestored: true,
    startupEntriesRemoved: true,
    launcherExecutionRequested: false,
    launcherScope:
      "CMD wrapper uses the maintained renderer; gateway CMD and VBS bytes come from the installed fixture.",
  };
}

export async function inspectInstalledStartupSiblings(
  params: InstalledStartupInspectionArgs & {
    expectedStatus: z.infer<typeof installedStatusSchema>;
  },
) {
  const { selected, launcher, expectedStatus, doctor, deepStatus } = params;
  return withInstalledStartupEntries(params, false, async (startupPaths) => {
    const report = await doctor(selected);
    assert.equal(report.checksRun, 1);
    const findings = report.findings.filter(
      (finding) =>
        finding.target &&
        normalizeWindowsTaskIdentity(finding.target) ===
          normalizeWindowsTaskIdentity(launcher.taskName),
    );
    assert.equal(findings.length, 2);
    for (const pathname of startupPaths) {
      const found = findings.filter((finding) => finding.message.includes(`startup: ${pathname}`));
      assert.equal(found.length, 1);
      assert.equal(found[0]?.checkId, "core/doctor/gateway-services/extra");
      assert.equal(found[0]?.severity, "info");
    }
    const value = await deepStatus(selected);
    const status = installedStatusSchema.parse(value);
    assert.deepEqual(status.service, expectedStatus.service);
    assert.deepEqual(status.rpc.server, expectedStatus.rpc.server);
    assert.deepEqual(status.gateway, expectedStatus.gateway);
    const { extraServices } = startupStatusExtrasSchema.parse(value);
    const siblings = extraServices.filter(
      (service) =>
        normalizeWindowsTaskIdentity(service.label) ===
        normalizeWindowsTaskIdentity(launcher.taskName),
    );
    assert.equal(siblings.length, 2);
    for (const pathname of startupPaths) {
      const found = siblings.filter((service) => service.windowsStartupEntry === pathname);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.platform, "win32");
      assert.equal(found[0]?.scope, "user");
      assert.equal(found[0]?.detail, `startup: ${pathname}`);
    }
    return { report, status, siblings, scope: "Task-present same-label Startup diagnostics" };
  });
}

export async function inspectInstalledSelectedStartupFallback(
  params: Omit<InstalledStartupInspectionArgs, "launcher"> & {
    expectedCommand: string[];
    canBindLoopbackPort: (port: number) => Promise<boolean>;
  },
) {
  const { selected, doctor, deepStatus, lifetime, expectedCommand, canBindLoopbackPort } = params;
  const { execSchtasks } = await import("./schtasks-exec.js");
  const { probeScheduledTaskState } = await import("./schtasks-state-probe.js");
  const { readScheduledTaskRuntime } = await import("./schtasks-runtime.js");
  const { readTaskXml, readRelatedProcessDiagnostics } =
    await import("./schtasks.integration-observation.test-support.js");
  const assertStopped = async () => {
    const runtime = await readScheduledTaskRuntime(selected.env, { requireLoaded: true });
    assert.equal(runtime.status, "stopped");
    assert.equal(runtime.pid, undefined);
    assert.equal(await canBindLoopbackPort(selected.gatewayPort), true);
    const processes = readRelatedProcessDiagnostics([selected.profile]);
    assert.equal(processes.ok, true);
    assert.equal(processes.truncated, false);
    assert.deepEqual(processes.processes, []);
  };
  await assertStopped();
  return withInstalledStartupEntries(
    { ...params, launcher: selected },
    true,
    async (startupPaths) => {
      const originalXml = await readTaskXml(selected.taskName);
      assert.ok(originalXml);
      const restorePath = path.join(selected.rootDir, "startup-restore-task.xml");
      await fs.writeFile(restorePath, `\uFEFF${originalXml}`, "utf16le");
      let failure: Error | undefined;
      let observation: Record<string, unknown> | undefined;
      try {
        assert.equal((await execSchtasks(["/Delete", "/F", "/TN", selected.taskName])).code, 0);
        assert.equal(probeScheduledTaskState(selected.taskName).status, "missing");
        await assertStopped();
        const aliasPath = startupPaths[2];
        assert.ok(aliasPath);
        const report = await doctor(selected);
        assert.equal(report.checksRun, 1);
        assert.equal(report.findings.length, 1);
        assert.equal(report.findings[0]?.target, selected.taskName);
        assert.equal(report.findings[0]?.checkId, "core/doctor/gateway-services/extra");
        assert.equal(report.findings[0]?.severity, "info");
        assert.ok(report.findings[0]?.message.includes(`startup: ${aliasPath}`));
        const value = await deepStatus(selected);
        const status = z
          .object({
            service: z.object({
              loaded: z.literal(true),
              runtime: z.object({
                status: z.literal("stopped"),
                pid: z.undefined(),
                detail: z.string(),
              }),
              command: z.object({ programArguments: z.array(z.string()) }),
            }),
            rpc: z.object({ ok: z.literal(false) }),
            gateway: z.object({ port: z.number().int().positive() }),
          })
          .parse(value);
        assert.match(status.service.runtime.detail, /^Startup-folder login item installed;/u);
        assert.deepEqual(status.service.command.programArguments, expectedCommand);
        assert.equal(status.gateway.port, selected.gatewayPort);
        const { extraServices } = startupStatusExtrasSchema.parse(value);
        assert.deepEqual(extraServices, [
          {
            platform: "win32",
            label: selected.taskName,
            detail: `startup: ${aliasPath}`,
            scope: "user",
            windowsStartupEntry: aliasPath,
          },
        ]);
        assert.equal(probeScheduledTaskState(selected.taskName).status, "missing");
        await assertStopped();
        observation = {
          report,
          status,
          extraServices,
          selectedStartupEntryPaths: startupPaths.slice(0, 2),
          aliasPath,
          scope:
            "Read-only selected Startup fallback classification with a positive same-label alias; no fallback update or protected-authority claim.",
        };
      } catch (error) {
        failure = toErrorObject(error, "Selected Startup fallback inspection failed");
      }
      try {
        await lifetime.verifyCleanup(async () => {
          assert.equal(
            (await execSchtasks(["/Create", "/F", "/TN", selected.taskName, "/XML", restorePath]))
              .code,
            0,
          );
          assert.equal(await readTaskXml(selected.taskName), originalXml);
          assert.equal(probeScheduledTaskState(selected.taskName).status, "found");
          await assertStopped();
        });
      } catch (error) {
        failure = new AggregateError(
          failure ? [failure, error] : [error],
          "Selected Startup Task restoration failed",
        );
      }
      if (failure) {
        throw failure;
      }
      assert.ok(observation);
      return observation;
    },
  );
}
