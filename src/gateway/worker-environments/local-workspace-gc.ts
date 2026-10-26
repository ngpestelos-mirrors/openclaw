import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { LOCAL_WORKSPACE_NODE_BATCH } from "./local-workspace-cas.js";

/** Called by the existing workspace maintenance owner, using its admission and shutdown drain. */
export async function sweepLocalWorkspaceManifests(params: {
  signal: AbortSignal;
  assertCurrent: () => void;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  assertCurrent();
  const epoch = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "localWorkspace.beginSweep",
        input: {},
      }),
    { assertCurrent },
  );
  assertCurrent();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "localWorkspace.sweepCandidates", input: { epoch } },
    { context, current: true, live: true, signal: params.signal },
  );
  assertCurrent();
  if (!reply) {
    return;
  }
  const { nodes, paths } = reply.candidates;
  for (
    let offset = 0;
    offset < Math.max(nodes.length, paths.length);
    offset += LOCAL_WORKSPACE_NODE_BATCH
  ) {
    await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({
          type: "localWorkspace.sweepBatch",
          input: {
            epoch,
            batch: {
              nodes: nodes.slice(offset, offset + LOCAL_WORKSPACE_NODE_BATCH),
              paths: paths.slice(offset, offset + LOCAL_WORKSPACE_NODE_BATCH),
            },
          },
        }),
      { assertCurrent },
    );
    assertCurrent();
  }
}
