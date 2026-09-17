import { bindRegistryWorktreeSession, listRegistryWorktreeSessionBindings } from "./registry.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeRecord,
} from "./types.js";

export function bindSessionForCreation(
  env: NodeJS.ProcessEnv,
  now: number,
  request: CreateManagedWorktreeParams,
  record: ManagedWorktreeRecord,
): ManagedWorktreeCreationOutcome["sessionBindingPreviousState"] {
  if (request.ownerKind !== "session" || !request.ownerId) {
    return undefined;
  }
  const sessionKeys = listRegistryWorktreeSessionBindings(env, record.id);
  request.sessionBindingGuard?.(record, sessionKeys);
  request.commitGuard?.();
  return bindRegistryWorktreeSession(env, record.id, request.ownerId, now, {
    expectedSessionKeys: sessionKeys,
  });
}
