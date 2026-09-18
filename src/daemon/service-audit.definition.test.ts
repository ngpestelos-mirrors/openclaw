import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { buildSystemdUnit } from "./systemd-unit.js";
import { resetServiceAuditMocks } from "./test-helpers/service-audit-fixtures.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetServiceAuditMocks);

async function auditUnit(change: (unit: string) => string, dropIn?: string) {
  const home = dirs.make("service-definition-audit-");
  const unitPath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
  const command = {
    programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "gateway", "--port", "18789"],
    environment: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--max-old-space-size=4096" },
    sourcePath: unitPath,
    definitionPaths: [unitPath],
  };
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, change(buildSystemdUnit(command)));
  if (dropIn) {
    const dropInPath = `${unitPath}.d/operator.conf`;
    await fs.mkdir(path.dirname(dropInPath));
    await fs.writeFile(dropInPath, dropIn);
    command.definitionPaths.push(dropInPath);
  }
  return await auditGatewayServiceConfig({ env: { HOME: home }, platform: "linux", command });
}

it("names missing installer policy keys without treating preserved heap settings as unknown edits", async () => {
  const audit = await auditUnit((unit) => unit.replace("KillMode=mixed\n", ""));
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: "Service.KillMode" }),
  );
  expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
});

it.each(["ExecStartPre", "EnvironmentFile"])(
  "reports an unknown operator %s without exposing its value",
  async (key) => {
    const audit = await auditUnit((unit) =>
      unit.replace("[Service]", `[Service]\n${key}=/private/operator-script`),
    );
    expect(audit.issues).toContainEqual(
      expect.objectContaining({
        definitionKey: `Service.${key}`,
        rewriteBlocked: true,
      }),
    );
    expect(JSON.stringify(audit.issues)).not.toContain("/private/operator-script");
  },
);

it("reports the drop-in key that the installer cannot reconcile", async () => {
  const audit = await auditUnit((unit) => unit, "[Service]\nKillMode=process\n");
  expect(audit.issues).toContainEqual(
    expect.objectContaining({
      definitionKey: "Service.KillMode",
      rewriteBlocked: true,
      detail: expect.stringContaining("operator.conf"),
    }),
  );
});

it("allows base-unit repair while retaining unrelated operator drop-ins", async () => {
  const audit = await auditUnit(
    (unit) => unit.replace("KillMode=mixed\n", ""),
    "[Service]\nMemoryMax=2G\nTimeoutStopSec=600\nEnvironment=OPERATOR_SETTING=retained\n",
  );
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: "Service.KillMode" }),
  );
  expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
});

it.each([
  { key: "RestartSec", value: "120", blocked: true, reported: true },
  { key: "TimeoutStartSec", value: "0", blocked: true, reported: true },
  { key: "TimeoutStopSec", value: "600", blocked: true, reported: true },
  { key: "TimeoutStopSec", value: "30s", blocked: false, reported: true },
  { key: "KillMode", value: "control-group", blocked: false, reported: true },
  { key: "KillMode", value: "process", blocked: false, reported: true },
  { key: "KillMode", value: "none", blocked: true, reported: true },
  { key: "TimeoutStartSec", value: undefined, blocked: false, reported: true },
  { key: "TimeoutStopSec", value: undefined, blocked: false, reported: true },
  { key: "RestartSec", value: "5000ms", blocked: false, reported: false },
  { key: "TimeoutStopSec", value: "5min 30s", blocked: false, reported: false },
])(
  "preserves unknown systemd $key=$value and upgrades released policy",
  async ({ key, value, blocked, reported }) => {
    const audit = await auditUnit((unit) => {
      const changed = unit.replace(
        new RegExp(`^${key}=.*\\n`, "mu"),
        value === undefined ? "" : `${key}=${value}\n`,
      );
      return key === "KillMode" ? changed : changed.replace("KillMode=mixed\n", "");
    });
    const findings = audit.issues.filter((issue) => issue.definitionKey === `Service.${key}`);
    expect(findings).toHaveLength(reported ? 1 : 0);
    if (reported) {
      expect(Boolean(findings[0]!.rewriteBlocked)).toBe(blocked);
    }
    expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(blocked);
  },
);

it.each([
  {
    key: "Service.Restart",
    change: (unit: string) => unit.replace("Restart=always", "Restart=no"),
  },
  {
    key: "Service.Type",
    change: (unit: string) => unit.replace("[Service]", "[Service]\nType=forking"),
  },
  {
    key: "Install.WantedBy",
    change: (unit: string) => unit.replace("WantedBy=default.target", "WantedBy=multi-user.target"),
  },
])("preserves an unsupported operator value for $key", async ({ key, change }) => {
  const audit = await auditUnit(change);
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: key, rewriteBlocked: true }),
  );
});

