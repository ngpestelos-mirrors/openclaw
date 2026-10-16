import { afterEach, expect, it, vi } from "vitest";
import { updateStatusCommand } from "./status.js";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  run: vi.fn(),
  writeJson: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks }));
vi.mock("./shared.js", () => ({
  resolveUpdateRoot: async () => "/fixture/openclaw",
  parseUpdateTimeoutMs: () => 1000,
}));
vi.mock("../../config/config.js", () => ({
  readSourceConfigBestEffort: async () => ({ gateway: { mode: "remote" } }),
}));
vi.mock("../../commands/node-runtime-diagnostics.js", () => ({
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../config/validation-core.js", () => ({
  validateConfigObjectRaw: () => ({ ok: true }),
}));
vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  readGatewayLastInstallationReplacementAsync: async () => undefined,
}));
vi.mock("../../infra/package-update-activation.js", () => ({
  readPackageActivationReceipt: () => undefined,
}));
vi.mock(
  "../../state/openclaw-state-db-readonly.js",
  async () => import("../../state/artifact-preserving-state-reads.js"),
);
vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: mocks.check,
  formatGitInstallLabel: () => undefined,
  compareSemverStrings: () => 0,
}));
vi.mock("../../infra/update-run-status.js", () => ({ readUpdateRunStatus: mocks.run }));
vi.mock("../../infra/update-recovery-backup-status.js", () => ({
  inspectUpdateRecoveryBackups: async () => [],
}));
vi.mock("../../infra/deferred-plugin-migrations.js", () => ({
  readDeferredPluginMigrationsAsync: async () => [],
  formatDeferredPluginMigration: () => "",
}));
vi.mock("../../commands/doctor-session-sqlite-warnings.js", () => ({
  readSessionSqliteMigrationWarnings: () => [],
}));
vi.mock("../../gateway/call.js", () => ({ callGateway: async () => ({}) }));
vi.mock("../../infra/device-identity-async.js", () => ({
  loadDeviceIdentityIfPresentAsync: async () => null,
}));
vi.mock("../../infra/device-identity.js", () => ({ loadDeviceIdentityIfPresent: () => null }));
vi.mock("../../infra/channels-status-issues.js", () => ({ collectChannelStatusIssues: () => [] }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each(["installation", "update history"])(
  "returns partial JSON at the overall deadline when %s never settles",
  async (section) => {
    const update = {
      root: "/fixture/openclaw",
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "2026.9.8" },
    };
    mocks.check.mockResolvedValue(update);
    mocks.run.mockResolvedValue({});
    (section === "installation" ? mocks.check : mocks.run).mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const pending = updateStatusCommand({ json: true });
    await vi.advanceTimersByTimeAsync(1001);
    expect(mocks.writeJson).toHaveBeenCalledOnce();
    expect(mocks.writeJson.mock.lastCall?.[0].inspectionErrors).toContainEqual({
      section,
      message: expect.stringMatching(/timed out.*1.*second/i),
    });
    if (section === "update history") {
      expect(mocks.writeJson.mock.lastCall?.[0].update).toEqual(update);
    }
    await pending;
  },
);
