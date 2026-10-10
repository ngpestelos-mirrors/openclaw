import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { MAX_PLUGIN_RELOAD_TARGETS } from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  PluginInstallRuntimeBatch,
  type PluginInstallBatchReload,
} from "../plugins/install-runtime-batch.js";
import { withPluginLifecycleSettlementLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { runClawSettlement, type ClawSettlementOptions } from "./update-rollback.js";

export type ClawPluginRuntimeOptions = OpenClawStateDatabaseOptions &
  ClawSettlementOptions & {
    reloadPlugins?: PluginInstallBatchReload;
    /** The enclosing requirement phase owns nested package installs and compensation. */
    runtimeBatch?: PluginInstallRuntimeBatch;
    runtime?: RuntimeEnv;
    waitMs?: number;
    signal?: AbortSignal;
  };

export async function runClawPluginBatch<T>(
  options: ClawPluginRuntimeOptions,
  pluginCount: number,
  run: (batch: PluginInstallRuntimeBatch | undefined) => Promise<T>,
  runtimeFailure: (failure: unknown, operation: Result<T, unknown>) => Error,
): Promise<T> {
  if (!options.reloadPlugins || options.runtimeBatch) {
    return await withPluginLifecycleSettlementLease(options, () => run(options.runtimeBatch));
  }
  if (pluginCount > MAX_PLUGIN_RELOAD_TARGETS) {
    throw new Error(
      `A live Claw requirement batch supports at most ${MAX_PLUGIN_RELOAD_TARGETS} plugin packages. Split the requirement batch before installing.`,
    );
  }
  const batch = new PluginInstallRuntimeBatch(
    {
      env: options.env,
      path: options.path,
      database: options.database,
      waitMs: options.waitMs,
      assertCurrent: options.assertSettlementCurrent ?? options.assertCurrent,
    },
    options.reloadPlugins,
  );
  let completed: Result<T, unknown> | undefined;
  const operation = await withPluginLifecycleSettlementLease(options, async (lease) => {
    let result: Result<T, unknown>;
    try {
      result = ok(await run(batch));
    } catch (error) {
      result = err(error);
    }
    completed = result;
    // The callback has already completed its compensation. Capture final retained owners
    // before releasing the lease; the Gateway validates those facts again after the gap.
    await batch.prepare(lease);
    return result;
  }).catch((error: unknown) => {
    const committed = batch.hasCommitted;
    batch.close();
    if (!committed && !completed) {
      throw error;
    }
    throw runtimeFailure(error, completed ?? err(error));
  });
  try {
    const runtime = options.runtime ?? defaultRuntime;
    const application = await runClawSettlement(options, () =>
      batch.finish((message) => runtime.log(message)),
    );
    if (application) {
      runtime.log(`Plugin requirements applied in Gateway generation ${application.generation}.`);
    }
  } catch (error) {
    throw runtimeFailure(error, operation);
  }
  if (!operation.ok) {
    throw operation.error;
  }
  return operation.value;
}
