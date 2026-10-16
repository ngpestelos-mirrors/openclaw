import "../../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateScheduleState } from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { writeRestartSentinel } from "../../infra/restart-sentinel.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { UpdateCampaignController } from "../../infra/update-campaign.js";
import {
  createGatewayUpdateLifecycle,
  type UpdateCheckLifecycle,
} from "../../infra/update-check-lifecycle.js";
import type { resolveStartupInstallStatus } from "../../infra/update-install-status.js";
import type { startManagedServiceUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import type { resolveUpdateInstallSurface } from "../../infra/update-runner-install-surface.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import type { RespondFn } from "./types.js";

let ledgerHome: TempHomeEnv | undefined;
let lifecycle: UpdateCheckLifecycle;
afterEach(async () => {
  await lifecycle.stop();
  await ledgerHome?.restore();
  ledgerHome = undefined;
});

let currentCampaignId: string | undefined;
let updateSchedule: UpdateScheduleState | null;
let updateChannel: "stable" | "beta" | "dev" | null;
const sentinelAdmission = vi.hoisted((): { beforeGrant?: (stage: string) => void } => ({}));
type UpdateCampaignAdoption = ReturnType<UpdateCampaignController["adopt"]>;

const adoptCampaignMock = vi.fn<() => UpdateCampaignAdoption>();
const clearCampaignMock = vi.fn();
const getCampaignStateMock = vi.fn(() =>
  currentCampaignId
    ? {
        id: currentCampaignId,
        state: "applying" as const,
        announcedAtMs: 1,
        forceAtMs: 2,
        updatedAtMs: 1,
      }
    : undefined,
);

const resolveUpdateInstallSurfaceMock = vi.fn<typeof resolveUpdateInstallSurface>();
const resolveStartupInstallStatusMock = vi.fn<typeof resolveStartupInstallStatus>();
const detectRespawnSupervisorMock = vi.fn<() => RespawnSupervisor | null>();
const startManagedServiceUpdateHandoffMock = vi.fn<typeof startManagedServiceUpdateHandoff>();
const logGatewayInfoMock = vi.fn();
const writeRestartSentinelMock = vi.fn<
  (...args: Parameters<typeof writeRestartSentinel>) => Promise<unknown>
>(async () => undefined);
const recordLatestUpdateRestartSentinelMock = vi.fn();

vi.mock("../../config/commands.flags.js", () => ({ isRestartEnabled: () => true }));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: async () => ({ valid: false }),
}));

vi.mock("../../config/sessions.js", () => ({ extractDeliveryInfo: () => ({}) }));

vi.mock("../../infra/gateway-supervision.js", () => ({
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON: "external-supervisor-update-required",
  isGatewayExternallySupervised: () => false,
}));

vi.mock("../../infra/package-json.js", () => ({ readPackageVersion: async () => "1.0.0" }));

vi.mock("../../infra/restart-sentinel.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-sentinel.js")>()),
  writeRestartSentinel: writeRestartSentinelMock,
}));

vi.mock("../../infra/sqlite-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/sqlite-worker-store.js")>();
  return {
    ...actual,
    createSqliteWorkerWriteAdmission: (
      assertCurrent: Parameters<typeof actual.createSqliteWorkerWriteAdmission>[0],
      nativeLocations: readonly string[],
    ) =>
      actual.createSqliteWorkerWriteAdmission((request) => {
        sentinelAdmission.beforeGrant?.(request.stage);
        assertCurrent(request);
      }, nativeLocations),
  };
});

vi.mock("../../infra/restart.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/restart.js")>("../../infra/restart.js")),
  scheduleGatewayRestart: vi.fn(() => ({ scheduled: true })),
}));

