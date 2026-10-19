import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  importPluginStateEntriesForDoctorForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVoiceCallLogs } from "../cli-call-log.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
  makePersistedCall,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema, type CallRecord } from "../types.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import {
  findCallInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./store.js";

const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn() }));
vi.mock("../../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api.js")>()),
  sleep: sleepMock,
}));

// These names are persisted storage contracts, independent of private store declarations.
const CALL_RECORD_EVENTS_NAMESPACE = "call-record-events";
const CALL_RECORD_EVENT_CHUNKS_NAMESPACE = "call-record-event-chunks";
const CALL_RECORD_CHUNK_MAX_ENTRIES = 48_048;
const MANAGER_REPLAY_KEY_LIMIT = 10_000;

function installStateRuntime({
  beforeOperation,
  onChunkRead,
}: {
  beforeOperation?: (
    namespace: string,
    operation: "register" | "entries" | "count",
    key?: string,
  ) => Promise<void>;
  onChunkRead?: (keys: readonly string[]) => void;
} = {}): void {
  const state = createVoiceCallStateRuntimeForTests();
  setVoiceCallStateRuntime({
    state: {
      ...state,
      openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) => {
        const backingStore = state.openKeyedStoreV2<T>(options);
        if (onChunkRead && options.namespace === CALL_RECORD_EVENT_CHUNKS_NAMESPACE) {
          return {
            ...backingStore,
            async lookupMany(keys: readonly string[]) {
              const rows = await backingStore.lookupMany(keys);
              onChunkRead(keys);
              return rows;
            },
          };
        }
        return beforeOperation
          ? {
              ...backingStore,
              async register(...args: Parameters<typeof backingStore.register>) {
                await beforeOperation(options.namespace, "register", args[0]);
                await backingStore.register(...args);
              },
              async entries() {
                await beforeOperation(options.namespace, "entries");
                return backingStore.entries();
              },
              async count() {
                await beforeOperation(options.namespace, "count");
                return await backingStore.count();
              },
            }
          : backingStore;
      },
    },
  });
}

async function mutateOfflineCallStore(
  storePath: string,
  mutate: (db: ReturnType<typeof openOpenClawStateDatabase>["db"]) => void,
): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const databasePath = path.join(storePath, "state", "openclaw.sqlite");
  const replacementPath = `${databasePath}.corruption-fixture`;
  // A cold physical copy models restart corruption without stale in-process write receipts.
  fs.copyFileSync(databasePath, replacementPath, fs.constants.COPYFILE_EXCL);
  fs.renameSync(replacementPath, databasePath);
  try {
    mutate(openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } }).db);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  }
}

const makeCall = (overrides: Parameters<typeof makePersistedCall>[0] = {}) =>
  CallRecordSchema.parse(makePersistedCall(overrides));
const transcript = (text: string, timestamp = Date.now()): CallRecord["transcript"] => [
  { timestamp, speaker: "user", text, isFinal: true },
];

