import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import * as publication from "./inline-usage-publication.js";
import * as usageReader from "./inline-usage-reader.js";
import { persistInlineAuthFailure } from "./inline-usage.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withAuthProfileTestState } from "./profile-mutations.test-support.js";
import {
  markAuthProfileSuccess,
  setAuthProfileOrder,
  promoteAuthProfileInOrder,
  clearLastGoodProfileWithLock,
  removeProviderAuthProfilesWithLock,
} from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "./sqlite-json.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { saveAuthProfileStore, loadAuthProfileStoreForRuntime } from "./store-runtime.js";
import { withAuthProfileStoreAgentDir } from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { markAuthProfileFailure } from "./usage.js";

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) =>
    ["gmi-cloud", "gmicloud"].includes(provider) ? "gmi" : provider,
  resolveProviderAuthAliasMap: () => ({ "gmi-cloud": "gmi", gmicloud: "gmi" }),
}));

const provider = "fixture-provider";
const profileId = "fixture-provider:success";
const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };

function createStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key", provider, key: "synthetic-success-key" } },
    usageStats: { [profileId]: { errorCount: 2, failureCounts: { auth: 2 } } },
  };
}

function holdOwnerRead(databasePath: string) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const prepare = usageReader.captureAgentAuthProfileUsageRead;
  let held = false;
  vi.spyOn(usageReader, "captureAgentAuthProfileUsageRead").mockImplementation((params) => {
    const reader = prepare(params);
    if (held || params.databasePath !== databasePath) {
      return reader;
    }
    held = true;
    return {
      ...reader,
      async read() {
        const rows = await reader.read();
        entered.resolve();
        await release.promise;
        return rows;
      },
    };
  });
  return { entered, release };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

it.each(["agent", "shared-state", "personal"] as const)(
  "persists %s success without host data SQL",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-success-worker", scenario: "minimal" },
      async (state) => {
        const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
        setRuntimeConfigSnapshot(cfg, cfg);
        const agentDir = state.agentDir(owner === "agent" ? "voice" : "main");
        let store = createStore();
        let selected = profileId;
        if (owner === "personal") {
          selected = connectUserModelAccount({
            ownerProfileId: ensureProfileForEmail("selected@example.test").id,
            credential: { type: "api_key", provider, key: "synthetic-personal-success-key" },
            assertCurrent() {},
          }).authProfileId;
          store = {
            version: 1,
            profiles: {
              [selected]: { type: "api_key", provider, key: "synthetic-personal-success-key" },
            },
          };
        } else {
          if (owner === "shared-state") {
            writeConfigMachineState(
              SHARED_AUTH_STORE_STATE_KEY,
              { location: "state-db" },
              { env: state.env },
            );
            noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
          }
          saveAuthProfileStore(store, owner === "agent" ? agentDir : undefined, saveOptions);
          setRuntimeAuthProfileStoreSnapshot(store, agentDir);
        }
        const params = {
          store,
          provider,
          profileId: selected,
          agentDir: owner === "shared-state" ? undefined : agentDir,
        };
        await markAuthProfileSuccess(params);
        const sql = observeHostDataSql(state.env);
        try {
          await markAuthProfileSuccess(params);
          expect(sql.queries).toEqual([]);
        } finally {
          sql.restore();
        }
        const persisted =
          owner === "personal"
            ? readUserModelAuthProfile(selected)?.usageStats
            : loadPersistedAuthProfileStore(owner === "agent" ? agentDir : undefined)?.usageStats?.[
                selected
              ];
        expect(persisted).toMatchObject({
          errorCount: 0,
          lastUsed: expect.any(Number),
          lastProbeAt: expect.any(Number),
        });
        expect(store.usageStats?.[selected]).toEqual(persisted);
        if (owner === "personal") {
          expect(
            getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles[selected],
          ).toBeUndefined();
          expect(store.lastGood).toBeUndefined();
        } else {
          expect(
            loadPersistedAuthProfileStore(owner === "agent" ? agentDir : undefined)?.lastGood?.[
              provider
            ],
          ).toBe(selected);
        }
      },
    );
  },
);

