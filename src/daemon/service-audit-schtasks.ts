import fs from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "linkedom";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { decodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { execFileUtf8 } from "./exec-file.js";
import { readScheduledTaskDefinition } from "./schtasks-install-files.js";
import {
  buildHiddenLauncherScript,
  buildScheduledTaskXml,
  buildTaskScript,
  readScheduledTaskCommand,
  resolveTaskScriptPath,
  resolveTaskUser,
  SCHEDULED_TASK_RESTART_POLICY,
} from "./schtasks-layout.js";
import type { ServiceConfigIssue } from "./service-audit-types.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  WINDOWS_TASK_LAUNCHER_ENV,
  WINDOWS_TASK_SUPERVISOR_FLAG,
} from "./windows-task-supervisor-contract.js";

function normalizedLauncher(content: string, vbs = false): string {
  const script = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^rem(?:\s[^&|<>^]*|)$/iu.test(line) && !(vbs && line.startsWith("'")),
    )
    .join("\n")
    .replace(/\s*<\s*NUL$/iu, "");
  // v2026.7.1-2 predates the generated batch supervisor suffix.
  return vbs ? script : script.replace(new RegExp(` ${WINDOWS_TASK_SUPERVISOR_FLAG}$`, "u"), "");
}

function elementKey(node: ReturnType<DOMParser["parseFromString"]>["documentElement"]): string {
  return !node.parentElement || node.parentElement.tagName === "Task"
    ? node.tagName
    : `${elementKey(node.parentElement)}.${node.tagName}`;
}

