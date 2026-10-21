import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStableChannelIngressPolicy } from "../channels/message-access/runtime.js";
import * as kysely from "../infra/kysely-sync.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { writeChannelPairingStateSnapshot } from "./pairing-store-sqlite.test-helpers.js";
import { readChannelAllowFromStore, readChannelAllowFromStoreSync } from "./pairing-store.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
let root: string;
let env: NodeJS.ProcessEnv;

function writeAllowlist(channel: string, allowFrom: Record<string, string[]>) {
  writeChannelPairingStateSnapshot(channel, { version: 1, requests: [], allowFrom }, env);
}

function resolveIngress(accountId: string) {
  return resolveStableChannelIngressPolicy({
    channelId: "demo",
    accountId,
    subject: { stableId: "first" },
    conversation: { kind: "direct", id: "first" },
    dmPolicy: "pairing",
    useDefaultPairingStore: true,
  });
}

beforeAll(() => {
  root = directories.make("openclaw-pairallow-worker-");
  env = { ...process.env, OPENCLAW_STATE_DIR: root };
  writeAllowlist("demo", { alpha: ["second", "first"], beta: ["other"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reads pairing allowlists through ingress and plugin runtime without caller-thread SQL", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const sql = vi.spyOn(kysely, "executeSqliteQuerySync");
  const ingress = await resolveIngress("alpha");
  expect(ingress.senderAccess).toMatchObject({
    allowed: true,
    effectiveAllowFrom: ["second", "first"],
  });
  expect(sql).not.toHaveBeenCalled();
  await expect(
    createRuntimeChannel().pairing.readAllowFromStore({
      channel: " DeMo ",
      accountId: " Beta ",
      env,
    }),
  ).resolves.toEqual(["other"]);
  expect(sql).not.toHaveBeenCalled();
});

it("returns no permission without creating a missing store and still validates keys", async () => {
  const missing = path.join(root, "missing");
  const missingEnv = { ...env, OPENCLAW_STATE_DIR: missing };
  await expect(readChannelAllowFromStore("demo", missingEnv)).resolves.toEqual([]);
  expect(fs.existsSync(missing)).toBe(false);
  await expect(readChannelAllowFromStore("", missingEnv)).rejects.toThrow(
    "invalid pairing channel",
  );
});

it.each(["__proto__", "constructor"])(
  "preserves the native refusal for inherited account key %s",
  async (accountId) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    expect(() => readChannelAllowFromStoreSync("demo", env, accountId)).toThrow(TypeError);
    await expect(readChannelAllowFromStore("demo", env, accountId)).rejects.toBeInstanceOf(
      TypeError,
    );
    const ingress = await resolveIngress(accountId);
    expect(ingress.senderAccess).toMatchObject({ allowed: false, effectiveAllowFrom: [] });
    expect(ingress.ingress.admission).not.toBe("dispatch");
    const missing = path.join(root, `missing-${accountId}`);
    await expect(
      readChannelAllowFromStore("demo", { ...env, OPENCLAW_STATE_DIR: missing }, accountId),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fs.existsSync(missing)).toBe(false);
  },
);

it("captures the original store before yielding and preserves normalized persisted account ordering", async () => {
  writeAllowlist("legacy", { alpha: ["last", "first"] });
  openOpenClawStateDatabase({ env }).db.exec(
    "UPDATE channel_pairing_allow_entries SET account_id = ' Alpha ' WHERE channel_key = 'legacy'",
  );
  const capturedEnv = { ...env };
  const result = readChannelAllowFromStore("legacy", capturedEnv, " ALPHA ");
  capturedEnv.OPENCLAW_STATE_DIR = path.join(root, "replacement");
  await expect(result).resolves.toEqual(["last", "first"]);
  expect(readChannelAllowFromStoreSync("legacy", env, " ALPHA ")).toEqual(["last", "first"]);
  expect(fs.existsSync(capturedEnv.OPENCLAW_STATE_DIR)).toBe(false);
});

it("reads current approval rows instead of an inherited discovery snapshot", async () => {
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      writeAllowlist("snapshot", { alpha: ["new-approval"] });
      await expect(readChannelAllowFromStore("snapshot", env, "alpha")).resolves.toEqual([
        "new-approval",
      ]);
    },
    { env },
  );
});
