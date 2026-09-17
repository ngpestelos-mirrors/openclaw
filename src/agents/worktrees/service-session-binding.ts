import { bindRegistryWorktreeSession, listRegistryWorktreeSessionBindings } from "./registry.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeCreationOutcome,
  ManagedWorktreeRecord,
} from "./types.js";

export function bind(
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

/** Authorize an existing persisted membership set before restore mutates its checkout. */
export function authorizeSessionRestore(
  env: NodeJS.ProcessEnv,
  request: CreateManagedWorktreeParams,
  record: ManagedWorktreeRecord,
): void {
  if (request.ownerKind !== "session" || !request.ownerId) {
    request.commitGuard?.();
    return;
  }
  request.sessionBindingGuard?.(record, listRegistryWorktreeSessionBindings(env, record.id));
  request.commitGuard?.();
}