it("detects a missing fixed installer policy as repairable drift", async () => {
  const audit = await auditUnit((unit) => unit.replace("Restart=always\n", ""));
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: "Service.Restart" }),
  );
  expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
});

it.each([
  {
    name: "conflicting override over a canonical base",
    missingBase: false,
    restart: "no",
    blocked: true,
  },
  {
    name: "matching override while repairing a missing base setting",
    missingBase: true,
    restart: "always",
    blocked: false,
  },
])("audits fixed policy in a drop-in: $name", async ({ missingBase, restart, blocked }) => {
  const audit = await auditUnit(
    (unit) => (missingBase ? unit.replace("Restart=always\n", "") : unit),
    `[Service]\nRestart=${restart}\n`,
  );
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: "Service.Restart" }),
  );
  expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(blocked);
  if (blocked) {
    expect(audit.issues).toContainEqual(
      expect.objectContaining({
        definitionKey: "Service.Restart",
        rewriteBlocked: true,
        detail: expect.stringContaining("operator.conf"),
      }),
    );
  }
});

it.each(["After", "Wants"])("preserves additional base-unit %s dependencies", async (key) => {
  const audit = await auditUnit((unit) =>
    unit.replace(`${key}=network-online.target`, `${key}=network-online.target database.service`),
  );
  expect(audit.issues).toContainEqual(
    expect.objectContaining({ definitionKey: `Unit.${key}`, rewriteBlocked: true }),
  );
});

it("retains additional drop-in dependencies while repairing the managed base", async () => {
  const audit = await auditUnit(
    (unit) => unit.replace("KillMode=mixed\n", ""),
    "[Unit]\nAfter=database.service\nWants=database.service\n",
  );
  expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
});

it.each([
  {
    name: "Node debugger",
    native: ["--inspect=127.0.0.1:9229"],
    gateway: [],
    cwd: undefined,
    key: "ProgramArguments",
  },
  {
    name: "Gateway option",
    native: [],
    gateway: ["--verbose"],
    cwd: undefined,
    key: "ProgramArguments",
  },
  {
    name: "working directory",
    native: [],
    gateway: [],
    cwd: "/operator/private-working-directory",
    key: "WorkingDirectory",
  },
])(
  "preserves an installer-discarded $name without echoing values",
  async ({ native, gateway, cwd, key }) => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: dirs.make("command-preservation-") },
      platform: "linux",
      command: {
        programArguments: ["/usr/bin/node", ...native, "/old/entry.js", "gateway", ...gateway],
        workingDirectory: cwd,
      },
      expectedCommand: { programArguments: ["/new/node", "/new/entry.js", "gateway"] },
    });
    expect(audit.issues).toContainEqual(
      expect.objectContaining({ definitionKey: key, rewriteBlocked: true }),
    );
    const findings = audit.issues.filter((issue) => issue.rewriteBlocked);
    expect(JSON.stringify(findings)).not.toContain("127.0.0.1:9229");
    expect(JSON.stringify(findings)).not.toContain("/operator/private-working-directory");
  },
);

it.each([
  { native: ["--max_old_space_size", "4096"], expected: ["--max-old-space-size=4096"] },
  {
    native: ["--max-old-space-size=2048", "--max_old_space_size=4096"],
    expected: ["--max-old-space-size=4096"],
  },
  { native: [], expected: ["--max-old-space-size=8192"] },
  { native: ["--inspect=127.0.0.1:9229"], expected: ["--inspect=127.0.0.1:9229"] },
])(
  "retains settings present in the install plan and managed start/port changes (%j)",
  async ({ native, expected }) => {
    const audit = await auditGatewayServiceConfig({
      env: { HOME: dirs.make("command-preservation-heap-") },
      platform: "linux",
      command: {
        programArguments: [
          "/old/node",
          ...native,
          "/old/entry.js",
          "gateway",
          "--port=1234",
          "--allow-unconfigured",
        ],
        environment: { NODE_OPTIONS: "--max-heap-size=8192", OPERATOR_SETTING: "retained" },
      },
      expectedCommand: {
        programArguments: ["/new/node", ...expected, "/new/entry.js", "gateway", "--port", "4321"],
      },
    });
    expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(false);
  },
);

it.each(["5", "99"])(
  "recognizes released startup limits without allowing unknown values (burst=%s)",
  async (burst) => {
    const audit = await auditUnit((unit) =>
      unit
        .replace("StartLimitBurst=10", `StartLimitBurst=${burst}`)
        .replace("StartLimitIntervalSec=300", "StartLimitIntervalSec=60")
        .replace("KillMode=mixed\n", ""),
    );
    expect(audit.issues.map((issue) => issue.definitionKey)).toEqual(
      expect.arrayContaining([
        "Unit.StartLimitBurst",
        "Unit.StartLimitIntervalSec",
        "Service.KillMode",
      ]),
    );
    expect(audit.issues.some((issue) => issue.rewriteBlocked)).toBe(burst === "99");
  },
);
