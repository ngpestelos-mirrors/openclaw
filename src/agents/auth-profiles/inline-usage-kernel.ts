import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { mergeAuthProfileStores, mergePersistedAuthProfileState } from "./persisted.js";
import { pruneAuthProfileStoreReferences } from "./runtime-snapshot-owner.js";
import { readAdmittedAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json.js";
import { prepareAuthProfileStateMutation } from "./store-mutation.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type { AuthProfileFailureReason, AuthProfileStore, ProfileUsageStats } from "./types.js";
import { computeNextProfileUsageStats } from "./usage-failure-state.js";
import { resetAuthProfileFailureState, resolveInlineProviderApiKeyUsageId } from "./usage-state.js";

export type AuthProfileUsageInput =
  | {
      kind: "inline-failure";
      provider: string;
      reason: Extract<AuthProfileFailureReason, "auth" | "auth_permanent" | "billing">;
      modelId?: string;
      expectedCredentials: unknown;
      inheritedUsageStats?: AuthProfileStore["usageStats"];
    }
  | {
      kind: "success";
      profileId: string;
      provider: string;
      providerAliases: Record<string, string>;
      lastUsed: number;
      inherited: boolean;
      scopedSharedStore?: AuthProfileStore;
    };

export type AuthProfileSuccessInput = Extract<AuthProfileUsageInput, { kind: "success" }>;

export type AuthProfileUsageReceipt = {
  store: AuthProfileStore;
  applied: boolean;
  previousStats?: ProfileUsageStats;
  nextStats?: ProfileUsageStats;
  now: number;
  publication: {
    credentialsChanged: boolean;
    profileSetChanged: boolean;
    stateChanged: boolean;
    selectionChanged: boolean;
    profileIds: string[];
  };
};

export type AuthProfileUsageResult =
  | { ok: true; receipt: AuthProfileUsageReceipt }
  | { ok: false; error: OpenClawStateWorkerErrorPayload };

export type AuthProfileUsageOperations = {
  "authProfiles.usageSnapshot": {
    input: undefined;
    output: import("./types.js").AuthProfileRowRead;
  };
  "authProfiles.usage": { input: AuthProfileUsageInput; output: AuthProfileUsageResult };
};

export type AuthProfileStateSuccessOperations = {
  "authProfiles.sharedSuccess": { input: AuthProfileSuccessInput; output: AuthProfileUsageResult };
  "authProfiles.personalSuccess": {
    input: AuthProfileSuccessInput;
    output: AuthProfileUsageResult;
  };
};

/** The credential owner supplies a fresh store; alias facts come from host preparation. */
export function applyAuthProfileSuccess(
  store: AuthProfileStore,
  input: AuthProfileSuccessInput,
): AuthProfileUsageReceipt {
  const receipt: AuthProfileUsageReceipt = {
    store,
    applied: false,
    now: Date.now(),
    publication: {
      credentialsChanged: false,
      profileSetChanged: false,
      stateChanged: false,
      selectionChanged: false,
      profileIds: [],
    },
  };
  const canonicalProvider = (provider: string) => {
    const normalized = normalizeProviderId(provider);
    return Object.hasOwn(input.providerAliases, normalized)
      ? input.providerAliases[normalized]
      : normalized;
  };
  const profile = store.profiles[input.profileId];
  if (
    !profile ||
    profile.setup?.replacement ||
    canonicalProvider(profile.provider) !== input.provider
  ) {
    return receipt;
  }
  if (!input.inherited && !isUserModelAuthProfileId(input.profileId)) {
    store.lastGood = {
      ...Object.fromEntries(
        Object.entries(store.lastGood ?? {}).filter(
          ([provider]) => canonicalProvider(provider) !== input.provider,
        ),
      ),
      [input.provider]: input.profileId,
    };
  }
  receipt.previousStats = store.usageStats?.[input.profileId];
  receipt.nextStats = resetAuthProfileFailureState(receipt.previousStats ?? {}, {
    lastProbeAt: receipt.now,
    ...(input.inherited ? {} : { lastUsed: input.lastUsed }),
  });
  store.usageStats = { ...store.usageStats, [input.profileId]: receipt.nextStats };
  receipt.applied = true;
  return receipt;
}

/** The admitted transaction owns the fresh read, health reduction, and durable cells. */
export function recordAuthProfileUsageInDatabase(
  database: DatabaseSync,
  databasePath: string,
  input: AuthProfileUsageInput,
  databaseKind: "agent" | "shared-state",
): AuthProfileUsageReceipt {
  const credentials = readAdmittedAuthProfileJsonCell(database, "store", databaseKind);
  if (
    input.kind === "inline-failure" &&
    !isDeepStrictEqual(
      credentials.status === "readable" ? credentials.raw : null,
      input.expectedCredentials,
    )
  ) {
    throw new Error("Auth credentials changed during inline-failure preparation");
  }
  const state = readAdmittedAuthProfileJsonCell(database, "state", databaseKind);
  const existingState = state.status === "readable" ? state.raw : null;
  const loaded = mergePersistedAuthProfileState(
    credentials.status === "readable" ? credentials.raw : null,
    () => existingState,
  );
  if (!loaded && credentials.status !== "missing") {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  const localStore = loaded ?? { version: AUTH_STORE_VERSION, profiles: {} };
  const store =
    input.kind === "success" && input.scopedSharedStore
      ? mergeAuthProfileStores(input.scopedSharedStore, localStore)
      : localStore;
  let receipt: AuthProfileUsageReceipt;
  if (input.kind === "success") {
    receipt = applyAuthProfileSuccess(store, input);
    if (!receipt.applied) {
      return receipt;
    }
  } else {
    // The bounded CLI auth scope supplies its captured shared read-through facts.
    // Persist only state that the existing local-save owner retains.
    const inheritedUsageStats = Object.fromEntries(
      Object.entries(input.inheritedUsageStats ?? {}).filter(
        ([profileId]) => store.profiles[profileId] || profileId.startsWith("inline-api-key:"),
      ),
    );
    store.usageStats = { ...inheritedUsageStats, ...store.usageStats };
    const usageId = resolveInlineProviderApiKeyUsageId(input.provider);
    const previousStats = store.usageStats?.[usageId];
    const now = Date.now();
    const nextStats = computeNextProfileUsageStats({
      existing: previousStats ?? {},
      now,
      reason: input.reason,
      modelId: input.modelId,
    });
    store.usageStats = { ...store.usageStats, [usageId]: nextStats };
    receipt = {
      store,
      applied: true,
      previousStats,
      nextStats,
      now,
      publication: {
        credentialsChanged: false,
        profileSetChanged: false,
        stateChanged: false,
        selectionChanged: false,
        profileIds: [],
      },
    };
  }
  let persistedStore = store;
  if (input.kind === "success" && input.scopedSharedStore) {
    persistedStore = structuredClone(store);
    persistedStore.profiles = localStore.profiles;
    const localProfileIds = new Set(Object.keys(localStore.profiles));
    const retainedOrderIds = new Set([
      ...localProfileIds,
      ...Object.values(localStore.order ?? {}).flat(),
    ]);
    pruneAuthProfileStoreReferences(persistedStore, localProfileIds, retainedOrderIds);
  }
  const { statePayload, stateChanged, selectionChanged } = prepareAuthProfileStateMutation({
    existingState,
    store: persistedStore,
    selectionProfiles: persistedStore.profiles,
  });
  // A state row needs the same empty credential-store anchor as ordinary auth saves.
  // Existing credential bytes belong to credential mutations, not usage bookkeeping.
  if (credentials.status === "missing") {
    writeAuthProfileJsonCell(database, "store", databaseKind, {
      version: AUTH_STORE_VERSION,
      profiles: {},
    });
  }
  if (stateChanged) {
    writeAuthProfileJsonCell(database, "state", databaseKind, statePayload);
  }
  receipt.publication.stateChanged = stateChanged;
  receipt.publication.selectionChanged = selectionChanged;
  return receipt;
}
