import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import { setDeferredPluginMigrationConfigFacts } from "../config/deferred-plugin-migration-config.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { ConfigMutationResult } from "../config/mutate.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWriteConfigHealth } from "./doctor-health-contribution-runners.config.js";
import { writeDoctorGatewayConfig } from "./doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const mocks = vi.hoisted(() => ({
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  replaceConfigFile: vi.fn<
    (_params: unknown) => Promise<
      Pick<ConfigMutationResult<unknown>, "path" | "persistedHash"> & {
        nextConfig?: OpenClawConfig;
      }
    >
  >(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", () => ({
  restoreDoctorConfigEnvRefs: (cfg: OpenClawConfig) => cfg,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  transformConfigFile: async ({
    transform,
    ...options
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const { nextConfig } = await transform(
      {},
      { snapshot: createDoctorConfigSnapshot(), previousHash: null, attempt: 0 },
      {},
    );
    const committed = await mocks.replaceConfigFile({ ...options, nextConfig });
    return { nextConfig, ...committed };
  },
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
}));

function createContext(): DoctorHealthFlowContext {
  const cfg = { gateway: { mode: "local" } } satisfies OpenClawConfig;
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: {} as DoctorHealthFlowContext["prompter"],
    configResult: {
      cfg,
      confirmedConfigSource: { path: "/tmp/openclaw.json", hash: "planning-revision" },
      retiredAuthProfileCleanupPlans: [
        { agentDir: "/tmp/openclaw/agents/main", profileIds: ["anthropic:claude-cli"] },
      ],
    },
    cfg,
    cfgForPersistence: {},
    sourceConfigValid: true,
    configPath: "/tmp/openclaw.json",
  };
}

function expectReceipt(ctx: DoctorHealthFlowContext, hash: string | null) {
  expect(ctx.configResult.confirmedConfigSource).toEqual({ path: ctx.configPath, hash });
}

function expectWrite(ctx: DoctorHealthFlowContext, call: number, baseHash: string) {
  expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(
    call,
    expect.objectContaining({
      nextConfig: ctx.cfg,
      baseHash,
      writeOptions: expect.objectContaining({ expectedConfigPath: ctx.configPath }),
    }),
  );
}

