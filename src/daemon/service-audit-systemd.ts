/** Audits effective systemd service settings and managed unit backups. */
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceCommand, ServiceConfigIssue } from "./service-audit-types.js";
import { resolveManagedGatewayServiceCommand } from "./service-types.js";
import { execSystemctlUser } from "./systemd-exec.js";
import {
  resolveSystemdServiceName,
  resolveSystemdUnitPath,
  resolveSystemdEnvironmentFilePath,
} from "./systemd-service-files.js";
import { parseSystemdTimeSpanMs, SYSTEMD_DEFAULT_STOP_TIMEOUT_MS } from "./systemd-time-span.js";
import {
  parseSystemdEnvAssignments,
  splitSystemdLogicalLines,
  SYSTEMD_SERVICE_START_TIMEOUT_SECONDS,
  renderSystemdEnvironmentFile,
  SYSTEMD_FIXED_POLICY,
} from "./systemd-unit.js";

export const SYSTEMD_SERVICE_AUDIT_CODES = {
  systemdAfterNetworkOnline: "systemd-after-network-online",
  systemdRestartSec: "systemd-restart-sec",
  systemdWantsNetworkOnline: "systemd-wants-network-online",
  systemdKillModeProcessOrNone: "systemd-kill-mode-process-or-none",
  systemdKillModeControlGroup: "systemd-kill-mode-control-group",
  systemdUnitBackupUnsafe: "systemd-unit-backup-unsafe",
  systemdStopTimeout: "systemd-stop-timeout",
} as const;

const SYSTEMD_AUDIT_TIMEOUT_MS = 10_000;

function samePolicyValue(key: string, value: string, expected: string): boolean {
  if (!key.endsWith("Sec")) {
    return value === expected;
  }
  const parsed = parseSystemdTimeSpanMs(value);
  return parsed !== undefined && parsed === parseSystemdTimeSpanMs(expected);
}

function parseSystemdUnit(directives: Iterable<[string, string[]]>) {
  const captured = [...directives];
  const values = (key: string) =>
    captured.flatMap(([name, entries]) =>
      (key.includes(".") ? name === key : name.endsWith(`.${key}`)) ? entries : [],
    );
  const scalar = (key: string) => values(key).findLast(Boolean);
  const dependencies = (key: string) =>
    new Set(values(key).flatMap((value) => value.split(/\s+/u).filter(Boolean)));
  const stopTimeout =
    values("Service.TimeoutStopSec")
      .map((value) => (value ? parseSystemdTimeSpanMs(value) : SYSTEMD_DEFAULT_STOP_TIMEOUT_MS))
      .findLast((value) => value !== undefined) ?? SYSTEMD_DEFAULT_STOP_TIMEOUT_MS;
  return {
    after: dependencies("After"),
    wants: dependencies("Wants"),
    restartSec: scalar("RestartSec"),
    killMode: scalar("KillMode"),
    startTimeoutMs: parseSystemdTimeSpanMs(values("Service.TimeoutStartSec").at(-1) ?? ""),
    stopTimeoutMs: stopTimeout === 0 ? Infinity : stopTimeout,
  };
}