describe("voice-call call record store", () => {
  let storePath: string;
  const saveCall = (overrides: Parameters<typeof makePersistedCall>[0]) =>
    persistCallRecord(storePath, makeCall(overrides));
  const openStore = <T>(namespace: string, maxEntries: number) =>
    createPluginStateKeyedStoreForTests<T>("voice-call", {
      namespace,
      maxEntries,
      env: { ...process.env, OPENCLAW_STATE_DIR: storePath },
    });
  const corruptRow = (namespace: string, key: string, value: unknown) =>
    mutateOfflineCallStore(storePath, (db) => {
      db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'voice-call' AND namespace = ? AND entry_key = ?",
      ).run(JSON.stringify(value), namespace, key);
    });
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
    storePath = createTestStorePath();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });

  it.each([0, 1])("honors SQLite tail --since %s before following new snapshots", async (since) => {
    const calls = ["first", "second", "third"].map((callId) => makeCall({ callId }));
    const added = makeCall({ callId: "new" });
    for (const call of calls) {
      await persistCallRecord(storePath, call);
    }
    const stopped = new Error("SQLite tail test finished");
    sleepMock
      .mockReset()
      .mockRejectedValue(stopped)
      .mockImplementationOnce(async () => {
        await persistCallRecord(storePath, added);
      });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const program = new Command();
    registerVoiceCallLogs({
      root: program,
      defaultFile: path.join(storePath, "calls.jsonl"),
      ensureHistoryStateRuntime: installStateRuntime,
    });
    try {
      await expect(
        program.parseAsync(["tail", "--since", String(since)], { from: "user" }),
      ).rejects.toBe(stopped);
      expect(
        output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).callId),
      ).toEqual(since === 0 ? ["new"] : ["third", "new"]);
    } finally {
      stdout.mockRestore();
    }
  });

  it("bounds bulk chunk reads across retained call snapshots", async () => {
    const calls = Array.from({ length: 129 }, (_, index) =>
      makeCall({
        callId: `call-batch-${index}`,
        providerCallId: `provider-batch-${index}`,
        processedEventIds: [`event-${index}`],
        transcript: index === 127 ? transcript("x".repeat(110_000), 1) : [],
      }),
    );
    for (const call of calls) {
      await persistCallRecord(storePath, call);
    }
    resetPluginStateStoreForTests();
    const chunkQueries: string[][] = [];
    installStateRuntime({ onChunkRead: (keys) => chunkQueries.push([...keys]) });
    await expect(getCallHistoryFromStore(storePath, calls.length)).resolves.toEqual(calls);
    expect(chunkQueries.length).toBeLessThanOrEqual(2);
    expect(chunkQueries.flat()).toHaveLength(131);
    const eventQueries = new Map<string, number>();
    for (const [queryIndex, keys] of chunkQueries.entries()) {
      expect(keys.length).toBeLessThanOrEqual(128);
      for (const key of keys) {
        const eventKey = key.slice(0, key.lastIndexOf(":chunk:"));
        expect(eventQueries.get(eventKey) ?? queryIndex).toBe(queryIndex);
        eventQueries.set(eventKey, queryIndex);
      }
    }
    const restored = await loadActiveCallsFromStore(storePath);
    expect([...restored.activeCalls.values()]).toEqual(calls);
    expect([...restored.processedEventIds]).toEqual(
      calls.flatMap((call) => call.processedEventIds),
    );
    await expect(findCallInStore(storePath, "provider-batch-127")).resolves.toEqual(calls[127]);
  });

  it("preserves errors before later malformed metadata", async () => {
    for (const callId of ["earlier", "later"]) {
      await saveCall({ callId });
    }
    const events = openStore<{ chunkCount: number; sequence: number }>(
      CALL_RECORD_EVENTS_NAMESPACE,
      1100,
    );
    const rows = (await events.entries()).toSorted((a, b) => a.value.sequence - b.value.sequence);
    const first = expectDefined(rows[0], "earlier persisted event");
    const second = expectDefined(rows[1], "later persisted event");
    await mutateOfflineCallStore(storePath, (db) => {
      const update = db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = 'voice-call' AND namespace = ? AND entry_key = ?",
      );
      db.prepare(
        "UPDATE plugin_state_entries SET created_at = ? WHERE namespace = ? AND entry_key = ?",
      ).run(1, CALL_RECORD_EVENTS_NAMESPACE, first.key);
      db.prepare(
        "UPDATE plugin_state_entries SET created_at = ? WHERE namespace = ? AND entry_key = ?",
      ).run(2, CALL_RECORD_EVENTS_NAMESPACE, second.key);
      update.run("null", CALL_RECORD_EVENTS_NAMESPACE, second.key);
      update.run("invalid JSON", CALL_RECORD_EVENT_CHUNKS_NAMESPACE, `${first.key}:chunk:0000`);
    });
    await expect(findCallInStore(storePath, "later")).rejects.toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
    );
    await corruptRow(CALL_RECORD_EVENT_CHUNKS_NAMESPACE, `${first.key}:chunk:0000`, {
      index: -1,
      dataBase64: "",
    });
    await expect(findCallInStore(storePath, "later")).rejects.toBeInstanceOf(TypeError);
    await corruptRow(CALL_RECORD_EVENTS_NAMESPACE, second.key, {
      chunkCount: 0,
      byteLength: 0,
    });
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
  });

  it("restores complete chunked call transcripts", async () => {
    const call = makeCall({
      callId: "call-chunked",
      transcript: transcript("🦞".repeat(180_000)),
    });
    await persistCallRecord(storePath, call);
    resetPluginStateStoreForTests();
    expect(
      (await loadActiveCallsFromStore(storePath)).activeCalls.get(call.callId)?.transcript,
    ).toEqual(call.transcript);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
    const openChunks = () =>
      openStore<{ index: number; dataBase64: string }>(
        CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
        CALL_RECORD_CHUNK_MAX_ENTRIES,
      );
    let chunks = openChunks();
    const rows = await chunks.entries();
    const first = expectDefined(
      rows.find((row) => row.value.index === 0),
      "first chunk",
    );
    const later = expectDefined(
      rows.find((row) => row.value.index === 1),
      "later chunk",
    );
    const good = makeCall({ callId: "good-call", transcript: [] });
    await persistCallRecord(storePath, good);
    await mutateOfflineCallStore(storePath, (db) => {
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        "invalid JSON",
        later.key,
      );
    });
    chunks = openChunks();
    await chunks.register(first.key, { ...first.value, index: -1 });
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
    expect(await findCallInStore(storePath, good.callId)).toEqual(good);
    await chunks.delete(first.key);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
    await chunks.register(first.key, first.value);
    await expect(findCallInStore(storePath, good.callId)).rejects.toThrowError(
      expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
    );
  });

  it.each([1, 2])(
    "stops at failed chunk write %s without publishing metadata",
    async (failedWrite) => {
      const call = makeCall({
        transcript: transcript("x".repeat(100_000), 1),
      });
      const failure = new Error("chunk write failed");
      let writes = 0;
      const beforeWrite = vi.fn((_namespace: string) => {
        if (++writes === failedWrite) {
          throw failure;
        }
      });
      installStateRuntime({
        beforeOperation: async (namespace, operation) => {
          if (operation === "register") {
            beforeWrite(namespace);
          }
        },
      });
      const toString = vi.spyOn(Buffer.prototype, "toString");
      try {
        await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
        expect(beforeWrite.mock.calls).toEqual(
          Array.from({ length: failedWrite }, () => [CALL_RECORD_EVENT_CHUNKS_NAMESPACE]),
        );
        expect(toString.mock.calls.filter(([encoding]) => encoding === "base64")).toHaveLength(
          failedWrite,
        );
        toString.mockRestore();
        const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: storePath } });
        expect(
          db
            .prepare(
              "SELECT namespace, json_extract(value_json, '$.index') AS chunk_index FROM plugin_state_entries WHERE plugin_id = ? ORDER BY entry_key",
            )
            .all("voice-call"),
        ).toEqual(
          Array.from({ length: failedWrite - 1 }, (_, index) => ({
            namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
            chunk_index: index,
          })),
        );
        resetPluginStateStoreForTests();
        expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
      } finally {
        toString.mockRestore();
      }
    },
  );

  it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
    const call = makeCall({
      callId: "call-large",
      metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
      transcript: transcript("x".repeat(3 * 1024 * 1024)),
    });

    await persistCallRecord(storePath, call);

    const restored = await loadActiveCallsFromStore(storePath);
    const restoredCall = restored.activeCalls.get("call-large");
    expect(restoredCall?.providerCallId).toBe(call.providerCallId);
    expect(restoredCall?.transcript).toEqual([]);
    expect(restoredCall?.metadata).toMatchObject({
      mode: "conversation",
      numberRouteKey: "+15550000001",
      voiceCallPersistence: { transcriptTruncated: true },
    });
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
  });

  it("prunes old snapshot chunks while retaining later in-process call updates", async () => {
    const env = { OPENCLAW_STATE_DIR: storePath };
    const seeded = makeCall({ callId: "call-seeded" });
    const bytes = Buffer.from(JSON.stringify(seeded));
    const eventRows = Array.from({ length: 1_000 }, (_, index) => ({
      key: `seed:${String(index).padStart(4, "0")}`,
      createdAt: index + 1,
      value: { chunkCount: index === 0 ? 2 : 1, byteLength: bytes.length },
    }));
    importPluginStateEntriesForDoctorForTests(
      "voice-call",
      { namespace: CALL_RECORD_EVENTS_NAMESPACE, maxEntries: 1_100, env },
      eventRows,
    );
    importPluginStateEntriesForDoctorForTests(
      "voice-call",
      {
        namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
        maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
        env,
      },
      eventRows.flatMap((row) => {
        const chunks =
          row.value.chunkCount === 2 ? [bytes.subarray(0, 1), bytes.subarray(1)] : [bytes];
        return chunks.map((chunk, index) => ({
          key: `${row.key}:chunk:${String(index).padStart(4, "0")}`,
          createdAt: row.createdAt,
          value: { index, dataBase64: chunk.toString("base64") },
        }));
      }),
    );
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const first = makeCall({ callId: "call-current", state: "ringing" });
    await persistCallRecord(storePath, first);
    await expect(findCallInStore(storePath, first.callId)).resolves.toEqual(first);
    const latest = { ...first, state: "answered" as const };
    await persistCallRecord(storePath, latest);
    await expect(getCallHistoryFromStore(storePath, 2)).resolves.toEqual([first, latest]);
    await expect(findCallInStore(storePath, first.callId)).resolves.toEqual(latest);

    const state = createVoiceCallStateRuntimeForTests();
    const events = state.openKeyedStoreV2({
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: 1_100,
      env,
    });
    const chunks = state.openKeyedStoreV2({
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    });
    await expect(events.count()).resolves.toBe(1_000);
    await expect(chunks.count()).resolves.toBe(1_000);
    await expect(chunks.lookup("seed:0000:chunk:0000")).resolves.toBeUndefined();
    await expect(chunks.lookup("seed:0000:chunk:0001")).resolves.toBeUndefined();
    await expect(chunks.lookup("seed:0001:chunk:0000")).resolves.toBeUndefined();
  });

  it("captures call bytes and write order before a delayed chunk publishes", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
    const blocked = createDeferred<void>();
    const release = createDeferred<void>();
    let delayed = false;
    installStateRuntime({
      beforeOperation: async (namespace, operation) => {
        if (
          !delayed &&
          namespace === CALL_RECORD_EVENT_CHUNKS_NAMESPACE &&
          operation === "register"
        ) {
          delayed = true;
          blocked.resolve();
          await release.promise;
        }
      },
    });
    const first = makeCall({
      callId: "call-delayed",
      state: "ringing",
      transcript: transcript("🦞".repeat(30_000)),
    });
    const expectedFirst = structuredClone(first);
    const pending = persistCallRecord(storePath, first);
    try {
      await blocked.promise;
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
      expectDefined(first.transcript[0], "first transcript entry").text =
        "mutated after persistence started";
      first.state = "answered";
      await persistCallRecord(storePath, first);
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([first]);
    } finally {
      release.resolve();
      await pending;
    }
    resetPluginStateStoreForTests();
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([expectedFirst, first]);
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.get(first.callId)?.state).toBe(
      "answered",
    );
  });

  it.each([CALL_RECORD_EVENT_CHUNKS_NAMESPACE, CALL_RECORD_EVENTS_NAMESPACE])(
    "does not publish a call after a rejected %s write",
    async (failedNamespace) => {
      const failure = new Error("delayed SQLite write rejected");
      installStateRuntime({
        beforeOperation: async (namespace, operation, key) => {
          await Promise.resolve();
          if (
            operation === "register" &&
            namespace === failedNamespace &&
            (namespace === CALL_RECORD_EVENTS_NAMESPACE || key?.endsWith(":chunk:0001"))
          ) {
            throw failure;
          }
        },
      });
      const call = makeCall({
        transcript: transcript("🦞".repeat(30_000)),
      });
      await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
      installStateRuntime();
      resetPluginStateStoreForTests();
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
      await expect(findCallInStore(storePath, call.callId)).resolves.toBeUndefined();
    },
  );

  it("propagates pruning rejection and preserves restore versus status read errors", async () => {
    const call = makeCall({ callId: "call-read-error" });
    const failure = new Error("delayed SQLite read rejected");
    installStateRuntime({
      beforeOperation: async (_namespace, operation) => {
        await Promise.resolve();
        if (operation === "entries" || operation === "count") {
          throw failure;
        }
      },
    });
    await expect(persistCallRecord(storePath, call)).rejects.toBe(failure);
    await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([]);
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
    await expect(findCallInStore(storePath, call.callId)).rejects.toBe(failure);
    installStateRuntime();
    resetPluginStateStoreForTests();
    await expect(findCallInStore(storePath, call.callId)).resolves.toEqual(call);
  });

  it("persists and restores only the newest per-call replay keys", async () => {
    const replayKeys = Array.from(
      { length: MAX_CALL_REPLAY_KEYS + 2 },
      (_, index) => `evt-${index}`,
    );
    const call = makeCall({
      callId: "call-bounded-replay",
      processedEventIds: replayKeys,
    });

    await persistCallRecord(storePath, call);

    const restored = await loadActiveCallsFromStore(storePath);
    const expected = replayKeys.slice(-MAX_CALL_REPLAY_KEYS);
    expect(restored.activeCalls.get("call-bounded-replay")?.processedEventIds).toEqual(expected);
    expect([...restored.processedEventIds]).toEqual(expected);
  });

  it("hydrates manager replay keys in latest-snapshot call order", async () => {
    await saveCall({
      callId: "call-latest",
      providerCallId: "provider-latest",
      processedEventIds: ["evt-latest-old"],
    });
    for (
      let callIndex = 0;
      callIndex < MANAGER_REPLAY_KEY_LIMIT / MAX_CALL_REPLAY_KEYS;
      callIndex++
    ) {
      await saveCall({
        callId: `call-fill-${callIndex}`,
        providerCallId: `provider-fill-${callIndex}`,
        processedEventIds: Array.from(
          { length: MAX_CALL_REPLAY_KEYS },
          (_, eventIndex) => `evt-fill-${callIndex}-${eventIndex}`,
        ),
      });
    }
    await saveCall({
      callId: "call-latest",
      providerCallId: "provider-latest",
      processedEventIds: ["evt-latest-old", "evt-latest-new"],
    });

    const restored = await loadActiveCallsFromStore(storePath);

    expect(restored.processedEventIds.size).toBe(MANAGER_REPLAY_KEY_LIMIT);
    expect(restored.processedEventIds.has("evt-latest-old")).toBe(true);
    expect(restored.processedEventIds.has("evt-latest-new")).toBe(true);
    expect(restored.processedEventIds.has("evt-fill-0-0")).toBe(false);
    expect(restored.processedEventIds.has("evt-fill-0-1")).toBe(false);
  });

  it("finds retained snapshots outside recent history and preserves internal-id precedence", async () => {
    await saveCall({ callId: "call-target", providerCallId: "provider-target" });
    await saveCall({
      callId: "call-target",
      providerCallId: "provider-target",
      state: "completed",
    });
    for (let index = 0; index < 101; index += 1) {
      await saveCall({
        callId: `noise-${index}`,
        providerCallId: index === 100 ? "call-target" : `provider-noise-${index}`,
      });
    }
    expect(await getCallHistoryFromStore(storePath, 100)).toHaveLength(100);
    expect(await findCallInStore(storePath, "call-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
    expect(await findCallInStore(storePath, "provider-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
  });
});
