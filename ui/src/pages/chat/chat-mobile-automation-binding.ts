import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { CronJob, CronScratchGetResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { hasOperatorReadAccess, readGatewayOperatorAccess } from "../../app/operator-access.ts";
import {
  getCronRunsViewState,
  loadCronRuns,
  loadCronRunsForJob,
  loadMoreCronRuns,
  retireCronRunsRequest,
  updateCronRunsFilter,
} from "../../lib/cron/runs.ts";
import { createInitialCronState } from "../../lib/cron/state.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatMissingOperatorReadScopeMessage } from "../../lib/gateway-errors.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { createCronRouteSelection } from "../cron/route-model.ts";
import { createCronRunTranscript } from "../cron/run-transcript.tsx";
import type { SessionAutomationMobileBodyProps } from "./components/chat-automation-mobile.tsx";

/** Adapts the native cron selection/runs/transcript owners to a retained session destination. */
export function createMobileAutomationBinding(props: {
  context: Pick<ApplicationContext, "gateway" | "basePath" | "navigate">;
  jobId: () => string | undefined;
  agentId: () => string | undefined;
  presented: () => boolean;
  host: () => HTMLElement | null;
  onTranscript: () => void;
  onTranscriptClose: () => void;
}) {
  const presented = createMemo(props.presented);
  const host = createMemo(props.host);
  const jobId = createMemo(props.jobId);
  const agentId = createMemo(props.agentId);
  const gateway = projectOwner(props.context.gateway, (owner) => owner.snapshot);
  const [revision, setRevision] = createSignal(0);
  const [tab, setTab] = createSignal<"overview" | "history">("overview");
  const publish = () => {
    if (!disposed) {
      setRevision((value) => value + 1);
    }
  };
  let state = createInitialCronState();
  let job: CronJob | undefined;
  let scratch = "";
  let disposed = false;
  let definitionDirty = true;
  let pendingDefinition: typeof state | undefined;
  const selection = createCronRouteSelection();
  const current = (captured = state) =>
    !disposed &&
    captured === state &&
    captured.connected &&
    props.context.gateway.snapshot.phase === "connected" &&
    props.context.gateway.snapshot.client === captured.client &&
    hasOperatorReadAccess(props.context.gateway.snapshot.hello?.auth ?? null) &&
    host()?.isConnected === true;
  const canManage = () => readGatewayOperatorAccess(gateway.read()).canAdmin;
  const transcript = createCronRunTranscript(publish, () => {
    const captured = state;
    return current(captured) && captured.client
      ? { client: captured.client, isCurrent: () => current(captured) }
      : null;
  });
  const scope = createMemo(
    () => {
      const snapshot = gateway.read();
      return [
        snapshot.client,
        snapshot.phase === "connected",
        gatewayPresentationScope(props.context.gateway),
        jobId(),
        agentId(),
        hasOperatorReadAccess(snapshot.hello?.auth ?? null),
      ] as const;
    },
    { equals: (a, b) => a.every((value, index) => value === b[index]) },
  );
  const run = (operation: (captured: typeof state) => Promise<unknown>) => {
    const captured = state;
    const pending = operation(captured);
    publish();
    void pending.finally(() => {
      if (captured === state && !disposed) {
        publish();
      }
    });
  };
  // Scope, presentation and access effects own invalidation; resolution samples current facts.
  const invalidateDefinition = () => {
    definitionDirty = true;
    void untrack(resolve);
  };
  async function resolve() {
    const captured = state;
    const id = jobId();
    if (
      !definitionDirty ||
      pendingDefinition === captured ||
      !id ||
      !current(captured) ||
      !presented()
    ) {
      return;
    }
    const presentationScope = gatewayPresentationScope(props.context.gateway);
    const ownsDefinition = () =>
      current(captured) &&
      jobId() === id &&
      !definitionDirty &&
      gatewayPresentationScope(props.context.gateway) === presentationScope &&
      hasOperatorReadAccess(props.context.gateway.snapshot.hello?.auth ?? null);
    // One definition/scratch read at a time. Events during it coalesce into one tail.
    pendingDefinition = captured;
    definitionDirty = false;
    selection.target = { jobId: id, runId: null };
    selection.requested = false;
    captured.cronError = null;
    try {
      const pending = selection.resolve(captured, ownsDefinition, (value) => {
        job = value;
        if (value.payload.kind !== "heartbeat") {
          scratch = "";
        }
        run((owner) =>
          owner.cronRunsJobId === value.id
            ? loadCronRuns(owner, { coalesce: true })
            : loadCronRunsForJob(owner, value.id),
        );
      });
      publish();
      await pending;
      if (!ownsDefinition()) {
        return;
      }
      // The native exact-selection owner clears its target on a failed/missing job.
      if (!selection.target) {
        job = undefined;
        scratch = "";
        transcript.close();
      }
      publish();
      if (job?.payload.kind === "heartbeat" && canManage()) {
        try {
          const result = await captured.client!.request<CronScratchGetResult>("cron.scratch.get", {
            id,
          });
          if (ownsDefinition() && canManage()) {
            scratch = result.scratch?.content ?? "";
          }
        } catch (error) {
          if (ownsDefinition()) {
            captured.cronError = formatUiError(error);
          }
        }
        if (ownsDefinition()) {
          publish();
        }
      }
    } finally {
      if (pendingDefinition === captured) {
        pendingDefinition = undefined;
        if (current(captured) && definitionDirty && presented()) {
          void untrack(resolve);
        }
      }
    }
  }
  createEffect(scope, ([client, connected, , id, agent, readAccess]) => {
    state.connected = false;
    retireCronRunsRequest(state);
    transcript.close();
    state = createInitialCronState({ client, connected });
    state.cronAgentId = agent ?? null;
    if (!readAccess) {
      state.cronError = formatMissingOperatorReadScopeMessage("scheduled tasks");
    }
    const captured = state;
    state.canRefresh = () =>
      current(captured) && presented() && hasOperatorReadAccess(gateway.read().hello?.auth ?? null);
    job = undefined;
    scratch = "";
    definitionDirty = true;
    setTab("overview");
    selection.bind(props.context.gateway);
    selection.target = id ? { jobId: id, runId: null } : null;
    selection.requested = false;
    publish();
    if (id && readAccess) {
      void untrack(resolve);
    }
  });
  createEffect(presented, (shown) => {
    if (!shown) {
      definitionDirty = true;
    } else {
      void untrack(resolve);
    }
  });
  const access = createMemo(
    () => [hasOperatorReadAccess(gateway.read().hello?.auth ?? null), canManage()] as const,
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  let previousAccess = access();
  createEffect(access, (value) => {
    if (!value[1] && scratch) {
      scratch = "";
      publish();
    }
    const previous = previousAccess;
    previousAccess = value;
    // Read changes reset the scope above; only an admin-only change needs a refresh here.
    if (value[0] === previous[0] && value[1] !== previous[1]) {
      invalidateDefinition();
    }
  });
  const stopEvents = props.context.gateway.subscribeEvents((event) => {
    if (event.event !== "cron" || !jobId()) {
      return;
    }
    const payload = asNullableRecord(event.payload);
    if (payload?.jobId && payload.jobId !== jobId()) {
      return;
    }
    invalidateDefinition();
  });
  onCleanup(() => {
    disposed = true;
    state.connected = false;
    retireCronRunsRequest(state);
    stopEvents();
    transcript.close();
  });
  const body = createMemo<SessionAutomationMobileBodyProps | undefined>(() => {
    revision();
    if (!job) {
      return undefined;
    }
    return {
      job,
      tab: tab(),
      onTabChange: setTab,
      canManage: canManage(),
      connected: state.connected,
      heartbeatScratch: scratch,
      basePath: props.context.basePath,
      onOpenEditor: (id) =>
        props.context.navigate("cron", { search: `?job=${encodeURIComponent(id)}` }),
      history: {
        runs: state.cronRuns,
        runsState: getCronRunsViewState(state),
        runsHasMore: state.cronRunsHasMore,
        runsLoadingMore: state.cronRunsLoadingMore,
        runsStatuses: state.cronRunsStatuses,
        runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
        runsQuery: state.cronRunsQuery,
        runsSortDir: state.cronRunsSortDir,
        runsSortBy: state.cronRunsSortBy,
        highlightedRunId: state.cronRunsRunId,
        onLoadMoreRuns: () => run(loadMoreCronRuns),
        onRefresh: () => run(loadCronRuns),
        onRunsFiltersChange: (patch) => {
          updateCronRunsFilter(state, patch);
          run(loadCronRuns);
        },
        onViewRunTranscript: (entry, trigger) => {
          void transcript.open(entry, trigger);
          if (transcript.entry) {
            props.onTranscript();
          }
        },
      },
    };
  });
  let hadTranscript = false;
  createEffect(
    () => {
      revision();
      return transcript.entry;
    },
    (entry) => {
      const closed = hadTranscript && !entry;
      hadTranscript = Boolean(entry);
      if (closed) {
        props.onTranscriptClose();
      }
    },
  );
  return {
    body,
    transcript,
    revision,
    retry: invalidateDefinition,
    error: () => {
      revision();
      return state.cronError;
    },
    closeTranscript: () => transcript.close(true),
  };
}
