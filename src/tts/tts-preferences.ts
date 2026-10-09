import { getTtsMachinePathAdmission } from "../state/config-machine-state.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";

export type PreparedTtsPreferences = Readonly<{ machinePrefsPath?: string }>;

/** Carry the machine-owned path through one turn; preference-file contents stay fresh. */
export async function prepareTtsPreferences(): Promise<PreparedTtsPreferences> {
  const databasePath = resolveOpenClawStateSqlitePath();
  const context = captureOpenClawStateReadWorkerContext({ path: databasePath });
  context.admission.assertCurrent();
  const admitted = getTtsMachinePathAdmission(databasePath);
  if (admitted) {
    return preparePath(admitted.row?.value_json);
  }
  const reply = await executeExistingOpenClawStateRead(
    { path: databasePath },
    { type: "tts.prefsPath" },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return {};
  }
  if (!reply.ok || reply.type !== "tts.prefsPath") {
    throw new Error("Unexpected TTS preference-path read result");
  }
  const installed = getTtsMachinePathAdmission(databasePath, () => reply.row);
  return preparePath((installed ? installed.row : reply.row)?.value_json);
}

function preparePath(valueJson: string | undefined): PreparedTtsPreferences {
  const value: unknown = valueJson === undefined ? undefined : JSON.parse(valueJson);
  if (value != null && typeof value !== "string") {
    throw new Error("Invalid TTS preference path: expected a string");
  }
  return { machinePrefsPath: value ?? undefined };
}
