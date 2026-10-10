import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { cronJobDefinitionFromReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { createTrustedCronScheduledToolPolicy } from "../cron/scheduled-tool-policy.js";
import { applyDefaultCronToolsAllow } from "../cron/tools-allow.js";
import type { CronJob } from "../cron/types.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { ClawCronInstallError, type PersistedClawCronRef } from "./cron-records.js";
import { persistPendingRef, updateRef } from "./cron.kernel.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";

export {
  CLAW_CRON_REF_SCHEMA_VERSION,
  ClawCronInstallError,
  type PersistedClawCronRef,
} from "./cron-records.js";
export {
  readClawCronRefs,
  deleteClawCronRef,
  markClawCronRefRemoved,
  upsertClawCronRef,
} from "./cron.kernel.js";

export type ClawCronGateway = {
  add: (input: Record<string, unknown>) => Promise<unknown>;
  get?: (schedulerJobId: string) => Promise<unknown>;
  list?: (agentId: string) => Promise<unknown>;
  remove: (schedulerJobId: string) => Promise<unknown>;
  waitUntilAgentAvailable?: (agentId: string) => Promise<void>;
};

export function clawCronSchedulerJobFromResult(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && record.id) {
    return { id: record.id };
  }
  const job = record.job;
  if (job && typeof job === "object" && typeof (job as Record<string, unknown>).id === "string") {
    return { id: (job as Record<string, unknown>).id as string };
  }
  return undefined;
}

function schedulerJobRecordByDeclarationKey(
  value: unknown,
  declarationKey: string,
): (Record<string, unknown> & { id: string }) | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const jobs = (value as Record<string, unknown>).jobs;
  if (!Array.isArray(jobs)) {
    return undefined;
  }
  const matches = jobs.filter(
    (job): job is Record<string, unknown> & { id: string } =>
      Boolean(job) &&
      typeof job === "object" &&
      (job as Record<string, unknown>).declarationKey === declarationKey &&
      typeof (job as Record<string, unknown>).id === "string",
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function clawCronGatewayInput(agentId: string, ref: PersistedClawCronRef) {
  const job = ref.job;
  return {
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId },
    enabled: true,
    agentId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? `session:agent:${agentId}:main` : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  };
}

export function clawCronGatewayJobMatchesRef(
  agentId: string,
  ref: PersistedClawCronRef,
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const live = cronJobDefinitionFromReadView(value as Partial<CronJob>);
  const expected = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (
    !expected ||
    typeof live.id !== "string" ||
    typeof live.createdAtMs !== "number" ||
    typeof live.updatedAtMs !== "number" ||
    !live.state
  ) {
    return false;
  }
  const comparableLive = { ...live, payload: { ...live.payload } } as CronJob;
  applyDefaultCronToolsAllow(expected);
  applyDefaultCronToolsAllow(comparableLive);
  const expectedWithPolicy = {
    ...expected,
    ...(comparableLive.scheduledToolPolicy
      ? { scheduledToolPolicy: createTrustedCronScheduledToolPolicy() }
      : {}),
  };
  try {
    return (
      resolveCronJobConfigRevision({
        ...expectedWithPolicy,
        id: live.id,
        createdAtMs: live.createdAtMs,
        updatedAtMs: live.updatedAtMs,
        state: live.state,
      }) === resolveCronJobConfigRevision(comparableLive)
    );
  } catch {
    return false;
  }
}

export async function installClawCronJobs(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    gateway?: Pick<ClawCronGateway, "add" | "list" | "waitUntilAgentAvailable">;
    nowMs?: number;
  } = {},
): Promise<PersistedClawCronRef[]> {
  const actions = plan.actions.filter((action) => action.kind === "cronJob");
  if (actions.length === 0) {
    return [];
  }
  if (!options.gateway) {
    throw new ClawCronInstallError(
      "cron_gateway_required",
      "Claw automations require the gateway-owned cron.add API.",
      [],
    );
  }
  const refs: PersistedClawCronRef[] = [];
  let agentAvailable = false;
  for (const action of actions) {
    const details = action.details as (ClawCronJob & { agentId?: string }) | undefined;
    if (!details?.id) {
      throw new ClawCronInstallError(
        "cron_plan_invalid",
        `Cron action ${action.id} is invalid.`,
        refs,
      );
    }
    const job: ClawCronJob = {
      id: details.id,
      ...(details.name ? { name: details.name } : {}),
      schedule: details.schedule,
      session: details.session,
      message: details.message,
      ...(details.delivery ? { delivery: details.delivery } : {}),
    };
    const pending = persistPendingRef(plan, job, options);
    refs.push(pending);
    let result: { id: string } | undefined;
    if (pending.status === "complete" && pending.schedulerJobId) {
      if (!options.gateway.list) {
        continue;
      }
      if (!agentAvailable) {
        await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
        agentAvailable = true;
      }
      const listedJob = schedulerJobRecordByDeclarationKey(
        await options.gateway.list(plan.agent.finalId),
        pending.declarationKey,
      );
      if (listedJob) {
        if (!clawCronGatewayJobMatchesRef(plan.agent.finalId, pending, listedJob)) {
          throw new ClawCronInstallError(
            "cron_reconcile_conflict",
            `Cron declaration ${JSON.stringify(pending.manifestId)} changed after installation.`,
            refs,
          );
        }
        result = listedJob;
        if (result.id !== pending.schedulerJobId) {
          refs[refs.length - 1] = updateRef(
            pending,
            { status: "complete", schedulerJobId: result.id },
            options,
          );
        }
        continue;
      }
      throw new ClawCronInstallError(
        "cron_reconcile_conflict",
        `Cron declaration ${JSON.stringify(pending.manifestId)} is missing; remove and add the Claw again to recreate it safely.`,
        refs,
      );
    }
    try {
      if (!agentAvailable) {
        await options.gateway.waitUntilAgentAvailable?.(plan.agent.finalId);
        agentAvailable = true;
      }
      if (options.gateway.list) {
        result = schedulerJobRecordByDeclarationKey(
          await options.gateway.list(plan.agent.finalId),
          pending.declarationKey,
        );
      }
      result ??= clawCronSchedulerJobFromResult(
        await options.gateway.add(clawCronGatewayInput(plan.agent.finalId, pending)),
      );
      if (!result) {
        throw new Error("cron.add returned no scheduler job id");
      }
    } catch (error) {
      const message = coerceErrorMessage(error);
      refs[refs.length - 1] = updateRef(pending, { status: "pending", error: message }, options);
      throw new ClawCronInstallError("cron_install_failed", message, refs);
    }
    try {
      refs[refs.length - 1] = updateRef(
        pending,
        { status: "complete", schedulerJobId: result.id },
        options,
      );
    } catch (error) {
      const message = coerceErrorMessage(error);
      throw new ClawCronInstallError(
        "cron_provenance_failed",
        `cron.add succeeded, but its scheduler id could not be persisted: ${message}`,
        refs,
      );
    }
  }
  return refs;
}
