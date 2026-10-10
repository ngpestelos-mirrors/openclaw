import type { ServerUiPrefs } from "./server-prefs-state.ts";

type ProfileAppearancePrefs = {
  profileId: string;
  scope: string;
  prefs: ServerUiPrefs;
  sidebarEntriesReady: boolean;
};
export type ProfilePreferencesReadOptions = {
  configObject: unknown;
  canMigrate: boolean | (() => boolean);
  isCurrent: () => boolean;
  onSidebarEntriesUnavailable?: (error: unknown) => void;
};

// The asynchronous reader borrows this same owner, never a copied publication state.
export type ProfilePreferencesState = {
  appearance: ProfileAppearancePrefs | null;
  identity: { profileId: string; scope: string } | null;
  requestId: number;
};
export const profilePreferencesState: ProfilePreferencesState = {
  appearance: null,
  identity: null,
  requestId: 0,
};

// Eager identity updates and the deferred reader share this owner and request generation.
const state = profilePreferencesState;

export function resolveProfilePreferenceScope(scope: string, profileId?: string | null): string {
  return profileId ? `${scope}:profile:${profileId}` : scope;
}

export function resolveProfileAppearanceProfileId(scope: string): string | null {
  return state.identity?.scope === scope ? state.identity.profileId : null;
}

export function rememberProfileAppearanceIdentity(scope: string, profileId: string): void {
  if (state.identity?.scope !== scope || state.identity.profileId !== profileId) {
    state.requestId += 1;
  }
  state.identity = { scope, profileId };
}

export function resetProfileAppearancePrefs(): void {
  state.appearance = null;
  state.identity = null;
  state.requestId += 1;
}
