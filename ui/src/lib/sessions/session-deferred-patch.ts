import {
  isSessionDeferredPatch,
  type SessionPatch,
  type SessionPatchOptions,
  type SessionPatchOutcome,
  type SessionPatchRoute,
} from "./patch.ts";
import type { createOptimisticArchivePatches } from "./session-mutation-operations.runtime.ts";
import { prepareSessionDeferredMutation } from "./session-mutation-operations.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import {
  type createOptimisticRowField,
  resolvePendingConversation,
  resolvePendingRowTarget,
} from "./session-pending-rows.ts";

export function deferSessionPatch(
  host: SessionMutationsHost,
  metadataFields: Record<
    "label" | "icon" | "color" | "category",
    ReturnType<typeof createOptimisticRowField<"label" | "icon" | "color" | "category">>
  >,
  archiveOwner: (
    create: typeof createOptimisticArchivePatches,
  ) => ReturnType<typeof createOptimisticArchivePatches>,
  patch: SessionPatchRoute,
  key: string,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
): SessionPatchOutcome | Promise<SessionPatchOutcome> | null {
  const snapshot = host.snapshot();
  if (
    !isSessionDeferredPatch(patchParams) ||
    (snapshot.phase === "connected" &&
      !snapshot.deferredIntentCount &&
      !snapshot.deferredIntentDraining) ||
    options.waitFor ||
    options.canDispatch?.() === false
  ) {
    return null;
  }
  const target = resolvePendingRowTarget(
    host,
    snapshot,
    resolvePendingConversation(snapshot, key, options.agentId),
    options.expectedSessionId,
  );
  if (!target) {
    return null;
  }
  const prepared = prepareSessionDeferredMutation(
    (runtime) =>
      runtime.prepareSessionPatch(
        host,
        metadataFields,
        archiveOwner,
        patch,
        target,
        patchParams,
        options,
      ),
    host.connection,
    options.onDeferredSettled,
  );
  const lifecycle = typeof patchParams.archived === "boolean";
  const lifecycleKey = `sessions.lifecycle:${target.agentId}:${target.key}`;
  if (
    !host.defer({
      key: lifecycle
        ? lifecycleKey
        : `sessions.patch:${target.agentId}:${target.key}:${Object.keys(patchParams).toSorted().join(",")}`,
      group: lifecycleKey,
      preservePosition: lifecycle,
      run: prepared.run,
      discard: prepared.discard,
    })
  ) {
    prepared.discard();
    return null;
  }
  const ready = prepared.admit();
  return ready ? ready.then(() => ({ queued: true })) : { queued: true };
}