describe("Doctor retired auth profile cleanup", () => {
  beforeEach(() => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockClear().mockResolvedValue(true);
    mocks.replaceConfigFile.mockReset().mockResolvedValue({
      path: "/tmp/openclaw.json",
      persistedHash: "committed-revision",
    });
  });

  it.each(["missing", "null", "conflict", "write failed"] as const)(
    "keeps cleanup and the saved baseline when the receipt is %s",
    async (failure) => {
      const ctx = createContext();
      if (failure === "missing") {
        delete ctx.configResult.confirmedConfigSource;
      } else if (failure === "null") {
        ctx.configResult.confirmedConfigSource = { path: ctx.configPath, hash: null };
      } else {
        mocks.replaceConfigFile.mockRejectedValueOnce(
          failure === "conflict"
            ? new ConfigMutationConflictError("changed")
            : new Error("write failed"),
        );
      }
      const receipt = ctx.configResult.confirmedConfigSource;
      const baseline = ctx.cfgForPersistence;

      if (failure === "write failed") {
        await expect(runWriteConfigHealth(ctx)).rejects.toThrow("write failed");
      } else {
        expect(await runWriteConfigHealth(ctx)).toBe(false);
        expect(ctx.configWriteRefusal).toBe("config-conflict");
      }
      expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
      expect(ctx.cfgForPersistence).toBe(baseline);
      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(
        failure === "conflict" || failure === "write failed" ? 1 : 0,
      );
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    },
  );

  it("keeps a successful write with a null receipt but fences the next required write", async () => {
    const ctx = createContext();
    mocks.replaceConfigFile.mockResolvedValueOnce({ path: ctx.configPath, persistedHash: null });
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    const baseline = ctx.cfgForPersistence;
    expect(baseline).toEqual(ctx.cfg);
    expectReceipt(ctx, null);
    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    ctx.cfg = { gateway: { mode: "local", port: 19090 } };

    expect(await runWriteConfigHealth(ctx)).toBe(false);

    expect(ctx.configWriteRefusal).toBe("config-conflict");
    expect(ctx.cfgForPersistence).toBe(baseline);
    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });

  it.each(["complete", "partial"] as const)(
    "invalidates only a partial-publication receipt and fences later %s writes",
    async (publication) => {
      const ctx = createContext();
      expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
      expectReceipt(ctx, "committed-revision");
      expect(ctx.cfgForPersistence).toEqual(ctx.cfg);
      const receipt = structuredClone(ctx.configResult.confirmedConfigSource);
      const baseline = structuredClone(ctx.cfgForPersistence);
      const error = new ConfigWritePostCommitError({
        configPath: ctx.configPath,
        rollbackStatus: "unknown",
        publication,
        cause: new Error("post-write publication failed"),
      });
      mocks.replaceConfigFile.mockRejectedValueOnce(error);
      ctx.cfg = { gateway: { mode: "local", port: 19091 } };

      await expect(runWriteConfigHealth(ctx)).rejects.toBe(error);
      expect(ctx.configWriteError).toBe(error);
      expect(ctx.configResult.confirmedConfigSource).toStrictEqual(
        publication === "partial" ? undefined : receipt,
      );
      expect(ctx.cfgForPersistence).toStrictEqual(baseline);
      await expect(runWriteConfigHealth(ctx)).rejects.toBe(error);
      await expect(writeDoctorGatewayConfig(ctx, { gateway: { mode: "local" } })).rejects.toBe(
        error,
      );
      if (publication === "partial") {
        // A copied caller may omit the local latch, but cannot reuse the active receipt.
        const copied = { ...ctx, configWriteError: undefined };
        expect(await runWriteConfigHealth(copied)).toBe(false);
        expect(copied.configWriteRefusal).toBe("config-conflict");
      }
      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
      expect(mocks.replaceConfigFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ baseHash: receipt?.hash }),
      );
      expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
    },
  );

  it("retains deferred migration inputs until the final cleanup write with the latest receipt", async () => {
    const ctx = createContext();
    const retainedConfig = { ...ctx.cfg, session: { store: "/tmp/legacy-sessions.json" } };
    setDeferredPluginMigrationConfigFacts(retainedConfig, [
      {
        pluginId: "receipt-test",
        reason: "state migration has not completed",
        command: "openclaw doctor --fix",
        configPaths: [["session", "store"]],
      },
    ]);
    mocks.replaceConfigFile
      .mockResolvedValueOnce({
        nextConfig: retainedConfig,
        path: ctx.configPath,
        persistedHash: "retained-revision",
      })
      .mockResolvedValueOnce({
        nextConfig: ctx.cfg,
        path: ctx.configPath,
        persistedHash: "clean-revision",
      });

    expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
    expect(ctx.cfg.session).toBeUndefined();
    expect(ctx.cfgForPersistence.session?.store).toBe("/tmp/legacy-sessions.json");
    expectReceipt(ctx, "retained-revision");
    expectWrite(ctx, 1, "planning-revision");
    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();

    // The runtime config is unchanged, but its persisted retained input must be removed.
    expect(await runWriteConfigHealth(ctx)).toBe(true);
    expectWrite(ctx, 2, "retained-revision");
    expect(ctx.cfgForPersistence).toEqual(ctx.cfg);
    expect(ctx.cfgForPersistence.session).toBeUndefined();
    expectReceipt(ctx, "clean-revision");
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]!,
    );
    expect(await runWriteConfigHealth(ctx)).toBe(true);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledOnce();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      cfg: ctx.cfg,
      profileIds: ["anthropic:claude-cli"],
    });
  });
});