it.each(["current", "closed"] as const)(
  "keeps a queued failure tied to the %s owner captured before success preparation",
  async (owner) => {
    await withOpenClawTestState(
      { label: "auth-success-order", scenario: "minimal" },
      async (state) => {
        const agentDir = state.agentDir("voice");
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        const database = openOpenClawAgentDatabase({ agentId: "voice", env: state.env });
        const { entered, release } = holdOwnerRead(database.path);
        const success = markAuthProfileSuccess({ store, provider, profileId, agentDir });
        void success.catch(() => {});
        let failure: Promise<void> | undefined;
        try {
          await Promise.race([
            entered.promise,
            success.then(() => {
              throw new Error("Success bypassed the owner read");
            }),
          ]);
          failure = markAuthProfileFailure({ store, profileId, reason: "auth", agentDir });
          void failure.catch(() => {});
          if (owner === "closed") {
            closeOpenClawAgentDatabaseByPath(database.path);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([success, failure]);
        }
        if (owner === "closed") {
          await expect(success).rejects.toThrow(/revoked|closed|abort/i);
          await expect(failure).rejects.toThrow(/revoked|closed|abort/i);
        } else {
          await success;
          await failure;
        }
        const persisted = loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId];
        expect(persisted).toMatchObject(
          owner === "closed"
            ? { errorCount: 2, failureCounts: { auth: 2 } }
            : { errorCount: 1, failureCounts: { auth: 1 }, cooldownReason: "auth" },
        );
        expect(store.usageStats?.[profileId]).toEqual(persisted);
      },
    );
  },
);

it("keeps queued failure on its original state root after ambient selectors change", async () => {
  await withOpenClawTestState(
    { label: "auth-success-captured-root", scenario: "minimal" },
    async (state) => {
      const store = createStore();
      saveAuthProfileStore(store, undefined, saveOptions);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      await withOpenClawTestState(
        { label: "auth-success-replacement-root", scenario: "minimal", applyEnv: false },
        async (replacement) => {
          const replacementStore = createStore();
          replacementStore.usageStats = {
            [profileId]: { errorCount: 9, failureCounts: { auth: 9 } },
          };
          await withEnvAsync(replacement.env, async () => {
            saveAuthProfileStore(replacementStore, undefined, saveOptions);
          });
          const { entered, release } = holdOwnerRead(database.path);
          const success = markAuthProfileSuccess({ store, provider, profileId });
          void success.catch(() => {});
          let failure: Promise<void> | undefined;
          try {
            await Promise.race([
              entered.promise,
              success.then(() => {
                throw new Error("Success bypassed the owner read");
              }),
            ]);
            failure = markAuthProfileFailure({ store, profileId, reason: "auth" });
            void failure.catch(() => {});
            await withEnvAsync(replacement.env, async () => {
              release.resolve();
              await Promise.all([success, failure]);
              expect(loadPersistedAuthProfileStore()).toEqual(replacementStore);
            });
          } finally {
            release.resolve();
            await Promise.allSettled([success, failure]);
          }
          const persisted = loadPersistedAuthProfileStore()?.usageStats?.[profileId];
          expect(persisted).toMatchObject({
            errorCount: 1,
            failureCounts: { auth: 1 },
            cooldownReason: "auth",
          });
          expect(store.usageStats?.[profileId]).toEqual(persisted);
        },
      );
    },
  );
});