export async function auditScheduledTaskDefinition(
  env: GatewayServiceEnv,
  issues: ServiceConfigIssue[],
  timeoutMs?: number,
  taskAutoStartSuspended = false,
): Promise<void> {
  const scriptPath = resolveTaskScriptPath(env);
  const finding = (key: string, blocked = false, detail = scriptPath) =>
    issues.push({
      code: "schtasks-definition-drift",
      definitionKey: key,
      message: blocked
        ? `Scheduled Task ${key} cannot be preserved by the installer; the definition was preserved.`
        : `Scheduled Task ${key} differs from the current installer definition.`,
      detail,
      level: "recommended",
      ...(blocked ? { rewriteBlocked: true } : {}),
    });
  try {
    const xml = await readScheduledTaskDefinition(env);
    if (xml === null) {
      return;
    }
    const parser = new DOMParser();
    const installed = parser.parseFromString(xml, "text/xml");
    if (installed.documentElement?.tagName !== "Task" || installed.doctype) {
      finding("definition", true);
      return;
    }
    const taskUser = resolveTaskUser(env);
    const expected = parser.parseFromString(
      buildScheduledTaskXml({
        taskDescription: "",
        taskUser,
        launchPath: scriptPath,
      }),
      "text/xml",
    );
    // Task Scheduler exports account names as SIDs; compare the installer's actual account.
    let userSid: string | undefined;
    const taskUsers = [
      installed.querySelector("Principals > Principal > UserId"),
      installed.querySelector("Triggers > LogonTrigger > UserId"),
    ];
    if (
      taskUser &&
      taskUsers.some((node) => node && node.textContent.toLowerCase() !== taskUser.toLowerCase())
    ) {
      const encodedUser = Buffer.from(taskUser).toString("base64");
      const identity = await execFileUtf8(
        getWindowsPowerShellExePath(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop'; $name=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUser}')); ([Security.Principal.NTAccount]$name).Translate([Security.Principal.SecurityIdentifier]).Value`,
        ],
        { timeout: timeoutMs ?? 15_000 },
      );
      if (identity.code === 0 && /^S-1-[\d-]+$/u.test(identity.stdout.trim())) {
        userSid = identity.stdout.trim();
      }
    }
    const nativeDefaults: Record<string, string> = {
      "Settings.UseUnifiedSchedulingEngine": "false",
      "Settings.DisallowStartOnRemoteAppSession": "false",
      "Settings.Volatile": "false",
    };
    // v2026.7.1-2 retained old ONLOGON battery defaults on failed XML upgrades
    // and passed /NP on creation, which could replace InteractiveToken with S4U.
    const releasedDefaults: Record<string, string> = {
      "Settings.DisallowStartIfOnBatteries": "true",
      "Settings.StopIfGoingOnBatteries": "true",
      "Principals.Principal.LogonType": "S4U",
    };
    const preserved =
      /^(?:RegistrationInfo\.(?:Description|Date|Author|URI)|Actions\.Exec\.Command)$/u;
    const seen = new Set<string>();
    // Extra actions, triggers, settings, and duplicate fields would disappear on reinstall.
    for (const node of [installed.documentElement, ...installed.querySelectorAll("Task *")]) {
      const key = elementKey(node);
      const duplicate = seen.has(key);
      seen.add(key);
      const canonical = expected.querySelector(key.replaceAll(".", " > "));
      for (const attribute of new Set([
        ...node.getAttributeNames(),
        ...(canonical?.getAttributeNames() ?? []),
      ])) {
        if (
          !(key === "Task" && attribute === "version") &&
          node.getAttribute(attribute) !== canonical?.getAttribute(attribute)
        ) {
          finding(`${key}.@${attribute}`, true);
        }
      }
      const matchingUser =
        node.tagName === "UserId" &&
        canonical &&
        taskUser &&
        (node.textContent.toLowerCase() === taskUser.toLowerCase() || node.textContent === userSid);
      const releasedDefault =
        canonical && !node.children.length && releasedDefaults[key] === node.textContent;
      if (releasedDefault) {
        finding(key.replace(/^Settings\./u, ""));
      }
      if (
        duplicate ||
        (!preserved.test(key) &&
          !(taskAutoStartSuspended && key === "Settings.Enabled" && node.textContent === "false") &&
          !matchingUser &&
          !releasedDefault &&
          !/^Settings\.RestartOnFailure(?:\.(?:Count|Interval))?$/u.test(key) &&
          nativeDefaults[key] !== node.textContent &&
          (!canonical || (!node.children.length && node.textContent !== canonical.textContent)))
      ) {
        finding(key, true);
      }
    }
    for (const node of expected.querySelectorAll(
      "Principal > UserId, Principal > GroupId, Principal > LogonType, LogonTrigger > UserId",
    )) {
      const key = elementKey(node);
      if (!seen.has(key)) {
        finding(key, true);
      }
    }
    // v2026.7.1-2 omitted retries; absent/zero settings represent that disabled policy.
    for (const [key, value] of Object.entries(SCHEDULED_TASK_RESTART_POLICY)) {
      const current = installed.querySelector(`Settings > RestartOnFailure > ${key}`)?.textContent;
      if (current !== value) {
        finding(
          `RestartOnFailure.${key}`,
          current !== undefined && current !== (key === "Count" ? "0" : "PT0S"),
        );
      }
    }
    const nativeLauncher = installed.querySelector("Actions > Exec > Command")?.textContent;
    const hiddenPath = scriptPath.replace(/\.cmd$/iu, ".vbs");
    const samePath = (left: string, right: string) =>
      path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
    if (
      !nativeLauncher ||
      ![scriptPath, hiddenPath].some((value) => samePath(value, nativeLauncher))
    ) {
      finding("Actions.Exec.Command", true);
    }
    const command = await readScheduledTaskCommand(env, { requireEffective: true, timeoutMs });
    const content = decodeWindowsLauncherScript({ buffer: await fs.readFile(scriptPath) });
    const generated = command ? buildTaskScript(command) : "";
    // v2026.7.1-2 persisted this launcher preference; the current writer consumes it.
    const installedScript =
      command?.environment?.[WINDOWS_TASK_LAUNCHER_ENV] === "1"
        ? content.replace(/^set "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER=1"\r?\n/mu, "")
        : content;
    if (!command || normalizedLauncher(installedScript) !== normalizedLauncher(generated)) {
      finding("TaskScript", true);
    }
    if (nativeLauncher && samePath(nativeLauncher, hiddenPath)) {
      const launcher = decodeWindowsLauncherScript({ buffer: await fs.readFile(hiddenPath) });
      // The v2026.7.1-2 hidden launcher exited immediately; reinstall upgrades its wait policy.
      const legacyLauncher = `CreateObject("WScript.Shell").Run """${scriptPath.replaceAll('"', '""')}""", 0, False`;
      const currentLauncher = buildHiddenLauncherScript({
        scriptPath,
        taskSupervisor: command?.environment?.OPENCLAW_SERVICE_KIND === "gateway",
      });
      if (
        ![legacyLauncher, currentLauncher].some(
          (value) => normalizedLauncher(launcher, true) === normalizedLauncher(value, true),
        )
      ) {
        finding("TaskLauncher", true, hiddenPath);
      }
    }
  } catch {
    finding("definition", true);
  }
}
