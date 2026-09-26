import { resolveStateDir } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { getScopedAuthProfileEnv } from "./store.js";

const pendingUsage = new Map<string, Promise<unknown>>();

/** Preserve health update order while credential-owner discovery awaits worker reads. */
export function runAuthProfileUsageAdmission<T>(
  profileId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([
    resolvePathViaExistingAncestorSync(resolveStateDir(getScopedAuthProfileEnv())),
    profileId,
  ]);
  const previous = pendingUsage.get(key);
  // The first writer must reserve its physical owner before a later native writer can enter.
  const current = previous ? previous.catch(() => undefined).then(operation) : operation();
  pendingUsage.set(key, current);
  const release = () => {
    if (pendingUsage.get(key) === current) {
      pendingUsage.delete(key);
    }
  };
  void current.then(release, release);
  return current;
}
