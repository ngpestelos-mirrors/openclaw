import { managedWorktrees } from "../agents/worktrees/service.js";

/** Detach one reset session while preserving a checkout still used by peers. */
export async function detachSessionWorktreeForReset(id: string, sessionKey: string) {
  const remainingBindings = managedWorktrees.deactivateSession(id, sessionKey);
  if (remainingBindings > 0) {
    managedWorktrees.forgetSession(id, sessionKey);
    return undefined;
  }
  if (
    await managedWorktrees.removeIfLossless(id, {
      expectedActiveSessionKeys: [],
    })
  ) {
    return undefined;
  }
  return managedWorktrees.findLiveById(id);
}