export async function auditSystemdUnit(
  env: Record<string, string | undefined>,
  issues: ServiceConfigIssue[],
  timeoutMs?: number,
  command?: GatewayServiceCommand,
) {
  const unitPath = resolveSystemdUnitPath(env);
  await auditSystemdUnitBackup(unitPath, issues);
  let content;
  try {
    content = await fs.readFile(unitPath, "utf8");
  } catch {
    return;
  }
  const definitions = new Map([[unitPath, readUnitDirectives(content)]]);
  for (const file of command?.definitionPaths ?? []) {
    if (file !== unitPath) {
      definitions.set(
        file,
        readUnitDirectives(await fs.readFile(file, "utf8").catch(() => "unreadable definition")),
      );
    }
  }

  // The manager owns merged drop-ins and dependency links. Fall back wholesale
  // to the captured unit and drop-ins when its bounded effective-state query fails.
  // `systemctl show` still exits 0 for masked and not-found units, with empty
  // After/Wants and RestartUSec=100ms defaults. Those are not loaded settings.
  const manager = await execSystemctlUser(
    env,
    [
      "show",
      `${resolveSystemdServiceName(env)}.service`,
      "--no-page",
      "--property",
      "After,Wants,RestartUSec,KillMode,LoadState,TimeoutStopUSec,TimeoutStartUSec",
    ],
    timeoutMs && timeoutMs > 0 ? timeoutMs : SYSTEMD_AUDIT_TIMEOUT_MS,
  );
  const entries = manager.code === 0 ? parseKeyValueOutput(manager.stdout, "=") : undefined;
  const loadState = normalizeLowercaseStringOrEmpty(entries?.loadstate);
  if (loadState && loadState !== "loaded") {
    return;
  }
  const parsed = entries
    ? {
        after: new Set(entries.after?.split(/\s+/).filter(Boolean)),
        wants: new Set(entries.wants?.split(/\s+/).filter(Boolean)),
        restartSec: entries.restartusec,
        killMode: entries.killmode,
        startTimeoutMs: parseSystemdTimeSpanMs(entries.timeoutstartusec ?? ""),
        stopTimeoutMs:
          parseSystemdTimeSpanMs(entries.timeoutstopusec ?? "") ?? SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
      }
    : parseSystemdUnit([...definitions.values()].flatMap((directives) => Array.from(directives)));
  if (
    parsed.startTimeoutMs !== undefined &&
    parsed.startTimeoutMs !== SYSTEMD_SERVICE_START_TIMEOUT_SECONDS * 1_000
  ) {
    issues.push({
      code: "systemd-start-timeout",
      definitionKey: "Service.TimeoutStartSec",
      message: `TimeoutStartSec differs from the installer default of ${SYSTEMD_SERVICE_START_TIMEOUT_SECONDS}s.`,
      detail: unitPath,
      level: "recommended",
    });
  }
  if (parsed.stopTimeoutMs > 0 && parsed.stopTimeoutMs < GATEWAY_SERVICE_STOP_TIMEOUT_MS) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdStopTimeout,
      definitionKey: "Service.TimeoutStopSec",
      message: `TimeoutStopSec=${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000} or longer is required for the Gateway drain and final cleanup; inspect unit and drop-in overrides.`,
      detail: `${unitPath}: ${parsed.stopTimeoutMs / 1_000}s (${entries ? "systemd manager" : "base unit; manager unavailable"})`,
      level: "recommended",
    });
  }
  if (!parsed.after.has("network-online.target")) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdAfterNetworkOnline,
      definitionKey: "Unit.After",
      message: "Missing systemd After=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (!parsed.wants.has("network-online.target")) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdWantsNetworkOnline,
      definitionKey: "Unit.Wants",
      message: "Missing systemd Wants=network-online.target",
      detail: unitPath,
      level: "recommended",
    });
  }
  if (Math.abs((parseSystemdTimeSpanMs(parsed.restartSec ?? "") ?? 0) - 5_000) >= 10) {
    issues.push({
      code: SYSTEMD_SERVICE_AUDIT_CODES.systemdRestartSec,
      definitionKey: "Service.RestartSec",
      message: "RestartSec does not match the recommended 5s",
      detail: unitPath,
      level: "recommended",
    });
  }
  const killMode = normalizeLowercaseStringOrEmpty(parsed.killMode) || "control-group";
  if (killMode !== "mixed") {
    issues.push({
      code:
        killMode === "process" || killMode === "none"
          ? SYSTEMD_SERVICE_AUDIT_CODES.systemdKillModeProcessOrNone
          : SYSTEMD_SERVICE_AUDIT_CODES.systemdKillModeControlGroup,
      message:
        "KillMode=mixed is required to drain active turns before final service child cleanup; inspect unit and drop-in overrides.",
      definitionKey: "Service.KillMode",
      detail: `${unitPath}: ${killMode}`,
      level: "recommended",
    });
  }
  if (command?.sourcePath) {
    const effectiveDrift = new Set(issues.map((issue) => issue.definitionKey));
    const reportDefinition = (key: string, detail: string, blocked: boolean) => {
      const message = blocked
        ? `Systemd ${key} cannot be reconciled automatically; the installer cannot preserve this operator edit.`
        : `Systemd ${key} differs from the current installer default.`;
      const existing = issues.find((issue) => issue.definitionKey === key);
      if (!existing) {
        issues.push({
          code: "systemd-definition-edit",
          definitionKey: key,
          detail,
          message,
          ...(blocked ? { rewriteBlocked: true } : {}),
          level: "recommended",
        });
      } else if (blocked) {
        Object.assign(existing, { message, detail, rewriteBlocked: true });
      }
    };
    // v2026.7.1-2 used 30s/control-group; v2026.3.1 used process.
    // Both v2026.7.1-2 and v2026.9.4 used the older startup limits.
    const releasedValues: Record<string, readonly string[]> = {
      "Unit.StartLimitBurst": ["5"],
      "Unit.StartLimitIntervalSec": ["60"],
      "Service.TimeoutStopSec": ["30"],
      "Service.KillMode": ["control-group", "process"],
    };
    for (const [key, expected] of Object.entries(SYSTEMD_FIXED_POLICY)) {
      const values = definitions.get(unitPath)?.get(key);
      const dependency = key === "Unit.After" || key === "Unit.Wants";
      const changed = dependency
        ? values?.some((value) => value.split(/\s+/u).some((item) => item && item !== expected))
        : !values || values.some((value) => !samePolicyValue(key, value, expected));
      if (changed) {
        const blocked =
          values &&
          (dependency ||
            values.some(
              (value) =>
                ![expected, ...(releasedValues[key] ?? [])].some((allowed) =>
                  samePolicyValue(key, value, allowed),
                ),
            ));
        reportDefinition(key, unitPath, Boolean(blocked));
      }
    }
    const environment = resolveManagedGatewayServiceCommand(command)?.environment;
    const environmentFile = renderSystemdEnvironmentFile(
      resolveSystemdEnvironmentFilePath({
        stateDir: resolveStateDir({ ...env, ...environment }),
        environment,
      }),
    );
    for (const [file, definition] of definitions) {
      for (const [key, values] of definition) {
        const drift = issues.find((issue) => issue.definitionKey === key);
        const fixedPolicy = SYSTEMD_FIXED_POLICY[key];
        const managerAudited =
          /^Service\.(?:RestartSec|TimeoutStartSec|TimeoutStopSec|KillMode)$/u.test(key);
        const conflictingDropIn =
          key !== "Unit.After" &&
          key !== "Unit.Wants" &&
          (managerAudited
            ? effectiveDrift.has(key)
            : fixedPolicy === undefined
              ? Boolean(drift)
              : values.some((value) => !samePolicyValue(key, value, fixedPolicy)));
        const customEnvironmentFile =
          file === unitPath &&
          key === "Service.EnvironmentFile" &&
          values.some((value) => value !== environmentFile);
        if (
          (file === unitPath && !MANAGED_SYSTEMD_KEYS.has(key)) ||
          customEnvironmentFile ||
          (file !== unitPath && conflictingDropIn)
        ) {
          reportDefinition(key, file, true);
        }
      }
    }
  }
}