it.each(["removed", "relocated", "closed"] as const)(
  "does not persist success through an owner %s during preparation",
  async (change) => {
    await withOpenClawTestState(
      { label: "auth-success-owner-change", scenario: "minimal" },
      async (state) => {
        const agentDir = state.agentDir("voice");
        const store = createStore();
        saveAuthProfileStore(store, agentDir, saveOptions);
        const database = openOpenClawAgentDatabase({ agentId: "voice", env: state.env });
        const { entered, release } = holdOwnerRead(database.path);
        const success = markAuthProfileSuccess({ store, provider, profileId, agentDir });
        void success.catch(() => {});
        try {
          await Promise.race([
            entered.promise,
            success.then(() => {
              throw new Error("Success bypassed the owner read");
            }),
          ]);
          if (change === "removed") {
            saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, saveOptions);
          } else if (change === "relocated") {
            writeConfigMachineState(
              SHARED_AUTH_STORE_STATE_KEY,
              { location: "state-db" },
              { env: state.env },
            );
            noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, state.env);
          } else {
            closeOpenClawAgentDatabaseByPath(database.path);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([success]);
        }
        if (change === "removed") {
          await success;
          expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
        } else {
          await expect(success).rejects.toThrow(/changed|revoked|closed|abort/i);
        }
        expect(
          loadPersistedAuthProfileStore(agentDir)?.usageStats?.[profileId]?.lastUsed,
        ).toBeUndefined();
        expect(store.usageStats?.[profileId]?.lastUsed).toBeUndefined();
      },
    );
  },
);

it("keeps a known commit when success publication fails", async () => {
  await withOpenClawTestState(
    { label: "auth-success-publication", scenario: "minimal" },
    async (state) => {
      const agentDir = state.agentDir("voice");
      const store = createStore();
      saveAuthProfileStore(store, agentDir, saveOptions);
      setRuntimeAuthProfileStoreSnapshot(store, agentDir);
      const publish = vi
        .spyOn(publication, "publishAuthProfileUsage")
        .mockRejectedValue(new Error("synthetic publication failure"));
      await expect(
        markAuthProfileSuccess({ store, provider, profileId, agentDir }),
      ).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)).toBeUndefined();
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.usageStats?.[profileId]).toMatchObject({
        errorCount: 0,
        lastUsed: expect.any(Number),
      });
      expect(store.usageStats?.[profileId]).toEqual(persisted?.usageStats?.[profileId]);
      expect(store.lastGood?.[provider]).toBe(profileId);
    },
  );
});

it("canonicalizes every alias-equivalent provider state mutation", async () => {
  await withAuthProfileTestState("openclaw-auth-alias-state-", async ({ agentDir }) => {
    fs.mkdirSync(agentDir, { recursive: true });
    const primary = "gmi:primary";
    const secondary = "gmi:secondary";
    const profiles = {
      [primary]: { type: "api_key" as const, provider: "gmi", key: "primary" },
      [secondary]: { type: "api_key" as const, provider: "gmi", key: "secondary" },
      "openai:other": { type: "api_key" as const, provider: "openai", key: "other" },
    };
    const seeded = (): AuthProfileStore => ({
      version: AUTH_STORE_VERSION,
      profiles,
      order: {
        "gmi-cloud": [primary],
        openai: ["openai:other"],
        gmicloud: [secondary],
      },
      lastGood: { gmicloud: secondary, openai: "openai:other", "gmi-cloud": primary },
    });

    saveAuthProfileStore(seeded(), agentDir);
    clearRuntimeAuthProfileStoreSnapshots();
    await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: [secondary] });
    expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
      openai: ["openai:other"],
      gmi: [secondary],
    });
    saveAuthProfileStore(
      {
        ...seeded(),
        order: { ...seeded().order, gmi: [primary] },
      },
      agentDir,
    );
    clearRuntimeAuthProfileStoreSnapshots();
    await setAuthProfileOrder({ agentDir, provider: "gmi-cloud", order: null });
    expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
      openai: ["openai:other"],
    });

    saveAuthProfileStore(
      {
        ...seeded(),
        order: { ...seeded().order, "gmi-cloud": [secondary, primary] },
      },
      agentDir,
    );
    clearRuntimeAuthProfileStoreSnapshots();
    await promoteAuthProfileInOrder({ agentDir, provider: "gmi-cloud", profileId: secondary });
    expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({
      openai: ["openai:other"],
      gmi: [secondary, primary],
    });

    saveAuthProfileStore(seeded(), agentDir);
    clearRuntimeAuthProfileStoreSnapshots();
    await clearLastGoodProfileWithLock({ agentDir, provider: "gmi-cloud", profileId: secondary });
    expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual({
      openai: "openai:other",
    });

    saveAuthProfileStore(seeded(), agentDir);
    clearRuntimeAuthProfileStoreSnapshots();
    const runtimeStore = loadAuthProfileStoreForRuntime(agentDir);
    await markAuthProfileSuccess({
      agentDir,
      profileId: secondary,
      provider: "gmi-cloud",
      store: runtimeStore,
    });
    expect(loadPersistedAuthProfileStore(agentDir)?.lastGood).toEqual({
      openai: "openai:other",
      gmi: secondary,
    });

    saveAuthProfileStore(seeded(), agentDir);
    clearRuntimeAuthProfileStoreSnapshots();
    await removeProviderAuthProfilesWithLock({ agentDir, provider: "gmi-cloud" });
    expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
      profiles: { "openai:other": expect.any(Object) },
      order: { openai: ["openai:other"] },
      lastGood: { openai: "openai:other" },
    });
  });
});