vi.mock("../../infra/supervisor-markers.js", () => ({
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

vi.mock("../../daemon/gateway-entrypoint.js", async (original) => ({
  ...(await original<typeof import("../../daemon/gateway-entrypoint.js")>()),
  resolveGatewayInstallEntrypoint: async (root: string) => `${root}/dist/index.js`,
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: () =>
    detectRespawnSupervisorMock.mock.results.at(-1)?.value
      ? undefined
      : {
          owner: "foreground-owner",
          pid: process.pid,
          host: "fixture-host",
          startedAt: 1,
          port: 18789,
          mode: "foreground",
          state: "live",
          expired: false,
          supervisor: null,
        },
}));

vi.mock("../../infra/update-check-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/update-check-lifecycle.js")>();
  return {
    ...actual,
    currentUpdateCheckLifecycle: () => ({
      ...actual.currentUpdateCheckLifecycle(),
      campaign: {
        adopt: adoptCampaignMock,
        clear: clearCampaignMock,
        getState: getCampaignStateMock,
        bindRun: vi.fn(),
      },
    }),
  };
});

vi.mock("../../infra/update-campaign.js", () => ({
  UpdateCampaignController: function unexpectedCampaignConstruction() {
    throw new Error("update.run must consume its existing campaign owner");
  },
}));

vi.mock("../../infra/update-channels.js", async (original) => ({
  ...(await original<typeof import("../../infra/update-channels.js")>()),
  normalizeUpdateChannel: () => updateChannel,
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  claimManagedServiceUpdateHandoff: () => true,
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoff: async () => true,
  cancelManagedServiceUpdateHandoff: async () => "restored-in-process",
}));

vi.mock("../../infra/update-runner-install-surface.js", () => ({
  resolveUpdateInstallSurface: resolveUpdateInstallSurfaceMock,
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: () => null,
  getUpdateSchedule: () => updateSchedule,
}));

vi.mock("../../infra/update-install-status.js", () => ({
  resolveStartupInstallStatus: resolveStartupInstallStatusMock,
}));

vi.mock("../../version.js", () => ({ VERSION: "1.0.0" }));

vi.mock("../server-update-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-update-sentinel.js")>()),
  getLatestUpdateRestartSentinel: () => null,
  recordLatestUpdateRestartSentinel: recordLatestUpdateRestartSentinelMock,
  prepareLatestUpdateRestartSentinel: async () => null,
}));

vi.mock("./restart-request.js", () => ({ parseRestartRequestParams: () => ({}) }));

beforeEach(async () => {
  ledgerHome = await createTempHomeEnv("openclaw-update-campaign-rpc-");
  lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler());
  currentCampaignId = "campaign-1";
  updateSchedule = null;
  updateChannel = null;
  adoptCampaignMock.mockReset().mockReturnValue({
    status: "adopted",
    campaignId: "campaign-1",
    target: { kind: "package", version: "2.0.0" },
  });
  clearCampaignMock.mockClear();
  getCampaignStateMock.mockClear();
  startManagedServiceUpdateHandoffMock.mockReset().mockImplementation(async (params) => ({
    status: "started",
    pid: 12345,
    command: "openclaw update --yes --timeout 1800",
    logPath: "/tmp/fixture.log",
    handoffId: "handoff-1",
    installRoot: params.root,
  }));
  resolveUpdateInstallSurfaceMock.mockReset().mockResolvedValue({
    kind: "git",
    mode: "git",
    root: "/tmp/openclaw",
    packageRoot: "/tmp/openclaw",
  });
  resolveStartupInstallStatusMock.mockReset().mockResolvedValue(installStatus());
  detectRespawnSupervisorMock.mockReset().mockReturnValue(null);
  logGatewayInfoMock.mockClear();
  writeRestartSentinelMock.mockClear();
  recordLatestUpdateRestartSentinelMock.mockClear();
});

function setDevCampaignSchedule(upstreamSha = "frozen-upstream-sha"): void {
  updateChannel = "dev";
  const target = {
    kind: "git" as const,
    upstreamRef: "origin/main",
    upstreamSha,
    commitsBehind: 3,
  };
  adoptCampaignMock.mockReturnValue({
    status: "adopted",
    campaignId: "campaign-1",
    target,
  });
  updateSchedule = {
    channel: "dev",
    autoEnabled: true,
    install: { kind: "git" },
    target,
    campaign: {
      id: "campaign-1",
      state: "waiting-for-idle",
      announcedAtMs: 1,
      forceAtMs: 2,
      updatedAtMs: 1,
    },
  };
}

function mockGitInstallStatus(upstreamSha: string, upstreamRef = "origin/main"): void {
  const base = installStatus();
  resolveStartupInstallStatusMock.mockResolvedValueOnce({
    ...base,
    status: {
      ...base.status,
      git: {
        root: "/tmp/openclaw",
        sha: "0".repeat(40),
        tag: null,
        branch: "main",
        upstream: upstreamRef,
        upstreamSha,
        dirty: false,
        ahead: 0,
        behind: 1,
        fetchOk: true,
      },
    },
  });
}

function installStatus(
  root: string | null = "/tmp/openclaw",
  installKind: "git" | "package" | "unknown" = "git",
): Awaited<ReturnType<typeof resolveStartupInstallStatus>> {
  const packageManager =
    installKind === "git" ? "pnpm" : installKind === "package" ? "npm" : "unknown";
  return { root, status: { root, installKind, packageManager }, installReceipt: null };
}

