import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
  retainPreparedSessionSharingFacts,
  projectSessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";

// The canonical executor still owns real SQL, admission, and settlement; only reply delivery changes.
const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => void | Promise<void>) | undefined,
  releaseFailure: undefined as Error | undefined,
}));
vi.mock("../../state/openclaw-agent-execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-agent-execution.js")>();
  return {
    ...actual,
    captureOpenClawAgentDatabaseExecution: (
      ...args: Parameters<typeof actual.captureOpenClawAgentDatabaseExecution>
    ): ReturnType<typeof actual.captureOpenClawAgentDatabaseExecution> => {
      const owned = actual.captureOpenClawAgentDatabaseExecution(...args);
      return {
        ...owned,
        runExisting: (source, operation, options) =>
          owned.runExisting(
            source,
            (scope) =>
              operation({
                execute: async (command, commandOptions) => {
                  const result = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace") {
                    await delivery.afterResult?.();
                  }
                  return result;
                },
              }),
            options,
          ),
        release: async () => {
          await owned.release();
          if (delivery.releaseFailure) {
            throw delivery.releaseFailure;
          }
        },
      };
    },
  };
});

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.releaseFailure = undefined;
});

it.each(["lost result", "release failure", "newer native write", "late writer"] as const)(
  "preserves replacement publication through %s",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const options = { agentId: "main", path: database.path };
      const sessionKey = "agent:main:replacement-settlement";
      const original = {
        sessionId: "settlement",
        updatedAt: 1,
        visibility: "shared" as const,
        label: "before",
      };
      writeSessionEntry(database, sessionKey, original);
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected durable fixture");
      }
      const sharing = retainPreparedSessionSharingFacts({
        databaseIdentity: `file:${identity}`,
        sessionKey,
        entry: projectSessionSharingEntry(original),
        membership: new Set(["member"]),
      });
      let writer = database;
      if (boundary === "late writer") {
        await closeOpenClawAgentDatabaseByPathAsync(database.path);
      } else {
        readSessionEntryCache(writer, { cache: true });
      }
      const observed: Array<string | undefined> = [];
      const caches: unknown[] = [];
      const stop = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === sessionKey) {
          observed.push(sharing.readCurrent()?.entry?.visibility);
          caches.push(readCommittedSessionEntryCache(writer.db)?.get(sessionKey)?.label);
        }
      });
      let executions = 0;
      let whileWaiting: ReturnType<typeof sharing.readCurrent>;
      const failure = new Error(`synthetic ${boundary}`);
      delivery.afterResult = () => {
        executions++;
        whileWaiting = sharing.readCurrent();
        if (boundary === "lost result") {
          throw failure;
        }
        if (boundary === "newer native write") {
          replaceSessionEntrySync(
            { agentId: "main", storePath: database.path, sessionKey },
            { ...original, updatedAt: 3, visibility: "draft", label: "newer" },
          );
        }
      };
      if (boundary === "release failure") {
        delivery.releaseFailure = failure;
      }
      try {
        const operation = applySessionEntryExactReplacements({
          storePath: database.path,
          sessionKeys: [sessionKey],
          update: ([row]) => {
            if (boundary === "late writer") {
              writer = openOpenClawAgentDatabase(options);
              readSessionEntryCache(writer, { cache: true });
            }
            return {
              result: undefined,
              replacements: [
                { sessionKey, entry: { ...row!.entry, visibility: "read-only", label: "worker" } },
              ],
            };
          },
        });
        if (boundary === "lost result" || boundary === "release failure") {
          await expect(operation).rejects.toBe(failure);
        } else {
          await operation;
        }
        expect(executions).toBe(1);
        if (boundary !== "late writer") {
          expect(whileWaiting).toBeUndefined();
        }
        expect(sharing.readCurrent()).toMatchObject({
          entry: { visibility: boundary === "newer native write" ? "draft" : "read-only" },
          membership: new Set(["member"]),
        });
        expect(readExactSessionEntryRow(writer, sessionKey)?.entry.label).toBe(
          boundary === "newer native write" ? "newer" : "worker",
        );
        expect(observed).toEqual([boundary === "newer native write" ? "draft" : "read-only"]);
        if (boundary === "late writer") {
          expect(caches).toEqual([undefined]);
        }
      } finally {
        delivery.afterResult = undefined;
        delivery.releaseFailure = undefined;
        stop();
        sharing.release();
      }
    });
  },
);

it("fences inline maintenance rows and preserves a newer native publication for them", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { resetConfigRuntimeState, setRuntimeConfigSnapshot } = await import("../config.js");
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const activeKey = "agent:main:replacement-maintenance-active";
    const archivedKey = "agent:main:replacement-maintenance-old";
    writeSessionEntry(database, activeKey, { sessionId: "active", updatedAt: Date.now() });
    const original = { sessionId: "maintenance-old", updatedAt: 1, visibility: "shared" as const };
    writeSessionEntry(database, archivedKey, original);
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    if (typeof identity !== "string") {
      throw new Error("Expected durable fixture");
    }
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey: archivedKey,
      entry: projectSessionSharingEntry(original),
      membership: new Set(["member"]),
    });
    const config = {
      session: { maintenance: { mode: "enforce" as const, maxEntries: 1, pruneAfter: "1000000d" } },
    };
    setRuntimeConfigSnapshot(config, config);
    let whileWaiting: ReturnType<typeof sharing.readCurrent>;
    delivery.afterResult = () => {
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.archivedAt).toEqual(
        expect.any(Number),
      );
      whileWaiting = sharing.readCurrent();
      replaceSessionEntrySync(
        { agentId: "main", storePath: database.path, sessionKey: archivedKey },
        { ...original, updatedAt: Date.now(), visibility: "draft", label: "newer maintenance row" },
      );
    };
    try {
      await applySessionEntryExactReplacements({
        storePath: database.path,
        activeSessionKey: activeKey,
        sessionKeys: [activeKey],
        skipMaintenance: false,
        update: ([row]) => ({
          result: undefined,
          replacements: [{ sessionKey: activeKey, entry: { ...row!.entry, label: "updated" } }],
        }),
      });
      expect(whileWaiting).toBeUndefined();
      expect(sharing.readCurrent()).toMatchObject({
        entry: { visibility: "draft" },
        membership: new Set(["member"]),
      });
      expect(readExactSessionEntryRow(database, archivedKey)?.entry.label).toBe(
        "newer maintenance row",
      );
    } finally {
      delivery.afterResult = undefined;
      resetConfigRuntimeState();
      sharing.release();
    }
  });
});