// These are the fields the installer owns or explicitly preserves. Other
// directives are operator behavior that rewriting the base unit would discard.
const MANAGED_SYSTEMD_KEYS = new Set([
  ...Object.keys(SYSTEMD_FIXED_POLICY),
  "Unit.Description",
  "Service.ExecStart",
  "Service.WorkingDirectory",
  "Service.Environment",
  "Service.EnvironmentFile",
]);

function readUnitDirectives(content: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  let section = "";
  for (const raw of splitSystemdLogicalLines(content)) {
    const line = raw.trim();
    if (!line || /^[#;]/u.test(line)) {
      continue;
    }
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    const separator = line.indexOf("=");
    const key = `${section}.${separator > 0 ? line.slice(0, separator).trim() : "unsupported syntax"}`;
    directives.set(key, [...(directives.get(key) ?? []), line.slice(separator + 1).trim()]);
  }
  return directives;
}

async function auditSystemdUnitBackup(unitPath: string, issues: ServiceConfigIssue[]) {
  const backupPath = `${unitPath}.bak`;
  let stat;
  try {
    stat = await fs.lstat(backupPath);
  } catch {
    return;
  }
  const mode = stat.mode & 0o777;
  const embeddedKeys = new Set<string>();
  let unreadable = false;
  if (stat.isFile()) {
    const content = await fs.readFile(backupPath, "utf8").catch(() => {
      unreadable = true;
      return "";
    });
    for (const rawLine of splitSystemdLogicalLines(content)) {
      const line = rawLine.trim();
      const separator = line.indexOf("=");
      if (separator < 0 || line.slice(0, separator).trim() !== "Environment") {
        continue;
      }
      for (const { key, value } of parseSystemdEnvAssignments(line.slice(separator + 1).trim())) {
        const normalizedKey = key.toUpperCase();
        if (
          value &&
          (normalizedKey === "OPENCLAW_GATEWAY_TOKEN" ||
            normalizedKey === "OPENCLAW_GATEWAY_PASSWORD")
        ) {
          embeddedKeys.add(normalizedKey);
        }
      }
    }
  }
  if (stat.isFile() && !unreadable && embeddedKeys.size === 0 && (mode & 0o077) === 0) {
    return;
  }
  const detail = [
    backupPath,
    !stat.isFile() ? "not a regular file" : undefined,
    unreadable ? "unreadable" : undefined,
    embeddedKeys.size > 0 ? `embedded keys: ${[...embeddedKeys].toSorted().join(", ")}` : undefined,
    (mode & 0o077) !== 0 ? `mode: ${mode.toString(8).padStart(3, "0")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
  issues.push({
    code: SYSTEMD_SERVICE_AUDIT_CODES.systemdUnitBackupUnsafe,
    message:
      embeddedKeys.size > 0
        ? "Systemd service backup exposes gateway credentials; reinstall the service and rotate the embedded credentials."
        : "Systemd service backup is unsafe; reinstall the service to replace it.",
    detail,
    level: "recommended",
  });
}