async function invokeUpdateRun(
  params: Record<string, unknown> = {},
  respond: RespondFn = () => undefined,
): Promise<void> {
  const { updateHandlers } = await import("./update.js");
  await expectDefined(
    updateHandlers["update.run"],
    'updateHandlers["update.run"] test invariant',
  )({
    params,
    respond,
    client: {
      connId: "conn-1",
      clientIp: "127.0.0.1",
      connect: { client: { id: "control-ui" }, device: { id: "device-1" } },
    },
    context: {
      getRuntimeConfig: () => ({ update: {} }) as OpenClawConfig,
      logGateway: { info: logGatewayInfoMock, warn: vi.fn() },
    },
  } as never);
}

async function captureUpdateRun(params: Record<string, unknown>) {
  let response: { ok?: boolean; result?: { status?: string; reason?: string } } | undefined;
  await invokeUpdateRun(params, (_ok, payload) => {
    response = payload as typeof response;
  });
  return response;
}

function expectNoUpdateMutation(): void {
  expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  expect(writeRestartSentinelMock).not.toHaveBeenCalled();
  expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
}

function expectHandoff(params: Partial<Parameters<typeof startManagedServiceUpdateHandoff>[0]>) {
  expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
    expect.objectContaining(params),
  );
}

function readSentinelModule() {
  return vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
}