it("creates the selected agent database for its first inline-key failure", async () => {
  await withOpenClawTestState(
    { label: "auth-inline-first-use", scenario: "minimal" },
    async (state) => {
      const agentDir = state.agentDir("voice");
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      expect(fs.existsSync(databasePath)).toBe(false);

      await persistInlineAuthFailure(agentDir, { provider, reason: "auth" });

      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.profiles).toEqual({});
      expect(persisted?.usageStats?.[`inline-api-key:${provider}`]).toMatchObject({
        errorCount: 1,
        failureCounts: { auth: 1 },
      });
      expect(loadPersistedAuthProfileStore()?.usageStats).toBeUndefined();
    },
  );
});

it.each(["success", "failure"] as const)(
  "keeps scoped shared-only %s local when its agent database does not exist",
  async (outcome) => {
    await withOpenClawTestState(
      { label: "auth-scoped-usage-first-use", scenario: "minimal" },
      async (state) => {
        const shared = createStore();
        const mainAgentDir = state.agentDir("main");
        saveAuthProfileStore(shared, mainAgentDir, saveOptions);
        const sharedBefore = loadPersistedAuthProfileStore(mainAgentDir);
        const agentDir = state.agentDir("isolated");
        const databasePath = resolveAuthProfileDatabasePath(agentDir);

        await withAuthProfileStoreAgentDir(agentDir, state.stateDir, async () => {
          const store = loadAuthProfileStoreForRuntime(undefined, {
            readOnly: true,
            externalCli: { mode: "none" },
          });
          expect(store.profiles[profileId]).toEqual(shared.profiles[profileId]);
          expect(fs.existsSync(databasePath)).toBe(false);

          if (outcome === "success") {
            await markAuthProfileSuccess({ store, provider, profileId });
            expect(store.usageStats?.[profileId]).toMatchObject({
              errorCount: 0,
              lastUsed: expect.any(Number),
              lastProbeAt: expect.any(Number),
            });
            expect(store.lastGood?.[provider]).toBe(profileId);
          } else {
            await markAuthProfileFailure({ store, profileId, reason: "auth" });
            expect(store.usageStats?.[profileId]).toMatchObject({
              errorCount: 3,
              failureCounts: { auth: 3 },
              cooldownReason: "auth",
            });
            expect(store.lastGood?.[provider]).toBeUndefined();
          }
        });

        const local = loadPersistedAuthProfileStore(agentDir);
        expect(local?.profiles).toEqual({});
        expect(local?.usageStats?.[profileId]).toBeUndefined();
        expect(local?.lastGood?.[provider]).toBeUndefined();
        expect(local?.order?.[provider]).toBeUndefined();
        expect(loadPersistedAuthProfileStore(mainAgentDir)).toEqual(sharedBefore);
      },
    );
  },
);
