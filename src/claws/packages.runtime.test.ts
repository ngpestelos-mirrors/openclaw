import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins/install-record-commit.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { ClawCommandServices } from "./command-runtime.js";
import { installClawPackages } from "./packages.js";
import { packageInstallPlan } from "./packages.test-support.js";

const installOwner = vi.hoisted(() => ({
  install: vi.fn(),
  failure: new Error("artifact owner rejected the installation"),
}));
vi.mock("../plugins/management-mutations.js", () => ({
  installManagedPlugin: installOwner.install,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const integrity = `sha256:${"a".repeat(64)}`;
type InstallOptions = NonNullable<Parameters<typeof installClawPackages>[1]>;

function packageDeps(
  root: string,
  loadInstallRecords: () => Promise<Record<string, PluginInstallRecord>>,
) {
  return {
    preflightPlugin: (params) => preflightPluginInstall({ ...params, loadInstallRecords }),
    probePlugin: async ({ spec }) => ({
      ok: true,
      packageName: spec,
      pluginId: spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!,
      targetDir: root,
      extensions: [],
      clawhub: {
        source: "clawhub",
        clawhubFamily: "code-plugin",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: spec,
        integrity,
      },
    }),
    persistPackageRef: async (plan, pkg, persistOptions) => ({
      schemaVersion: "openclaw.clawPackageRef.v1",
      agentId: plan.agent.finalId,
      clawName: plan.claw.name,
      kind: pkg.kind,
      source: pkg.source,
      ref: pkg.ref,
      version: pkg.version!,
      integrity: pkg.integrity!,
      status: persistOptions?.status ?? "pending",
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      installedAtMs: 1,
      updatedAtMs: 1,
    }),
    completePackageRef: async (ref, status) => ({ ...ref, status }),
  } satisfies InstallOptions["deps"];
}

describe("Claw committed plugin requirement handoff", () => {
  it("preserves the install owner's failure instead of a nested CLI exit", async () => {
    const root = dirs.make("openclaw-claw-install-error-");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    installOwner.install.mockReset().mockRejectedValue(installOwner.failure);
    await withEnvAsync(env, async () => {
      const result = await installClawPackages(
        packageInstallPlan([
          { kind: "plugin", source: "clawhub", ref: "@owner/demo", version: "1.0.0", integrity },
        ]),
        {
          env,
          runtime: {
            log: () => {},
            error: () => {},
            exit: () => {
              throw new Error("unexpected outer exit");
            },
          },
          deps: {
            ...packageDeps(root, async () => ({})),
            withPackageLease: async (_artifact, operation) =>
              operation({
                signal: new AbortController().signal,
                assertOwned() {},
                assertOwnedInTransaction() {},
              }),
          },
        },
      ).catch((error: unknown) => error);
      expect(installOwner.install).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        code: "package_install_failed",
        message: installOwner.failure.message,
        cause: installOwner.failure,
      });
    });
  });
  it.each(["none", "metadata", "cancellation", "retirement"] as const)(
    "applies retained writes once after lease release (late failure=%s)",
    async (failure) => {
      const lateFailure = failure !== "none";
      const controller = new AbortController();
      const settlement = new AsyncLocalStorage<boolean>();
      const root = dirs.make("openclaw-claw-runtime-");
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
      await withEnvAsync(env, async () => {
        let records: Record<string, PluginInstallRecord> = {};
        let heldPackages = 0;
        let ownerCurrent = true;
        const assertSettlementCurrent = () => {
          if (!ownerCurrent) {
            throw new Error("physical owner retired");
          }
        };
        const cleanup = vi.fn();
        const log = vi.fn();
        const reloadPlugins = vi.fn<PluginInstallBatchReload>(async (targets) => {
          if (!settlement.getStore()) {
            controller.signal.throwIfAborted();
          }
          expect(hasPluginLifecycleLease()).toBe(false);
          expect(heldPackages).toBe(0);
          expect(cleanup).not.toHaveBeenCalled();
          expect(targets.map((target: { pluginId: string }) => target.pluginId)).toEqual(
            lateFailure ? ["first"] : ["first", "second"],
          );
          ownerCurrent = failure !== "retirement";
          return {
            operationId: "batch",
            generation: 2,
            pluginIds: targets.map((target: { pluginId: string }) => target.pluginId),
            warnings: ["Previous plugin cleanup did not finish."],
          };
        });
        const options: InstallOptions &
          Pick<ClawCommandServices, "assertSettlementCurrent" | "runSettlement"> = {
          env,
          signal: controller.signal,
          assertCurrent: () => {
            assertSettlementCurrent();
            controller.signal.throwIfAborted();
          },
          assertSettlementCurrent,
          runSettlement: (run) => settlement.run(true, run),
          runtime: {
            log,
            error: () => {},
            exit: () => {
              throw new Error("unexpected exit");
            },
          },
          reloadPlugins,
          deps: {
            ...packageDeps(root, async () => records),
            withPackageLease: async (_artifact, operation) => {
              heldPackages++;
              try {
                return await operation({
                  signal: new AbortController().signal,
                  assertOwned() {},
                  assertOwnedInTransaction() {},
                });
              } finally {
                heldPackages--;
              }
            },
            installPlugin: async (params) => {
              if (params.request.source !== "clawhub" || !params.request.expectedPluginId) {
                throw new Error("Expected a pinned ClawHub plugin request");
              }
              const pluginId = params.request.expectedPluginId;
              const next = {
                ...records,
                [pluginId]: {
                  source: "clawhub" as const,
                  clawhubPackage: `@owner/${pluginId}`,
                  version: "1.0.0",
                  integrity,
                  installPath: path.join(root, "plugins", pluginId),
                },
              };
              const write = await commitPluginInstallRecordsWithConfig({
                previousInstallRecords: records,
                nextInstallRecords: next,
                nextConfig: {},
                writeOptions: { afterWrite: { mode: "none", reason: "batch fixture" } },
              });
              records = next;
              params.deferRuntime?.record({
                operation: "install",
                pluginId,
                sourceDigests: {},
                write,
              });
              params.deferRuntime?.deferCleanup(
                async (assertOwned, warn) => {
                  assertOwned();
                  if (controller.signal.aborted) {
                    expect(settlement.getStore()).toBe(true);
                  }
                  cleanup(pluginId);
                  warn(`Source cleanup warning for ${pluginId}`);
                },
                path.join(root, "retired", pluginId),
              );
              if (failure === "cancellation") {
                controller.abort(new Error("request canceled after plugin commit"));
              }
              if (lateFailure) {
                throw new Error("postcommit metadata failure");
              }
            },
          },
        };
        const plan = packageInstallPlan(
          ["first", "second"].map((id) => ({
            kind: "plugin",
            source: "clawhub",
            ref: `@owner/${id}`,
            version: "1.0.0",
            integrity,
          })),
        );
        const pending = installClawPackages(plan, options);
        let completed: Awaited<typeof pending> | undefined;
        if (lateFailure) {
          await expect(pending).rejects.toMatchObject({
            code: "package_install_failed",
            message:
              failure === "retirement"
                ? expect.stringContaining("physical owner retired")
                : failure === "cancellation"
                  ? expect.stringContaining("postcommit metadata failure")
                  : "postcommit metadata failure",
          });
        } else {
          completed = await pending;
          expect(completed).toHaveLength(2);
        }
        expect(reloadPlugins).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith("Previous plugin cleanup did not finish.");
        expect(cleanup).toHaveBeenCalledTimes(failure === "retirement" ? 0 : lateFailure ? 1 : 2);
        if (failure !== "retirement") {
          expect(log).toHaveBeenCalledWith("Source cleanup warning for first");
        }
        if (completed) {
          const installedRefs = completed;
          cleanup.mockClear();
          const installPlugin = vi.fn(async () => {
            throw new Error("resumed requirement was reinstalled");
          });
          const resumedOptions = {
            ...options,
            deps: {
              ...options.deps,
              installPlugin,
              readPackageRefs: async () => installedRefs,
            },
          };
          reloadPlugins.mockRejectedValueOnce(new Error("runtime reply lost"));
          await expect(installClawPackages(plan, resumedOptions)).rejects.toMatchObject({
            code: "package_runtime_failed",
            message: expect.stringContaining("Runtime activation was not confirmed"),
          });
          await expect(installClawPackages(plan, resumedOptions)).resolves.toHaveLength(2);
          expect(installPlugin).not.toHaveBeenCalled();
          expect(cleanup).not.toHaveBeenCalled();
          expect(reloadPlugins).toHaveBeenCalledTimes(3);
        }
      });
    },
  );
});
