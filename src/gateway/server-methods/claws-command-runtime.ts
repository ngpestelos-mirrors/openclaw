import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { ClawCommandServices } from "../../claws/command-runtime.js";
import { transformConfigFileWithRetry } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.types.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../../config/runtime-write-application.js";
import { resolveGatewayLockPaths } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { reloadManagedPlugin } from "../../plugins/management-mutations.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { captureGatewayPluginRuntimeApplications } from "./plugins-lifecycle-error.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions } from "./types.js";

type ClawMethod =
  | "cron.add"
  | "cron.get"
  | "cron.remove"
  | "claws.monitors"
  | "claws.removalJournal"
  | "claws.packages.remove";

export function createClawGatewayCommandServices(
  options: GatewayRequestHandlerOptions,
  expectedOwnerId: string,
) {
  const selectedPaths = resolveGatewayLockPaths(process.env);
  const { stateDir } = selectedPaths;
  const owner = captureGatewayStateOwner(path.join(stateDir, "state", "openclaw.sqlite"));
  const assertSettlementCurrent = () => {
    const currentPaths = resolveGatewayLockPaths(process.env);
    if (
      currentPaths.ownerLockPath !== selectedPaths.ownerLockPath ||
      currentPaths.configPath !== selectedPaths.configPath
    ) {
      throw new Error("Claw settlement target changed; rerun against the selected Gateway.");
    }
    if (!owner || owner.role !== "gateway" || owner.ownerId !== expectedOwnerId) {
      throw new Error("Claw settlement lost its physical Gateway owner.");
    }
    owner.assertCurrent();
  };
  const assertCurrent = () => {
    assertSettlementCurrent();
    options.signal?.throwIfAborted();
    options.sessionMutationCommitGuard?.();
    if (
      !owner ||
      owner.role !== "gateway" ||
      owner.ownerId !== expectedOwnerId ||
      options.hasCurrentClientAuthority?.() === false ||
      options.client?.invalidated ||
      (options.client?.connect.role ?? "operator") !== "operator" ||
      !options.client?.connect.scopes?.includes("operator.admin") ||
      !options.client?.internal?.isLocalClient
    ) {
      throw new Error(
        "Claw changes require the current local Gateway owner and administrator authority.",
      );
    }
    owner.assertCurrent();
  };
  assertCurrent();
  const settlement = new AsyncLocalStorage<{ assertCurrent: () => void }>();
  const operationAssertion = () => settlement.getStore()?.assertCurrent ?? assertCurrent;
  const operationSignal = () => (settlement.getStore() ? undefined : options.signal);
  const runSettlement = async <T>(run: () => Promise<T>): Promise<T> => {
    assertSettlementCurrent();
    let active = true;
    const assertRetainedSettlement = () => {
      assertSettlementCurrent();
      if (!active) {
        throw new Error("Claw settlement scope has completed");
      }
    };
    return await settlement.run({ assertCurrent: assertRetainedSettlement }, async () => {
      try {
        return await run();
      } finally {
        active = false;
        assertSettlementCurrent();
      }
    });
  };
  const call = async (method: ClawMethod, params: Record<string, unknown>): Promise<unknown> => {
    const assertOperationCurrent = operationAssertion();
    assertOperationCurrent();
    let handler: GatewayRequestHandler;
    if (method === "cron.add" || method === "cron.get" || method === "cron.remove") {
      handler = (await import("./cron.js")).cronHandlers[method]!;
    } else if (method === "claws.monitors") {
      handler = (await import("./claws-monitors.js")).clawsMonitorHandlers[method];
    } else if (method === "claws.removalJournal") {
      handler = (await import("./claws-removal-journal.js")).clawsRemovalJournalHandlers[method];
    } else {
      handler = (await import("./claws-packages.js")).clawsPackageHandlers[method];
    }
    assertOperationCurrent();
    let answered = false;
    let result: unknown;
    let failure: Error | undefined;
    await handler({
      ...options,
      params,
      req: { ...options.req, method, params },
      sessionMutationCommitGuard: assertOperationCurrent,
      signal: operationSignal(),
      hasCurrentClientAuthority: () => {
        assertOperationCurrent();
        return true;
      },
      respond: (ok, payload, error) => {
        answered = true;
        if (ok) {
          result = payload;
        } else {
          failure = new Error(error?.message ?? `Claw dependency ${method} failed`);
        }
      },
    });
    if (failure) {
      throw failure;
    }
    if (!answered) {
      throw new Error(`Claw dependency ${method} returned without an outcome`);
    }
    return result;
  };
  const createConfigApplication = () => {
    const assertApplicationCurrent = operationAssertion();
    const application = createRuntimeConfigWriteApplication(
      captureGatewayRootWorkAdmissionContinuationScope()?.run,
    );
    const writeOptions: ConfigWriteOptions = attachRuntimeConfigWriteApplication(
      { assertCurrent: assertApplicationCurrent },
      application,
    );
    return {
      writeOptions,
      confirm: async (alreadyApplied?: () => boolean) => {
        const result = application.claimed ? await application.result : "unclaimed";
        assertApplicationCurrent();
        if (result !== "applied" && !(result === "unclaimed" && alreadyApplied?.())) {
          throw new Error(
            `Claw configuration was saved but Gateway application was not confirmed (${result}); inspect config.get before retrying.`,
          );
        }
      },
    };
  };
  const services: ClawCommandServices = {
    assertCurrent,
    assertSettlementCurrent,
    runSettlement,
    env: { ...process.env },
    signal: options.signal,
    waitMs: 0,
    cronGateway: {
      add: (input) => call("cron.add", input),
      get: (id) => call("cron.get", { id }),
      remove: (id) => call("cron.remove", { id }),
      list: async (agentId) => {
        const assertOperationCurrent = operationAssertion();
        assertOperationCurrent();
        const jobs = await options.context.cron.list({ includeDisabled: true });
        assertOperationCurrent();
        return { jobs: jobs.filter((job) => job.agentId === agentId) };
      },
      waitUntilAgentAvailable: async (agentId) => {
        const assertOperationCurrent = operationAssertion();
        assertOperationCurrent();
        if (
          !options.context.isConfigReloadSettled() ||
          !Object.hasOwn(options.context.getRuntimeConfig().agents?.entries ?? {}, agentId)
        ) {
          throw new Error(
            `Gateway has not applied Claw agent ${agentId}; inspect config.get before retrying.`,
          );
        }
      },
    },
    reloadPlugins: async (plugins) => {
      const assertOperationCurrent = operationAssertion();
      const signal = operationSignal();
      assertOperationCurrent();
      const applyRuntime = options.context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Claw plugin changes require the Gateway plugin lifecycle owner.");
      }
      const captured = captureGatewayPluginRuntimeApplications(
        applyRuntime,
        assertOperationCurrent,
      );
      const result = await withPluginLifecycleLease(
        { signal, waitMs: 0, assertCurrent: assertOperationCurrent },
        () =>
          reloadManagedPlugin({
            plugins: [...plugins],
            applyRuntime: captured.applyRuntime,
            beforePersistentApply: assertOperationCurrent,
            signal,
          }),
      );
      if (!result.application) {
        throw new Error("Claw plugin reload returned without runtime confirmation.");
      }
      return result.application;
    },
    commitConfig: async (transform) => {
      const assertOperationCurrent = operationAssertion();
      const application = createConfigApplication();
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        writeOptions: application.writeOptions,
        transform: (config) => {
          assertOperationCurrent();
          return { nextConfig: transform(config) };
        },
      });
      await application.confirm();
    },
  };
  return { ...services, call, createConfigApplication };
}