describe("update.run campaign ownership", () => {
  it("pins a directly applied package campaign to its announced version", async () => {
    const sentinel = await readSentinelModule();
    writeRestartSentinelMock.mockImplementationOnce(sentinel.writeRestartSentinel);
    updateChannel = "beta";
    resolveStartupInstallStatusMock.mockResolvedValueOnce(
      installStatus("/tmp/openclaw", "package"),
    );
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({
      kind: "global",
      mode: "npm",
      root: "/tmp/openclaw",
      packageRoot: "/tmp/openclaw",
    });

    await invokeUpdateRun();

    expectHandoff({ channel: "beta", tag: "2.0.0" });
    await expect(sentinel.readRestartSentinel()).resolves.toMatchObject({
      payload: { kind: "update", stats: { handoffId: "handoff-1" } },
    });
    expect(logGatewayInfoMock).toHaveBeenCalledWith(
      expect.stringMatching(/^update\.run adopted campaign campaign-1 actor=control-ui /),
      { target: { kind: "package", version: "2.0.0" } },
    );
  });

  it("pins a managed package campaign handoff to its announced version", async () => {
    updateChannel = "beta";
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta", tag: "2.0.0" }),
    );
  });

  it("keeps a configless extended-stable package install on that channel", async () => {
    versionMock.value = "2026.6.33";
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "extended-stable" }),
    );
  });

  it("keeps a plain package update on the moving configured channel", async () => {
    updateChannel = "beta";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    mockPackageInstallSurface("global");

    await invokeUpdateRun();

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta" }),
    );
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ tag: expect.anything() }),
    );
  });

  it("uses the prepared Git checkout instead of process artifacts", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    resolveStartupInstallStatusMock.mockResolvedValueOnce(installStatus("/tmp/openclaw-source"));
    resolveUpdateInstallSurfaceMock.mockImplementationOnce(async ({ root, installKind }) =>
      root === "/tmp/openclaw-source" && installKind === "git"
        ? { kind: "git", mode: "git", root, packageRoot: root }
        : {
            kind: "global",
            mode: "npm",
            root: "/tmp/openclaw-launcher-package",
            packageRoot: "/tmp/openclaw-launcher-package",
          },
    );

    await invokeUpdateRun();

    expectHandoff({ root: "/tmp/openclaw-source", argv1: "/tmp/openclaw-source/dist/index.js" });
  });

  it("rejects a missing prepared root without scanning the process working directory", async () => {
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    resolveStartupInstallStatusMock.mockResolvedValueOnce(installStatus(null, "unknown"));
    resolveUpdateInstallSurfaceMock.mockResolvedValueOnce({ kind: "missing", mode: "unknown" });

    await invokeUpdateRun();

    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
  });

  it("pins a directly applied dev campaign to its announced commit", async () => {
    setDevCampaignSchedule();

    await invokeUpdateRun();

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "frozen-upstream-sha",
        },
      }),
    );
  });

  it("pins a managed dev campaign handoff to its announced commit", async () => {
    setDevCampaignSchedule();
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: {
          mode: "tracked",
          upstreamRef: "origin/main",
          upstreamSha: "frozen-upstream-sha",
        },
      }),
    );
  });

  it("rejects an explicit commit that conflicts with the adopted Git campaign before mutation", async () => {
    const campaignSha = "1234567890abcdef1234567890abcdef12345678";
    setDevCampaignSchedule(campaignSha);
    mockGitInstallStatus(campaignSha);
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    adoptCampaignMock.mockReturnValueOnce({ status: "mismatch" });

    const response = await captureUpdateRun({
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "abcdef1234567890abcdef1234567890abcdef12",
      },
    });

    expect(response?.result).toMatchObject({
      status: "error",
      reason: "update-target-campaign-mismatch",
    });
    expectNoUpdateMutation();
    expect(clearCampaignMock).not.toHaveBeenCalled();

    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledTimes(2);
    expectHandoff({
      devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: campaignSha },
    });
  });

  it("coalesces an explicit commit matching the adopted Git campaign", async () => {
    const upstreamSha = "1234567890abcdef1234567890abcdef12345678";
    setDevCampaignSchedule(upstreamSha);
    mockGitInstallStatus(upstreamSha);

    await invokeUpdateRun({ target: { kind: "git", upstreamRef: "origin/main", upstreamSha } });

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha },
      }),
    );
  });

  describe("explicit Git target binding", () => {
    const requestTarget = {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "1234567890abcdef1234567890abcdef12345678",
    };
    const newerUpstreamSha = "abcdef1234567890abcdef1234567890abcdef12";
    const trackedTarget = {
      mode: "tracked" as const,
      upstreamRef: requestTarget.upstreamRef,
      upstreamSha: requestTarget.upstreamSha,
    };

    beforeEach(() => {
      updateChannel = "dev";
      adoptCampaignMock.mockReturnValue({ status: "absent" });
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    });

    it("rejects an explicit target while its campaign is applying", async () => {
      setDevCampaignSchedule(newerUpstreamSha);
      mockGitInstallStatus(newerUpstreamSha);
      adoptCampaignMock.mockReturnValueOnce({ status: "applying" });

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response).toMatchObject({
        ok: false,
        result: { status: "error", reason: "update-campaign-applying" },
      });
      expect(adoptCampaignMock).toHaveBeenCalledWith(trackedTarget);
      expectNoUpdateMutation();
      expect(clearCampaignMock).not.toHaveBeenCalled();
    });

    it("keeps the requested commit through managed preflight and handoff after upstream advances", async () => {
      mockGitInstallStatus(newerUpstreamSha);

      const response = await captureUpdateRun({ target: requestTarget });

      expectHandoff({ devTarget: trackedTarget });
      expect(response?.ok).toBe(true);
    });

    it("passes the requested commit to a direct Git update", async () => {
      mockGitInstallStatus(newerUpstreamSha);

      await invokeUpdateRun({ target: requestTarget });

      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
        expect.objectContaining({ devTarget: trackedTarget }),
      );
    });

    it.each([
      { name: "short SHA", target: { ...requestTarget, upstreamSha: "1234567" } },
      { name: "nonhex SHA", target: { ...requestTarget, upstreamSha: "g".repeat(40) } },
      { name: "unsafe upstream", target: { ...requestTarget, upstreamRef: "origin/main branch" } },
      { name: "wrong kind", target: { ...requestTarget, kind: "package" } },
      { name: "non-object", target: "origin/main" },
    ])("rejects malformed $name before any update mutation", async ({ target }) => {
      const respond = vi.fn();
      await invokeUpdateRun({ target }, respond);

      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("invalid update.run params:"),
        }),
      );
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects a target for another Git upstream before update mutation", async () => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGitInstallStatus(newerUpstreamSha, "upstream/main");

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "update-target-upstream-mismatch",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects an exact Git target outside the dev channel before update mutation", async () => {
      updateChannel = "stable";
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockGitInstallStatus(newerUpstreamSha);

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "unsupported-update-target",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });

    it("rejects an exact Git target on a package install before update mutation", async () => {
      detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
      mockPackageInstallSurface("global");

      const response = await captureUpdateRun({ target: requestTarget });

      expect(response?.result).toMatchObject({
        status: "error",
        reason: "unsupported-update-target",
      });
      expectNoUpdateMutation();
      expect(adoptCampaignMock).not.toHaveBeenCalled();
    });
  });

  it("does not add a pin environment to a non-campaign managed handoff", async () => {
    updateChannel = "dev";
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ env: expect.anything() }),
    );
  });

  it("records handoff preparation failure before ending the adopted campaign", async () => {
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(new Error("entrypoint unavailable"));
    let outcomeWhenCampaignEnded: unknown;
    clearCampaignMock.mockImplementationOnce(() => {
      outcomeWhenCampaignEnded = recordLatestUpdateRestartSentinelMock.mock.calls.at(-1)?.[0];
    });
    await invokeUpdateRun();

    expect(adoptCampaignMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).toHaveBeenCalledOnce();
    expect(outcomeWhenCampaignEnded).toMatchObject({
      kind: "update",
      status: "error",
      stats: { reason: "managed-service-handoff-failed" },
    });
    expect(logGatewayInfoMock).toHaveBeenCalledWith("update.run failed; adopted campaign cleared", {
      campaignId: "campaign-1",
    });
  });

  it("continues without an explicit target when no campaign can be adopted", async () => {
    setDevCampaignSchedule();
    adoptCampaignMock.mockReturnValueOnce({ status: "absent" });

    await invokeUpdateRun();

    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ devTarget: expect.anything() }),
    );
  });

  it("rejects an untargeted update while a campaign is applying", async () => {
    setDevCampaignSchedule();
    adoptCampaignMock.mockReturnValueOnce({ status: "applying" });

    const response = await captureUpdateRun({});

    expect(response).toMatchObject({
      ok: false,
      result: { status: "error", reason: "update-campaign-applying" },
    });
    expectNoUpdateMutation();
    expect(getCampaignStateMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
  });

  it("does not clear a replacement campaign when the adopted update fails", async () => {
    const deferredUpdate =
      createDeferred<Awaited<ReturnType<typeof startManagedServiceUpdateHandoff>>>();
    const handoffStarted = createDeferred();
    startManagedServiceUpdateHandoffMock.mockImplementationOnce(() => {
      handoffStarted.resolve();
      return deferredUpdate.promise;
    });
    const updateRun = invokeUpdateRun();
    try {
      await awaitGateBeforeSettlement(
        handoffStarted.promise,
        updateRun,
        "update.run settled before starting its managed handoff",
      );
      expect(adoptCampaignMock).toHaveBeenCalledOnce();
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(getCampaignStateMock).not.toHaveBeenCalled();
      currentCampaignId = "campaign-2";
    } finally {
      deferredUpdate.reject(new Error("entrypoint unavailable"));
      await updateRun;
    }

    expect(getCampaignStateMock).toHaveBeenCalledOnce();
    expect(clearCampaignMock).not.toHaveBeenCalled();
    expect(writeRestartSentinelMock).not.toHaveBeenCalled();
    expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
    expect(logGatewayInfoMock).not.toHaveBeenCalledWith(
      "update.run failed; adopted campaign cleared",
      expect.anything(),
    );
  });

  it.each(["transaction", "commit"] as const)(
    "preserves the durable sentinel when its campaign retires at %s admission",
    async (stage) => {
      const sentinel = await readSentinelModule();
      const existing = await sentinel.writeRestartSentinel({
        kind: "restart",
        status: "ok",
        ts: 1,
        message: "Existing notification",
      });
      startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
        new Error("entrypoint unavailable"),
      );
      writeRestartSentinelMock.mockImplementationOnce(sentinel.writeRestartSentinel);
      const observed: string[] = [];
      sentinelAdmission.beforeGrant = (requested) => {
        observed.push(requested);
        if (requested === stage) {
          currentCampaignId = "campaign-2";
        }
      };
      try {
        await invokeUpdateRun();
      } finally {
        sentinelAdmission.beforeGrant = undefined;
      }
      expect(observed).toContain(stage);
      await expect(sentinel.readRestartSentinel()).resolves.toEqual(existing);
      expect(recordLatestUpdateRestartSentinelMock).not.toHaveBeenCalled();
      expect(clearCampaignMock).not.toHaveBeenCalled();
    },
  );

  it("keeps the adopted campaign while a foreground update is accepted", async () => {
    await invokeUpdateRun();

    expect(clearCampaignMock).not.toHaveBeenCalled();
  });

  it("keeps the adopted campaign after a managed-service handoff starts", async () => {
    detectRespawnSupervisorMock.mockReturnValueOnce("launchd");
    mockPackageInstallSurface("global");

    await withEnvAsync({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" }, invokeUpdateRun);

    expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
    expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
      kind: "managed-update-handoff",
      handoffId: "handoff-1",
      installRoot: "/tmp/openclaw",
    });
    expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewayRestartMock).not.toHaveBeenCalled();
    expect(clearCampaignMock).not.toHaveBeenCalled();
  });
});
