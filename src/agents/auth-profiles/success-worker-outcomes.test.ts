import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import type { SqliteWorkerOperations } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import * as agentWorker from "../../state/openclaw-agent-worker-store.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AuthProfileUsageResult } from "./inline-usage-kernel.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { markAuthProfileSuccess } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
  resolveProviderAuthAliasMap: () => ({}),
}));

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

it.each([
  { owner: "agent", outcome: "refused" },
  { owner: "agent", outcome: "unknown" },
  { owner: "shared", outcome: "refused" },
  { owner: "personal", outcome: "refused" },
  { owner: "shared", outcome: "unknown" },
  { owner: "personal", outcome: "unknown" },
] as const)("settles $owner success with a $outcome lock outcome", async ({ owner, outcome }) => {
  await withOpenClawTestState(
    { label: "auth-success-lock-outcome", scenario: "minimal" },
    async (state) => {
      const cfg = { agents: { list: [{ id: "main", default: true }, { id: "voice" }] } };
      setRuntimeConfigSnapshot(cfg, cfg);
      const provider = "fixture-provider";
      const profileId = "fixture-provider:success";
      const agentDir = owner === "agent" ? state.agentDir("voice") : undefined;
      const credential: AuthProfileCredential = {
        type: "api_key",
        provider,
        key: "synthetic-success-key",
      };
      let store: AuthProfileStore = {
        version: 1,
        profiles: { [profileId]: credential },
        usageStats: { [profileId]: { errorCount: 2, failureCounts: { auth: 2 } } },
      };
      let selected = profileId;
      if (owner === "personal") {
        selected = connectUserModelAccount({
          ownerProfileId: ensureProfileForEmail("lock-fixture@example.test").id,
          credential,
          assertCurrent() {},
        }).authProfileId;
        store = { version: 1, profiles: { [selected]: credential } };
      } else {
        saveAuthProfileStore(store, agentDir, {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
      }
      const readUsage = () =>
        owner === "personal"
          ? readUserModelAuthProfile(selected)?.usageStats
          : loadPersistedAuthProfileStore(agentDir)?.usageStats?.[selected];
      const previous = readUsage();
      const caller = structuredClone(store);
      const busy = Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
        errcode: 5,
      });
      const error = encodeOpenClawStateWorkerError(busy, { includeOrdinary: true });
      if (!error) {
        throw new Error("Synthetic lock refusal could not be encoded");
      }
      const refusal: AuthProfileUsageResult = { ok: false, error };
      let injected = 0;
      function injectOutcome<Operations extends SqliteWorkerOperations>(
        scope: Pick<SqliteWorkerStore<Operations>, "execute">,
      ) {
        const execute = vi.fn<typeof scope.execute>();
        execute.mockImplementation(async (command, executeOptions) => {
          const success =
            command.type === "authProfiles.usage" ||
            command.type === "authProfiles.sharedSuccess" ||
            command.type === "authProfiles.personalSuccess";
          if (success) {
            injected += 1;
            if (outcome === "refused") {
              return refusal;
            }
          }
          const result = await scope.execute(command, executeOptions);
          if (success) {
            throw busy;
          }
          return result;
        });
        return { execute };
      }
      const open = agentWorker.openOpenClawAgentSqliteWorkerStore;
      vi.spyOn(agentWorker, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
        async (...args) => {
          const client = await open(...args);
          return {
            ...client,
            run: (operation, assertCurrent) =>
              client.run((scope) => operation(injectOutcome(scope)), assertCurrent),
          };
        },
      );
      const run = stateWorker.runOpenClawStateWorkerOperation;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        (context, operation, options) =>
          run(context, (scope) => operation(injectOutcome(scope)), options),
      );
      const pending = markAuthProfileSuccess({ store, provider, profileId: selected, agentDir });
      if (outcome === "refused") {
        await expect(pending).resolves.toBeUndefined();
        expect(readUsage()).toEqual(previous);
      } else {
        await expect(pending).rejects.toThrow("database is locked");
        expect(readUsage()?.errorCount).toBe(0);
      }
      expect(injected).toBe(1);
      expect(store).toEqual(caller);
    },
  );
});
