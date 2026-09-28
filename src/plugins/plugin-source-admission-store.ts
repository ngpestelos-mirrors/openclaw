import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { resolveInstalledPluginIndexStateDatabaseOptions } from "./installed-plugin-index-store-path.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

/** Publish native admission facts without replacing the running metadata snapshot. */
export async function publishPluginSourceAdmission(
  params: PluginSourceAdmissionPublication & { env?: NodeJS.ProcessEnv; stateDir?: string },
): Promise<boolean> {
  if (isArtifactPreservingStateRead()) {
    return false;
  }
  const { env, stateDir, ...publication } = params;
  const prepared = structuredClone(publication);
  const context = captureOpenClawStateWorkerContext(
    resolveInstalledPluginIndexStateDatabaseOptions({ env, stateDir }),
  );
  return (
    (await runOpenClawStateWorkerOperation(
      context,
      (scope) =>
        scope.execute({ type: "plugins.metadata.sourceAdmission.publish", input: prepared }),
      { existingOnly: true },
    )) ?? false
  );
}
