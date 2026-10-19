import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateKeyedStoreV2ForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCompatibilityConfig, stateMigrations } from "./doctor-contract-api.js";
import { base64url, generateIdentity, type ReviewRequest } from "./protocol/index.js";
import { MemoryAuditStore } from "./protocol/memory-stores.test-support.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import {
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  reefReplayStoreKey,
  type ReefReplayRecord,
} from "./src/replay-store.js";
import {
  generateAndStoreKeys,
  loadKeys,
  openStores,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_NAMESPACE,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_MAX_ENTRIES,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  reefAuditEntryKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
  type ReefIdentityBinding,
  type ReefIdentityMigrationRecord,
  type ReefReviewRecord,
} from "./src/state.js";
import { expectReefStateOperationError } from "./src/state.test-support.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

function createDoctorContext(
  env: NodeJS.ProcessEnv,
  refusedNamespace?: string,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: options.env ?? env,
      });
      return options.namespace === refusedNamespace
        ? { ...store, registerIfAbsent: async () => false }
        : store;
    },
  };
}

function migrationById(name: string) {
  const id = `reef-${name}-to-plugin-state`;
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

function createRuntime(env: NodeJS.ProcessEnv) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: options.env ?? env,
    });
  runtime.state.openKeyedStore = <T>(options: OpenAsyncKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("reef", {
      ...options,
      env: options.env ?? env,
    });
  runtime.state.openKeyedStoreV2 = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) =>
    createPluginStateKeyedStoreV2ForTests<T>(
      "reef",
      { ...options, env: options.env ?? env },
      authority ?? { assertCurrent() {} },
    );
  return runtime;
}

function reefKeys(): ReefKeys {
  return {
    ...generateIdentity(),
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

function reviewRequest(id = "review-id"): ReviewRequest {
  return {
    id,
    from: "alice#1",
    to: "bob#1",
    direction: "outbound",
    bodyHash: "b".repeat(64),
    approvalDigest: "c".repeat(64),
    verdict: {
      decision: "review",
      category: "ambiguous",
      reason: "Owner review.",
      model: "test-model",
      policyVersion: "v1",
    },
  };
}

const jsonLines = (entries: readonly unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const incompleteMigration =
  "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix";
const identityBinding = { handle: "molty", relayUrl: "https://reefwire.ai" };
const pendingIdentity = { pending: true, identityBindingRequired: true };
const unchanged = { changes: [], warnings: [] };

function legacyConfig(): OpenClawConfig {
  const identity = generateIdentity();
  return {
    channels: {
      reef: {
        enabled: true,
        handle: "owner",
        relayUrl: "https://reefwire.ai",
        requestPolicy: "code-only",
        dmPolicy: "pairing",
        allowFrom: ["peer"],
        friends: {
          peer: {
            autonomy: "extended",
            ed25519PublicKey: identity.signing.publicKey,
            x25519PublicKey: identity.encryption.publicKey,
            keyEpoch: 2,
            safetyNumberChanged: false,
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("Reef doctor contract", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;
  let context: PluginDoctorStateMigrationContext;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-doctor-"));
    vi.spyOn(os, "homedir").mockReturnValue(stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = createDoctorContext(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function migrationParams(config: OpenClawConfig = {}, migrationContext = context) {
    return {
      config,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: migrationContext,
    };
  }

  function migrate(name: string, params = migrationParams()) {
    return migrationById(name).migrateLegacyState(params);
  }

  function expectBlocked(
    operation: "load" | "generate" | "audit",
    message: string | RegExp = /migration is incomplete/,
  ) {
    const runtime = createRuntime(env);
    const result =
      operation === "load"
        ? loadKeys(runtime)
        : operation === "generate"
          ? generateAndStoreKeys(runtime)
          : openStores(runtime, reefKeys());
    return expectReefStateOperationError(result, message);
  }

  function openStore<T>(namespace: string, maxEntries: number, defaultTtlMs?: number) {
    return context.openPluginStateKeyedStore<T>({
      namespace,
      maxEntries,
      overflowPolicy: "reject-new",
      ...(defaultTtlMs === undefined ? {} : { defaultTtlMs }),
    });
  }

  function identityMigrationStore() {
    return openStore<ReefIdentityMigrationRecord>(
      REEF_KEYS_MIGRATION_NAMESPACE,
      REEF_KEYS_MIGRATION_MAX_ENTRIES,
    );
  }

  function writeLegacy(filename: string, value: unknown, raw = false) {
    const filePath = path.join(createLegacyDir(), filename);
    fs.writeFileSync(filePath, raw ? String(value) : JSON.stringify(value));
    return filePath;
  }

  async function auditFixture() {
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("one", { id: 1 }, 10);
    await audit.appendEvent("two", { id: 2 }, 11);
    const entries = await audit.entries();
    const source = jsonLines(entries);
    return { entries, source, filePath: writeLegacy("audit.jsonl", source, true) };
  }

  function isolatedIdentity() {
    const homeDir = path.join(stateDir, "home");
    const isolatedStateDir = path.join(stateDir, "isolated");
    const legacyDir = path.join(homeDir, ".openclaw", "data", "reef");
    const homeKeysPath = path.join(legacyDir, "keys.json");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    fs.writeFileSync(homeKeysPath, JSON.stringify(keys));
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    const isolatedEnv = { ...env, OPENCLAW_STATE_DIR: isolatedStateDir };
    context = createDoctorContext(isolatedEnv);
    return {
      keys,
      homeKeysPath,
      legacyDir,
      params: {
        config: {},
        env: isolatedEnv,
        stateDir: isolatedStateDir,
        oauthDir: path.join(isolatedStateDir, "oauth"),
        context,
      },
    };
  }

  function createLegacyDir() {
    const dir = path.join(stateDir, ".openclaw", "data", "reef");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("keeps channels.reef authoritative over conflicting stray entry config", () => {
    const cfg = {
      channels: { reef: { handle: "canonical" } },
      plugins: { entries: { reef: { config: { handle: "stray", email: "o@example.com" } } } },
    } as never;

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Moved plugins.entries.reef.config.email to channels.reef.email.",
      "Removed plugins.entries.reef.config.handle; channels.reef.handle is authoritative.",
    ]);
    expect(result.config.channels?.reef).toEqual({ handle: "canonical", email: "o@example.com" });
    expect(result.config.plugins?.entries?.reef).toEqual({});
  });

  it("does not import the default home's Reef identity into an isolated state", async () => {
    const { homeKeysPath, params } = isolatedIdentity();
    const migration = migrationById("keys-json");

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    expect(fs.existsSync(homeKeysPath)).toBe(true);
  });

  it("imports an explicitly configured default-home Reef identity into isolated state", async () => {
    const { keys, homeKeysPath, legacyDir, params: isolatedParams } = isolatedIdentity();
    const migration = migrationById("keys-json");
    const params = { ...isolatedParams, config: { channels: { reef: { stateDir: legacyDir } } } };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef identity keys -> plugin state (identity)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(
      openStore<ReefKeys>(REEF_KEYS_NAMESPACE, REEF_KEYS_MAX_ENTRIES).lookup(REEF_KEYS_KEY),
    ).resolves.toEqual(keys);
    expect(fs.existsSync(homeKeysPath)).toBe(false);
    expect(fs.existsSync(`${homeKeysPath}.migrated`)).toBe(true);
  });

  it("retains refused identity imports and keeps runtime blocked", async () => {
    const source = JSON.stringify(reefKeys());
    const filePath = writeLegacy("keys.json", source, true);
    const result = await migrate(
      "keys-json",
      migrationParams({}, createDoctorContext(env, REEF_KEYS_NAMESPACE)),
    );

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Reef identity keys"),
    ]);
    expect(fs.readFileSync(filePath, "utf8")).toBe(source);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
    await expectBlocked("load");
  });

  it("blocks identity regeneration after a failed keys.json import", async () => {
    const filePath = writeLegacy("keys.json", "{broken", true);
    const migration = migrationById("keys-json");
    const params = migrationParams();

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Reef identity keys"),
    ]);
    fs.rmSync(filePath);
    const missingSourceResult = await migration.migrateLegacyState(params);
    expect(missingSourceResult.warnings).toEqual([
      expect.stringContaining("migration is incomplete and keys.json is missing"),
    ]);
    await expectBlocked("generate");
  });

  it("keeps legacy identity keys blocked until their handle binding is canonical", async () => {
    const keys = reefKeys();
    writeLegacy("keys.json", keys);
    writeLegacy("identity.json", identityBinding);
    const keysResult = await migrate("keys-json");

    expect(keysResult.warnings).toEqual([]);
    const migrationStore = identityMigrationStore();
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual(pendingIdentity);
    await expectBlocked("load", incompleteMigration);

    const registrationResult = await migrate("registration-json");

    expect(registrationResult.warnings).toEqual([]);
    expect(registrationResult.changes).toContain(
      "Verified Reef identity keys and binding; cleared migration marker",
    );
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toBeUndefined();
    await expectBlocked("load", incompleteMigration);
    await migrate("runtime-files");
    await expect(loadKeys(createRuntime(env))).resolves.toEqual(keys);
  });

  it("binds wizard-created legacy keys when unrelated Reef config is invalid", async () => {
    writeLegacy("keys.json", reefKeys());
    const params = migrationParams({
      channels: {
        reef: {
          handle: "molty",
          relayUrl: "https://reefwire.ai/",
          email: "not-an-email",
        },
      },
    });

    await expect(migrationById("registration-json").detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef configured identity binding -> plugin state"],
    });

    await migrate("keys-json", params);
    const migrationStore = identityMigrationStore();
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual(pendingIdentity);

    const registrationResult = await migrate("registration-json", params);

    expect(registrationResult.warnings).toEqual([]);
    expect(registrationResult.changes).toContain(
      "Migrated Reef identity binding from config -> plugin state",
    );
    const registrationStore = openStore<ReefIdentityBinding>(
      REEF_REGISTRATION_NAMESPACE,
      REEF_REGISTRATION_MAX_ENTRIES,
    );
    await expect(registrationStore.lookup(REEF_REGISTRATION_IDENTITY_KEY)).resolves.toEqual(
      identityBinding,
    );
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toBeUndefined();
  });

  it("keeps identity migration blocked when config conflicts with the imported binding", async () => {
    writeLegacy("keys.json", reefKeys());
    writeLegacy("identity.json", { handle: "canonical", relayUrl: "https://reefwire.ai" });
    const params = migrationParams({
      channels: {
        reef: { handle: "conflict", relayUrl: "https://reefwire.ai" },
      },
    });

    await migrate("keys-json", params);
    const result = await migrate("registration-json", params);

    expect(result.warnings).toEqual([
      expect.stringContaining("configured handle or relay differs"),
      expect.stringContaining("identity migration is incomplete"),
    ]);
    const migrationStore = identityMigrationStore();
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual(pendingIdentity);
  });

  it.each(["file", "config"])(
    "keeps identity binding migration blocked after a refused %s import",
    async (sourceKind) => {
      writeLegacy("keys.json", reefKeys());
      const identityPath = path.join(createLegacyDir(), "identity.json");
      if (sourceKind === "file") {
        fs.writeFileSync(identityPath, JSON.stringify(identityBinding));
      }
      const config = sourceKind === "config" ? { channels: { reef: identityBinding } } : {};
      await migrate("keys-json", migrationParams(config));

      const result = await migrate(
        "registration-json",
        migrationParams(config, createDoctorContext(env, REEF_REGISTRATION_NAMESPACE)),
      );

      expect(result.changes).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Failed importing Reef identity"),
      );
      if (sourceKind === "file") {
        expect(fs.readFileSync(identityPath, "utf8")).toBe(JSON.stringify(identityBinding));
        expect(fs.existsSync(`${identityPath}.migrated`)).toBe(false);
      }
      await expectBlocked("load");
    },
  );

  it.each([REEF_AUDIT_NAMESPACE, REEF_AUDIT_HEAD_NAMESPACE])(
    "retains the audit source after a refused %s insert and resumes safely",
    async (refusedNamespace) => {
      const { filePath, entries, source } = await auditFixture();
      const migration = migrationById("audit-jsonl");

      const failed = await migration.migrateLegacyState(
        migrationParams({}, createDoctorContext(env, refusedNamespace)),
      );

      expect(failed.changes).toEqual([]);
      expect(failed.warnings).toEqual([
        expect.stringContaining("Failed importing Reef audit trail"),
      ]);
      expect(fs.readFileSync(filePath, "utf8")).toBe(source);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
      await expectBlocked("audit");

      const recovered = await migration.migrateLegacyState(migrationParams());
      expect(recovered.warnings).toEqual([]);
      expect(fs.readFileSync(`${filePath}.migrated`, "utf8")).toBe(source);
      await migrate("runtime-files");
      const stores = await openStores(createRuntime(env), reefKeys());
      await expect(stores.audit.entries()).resolves.toEqual(entries);
    },
  );

  it("imports and verifies the append-only audit chain", async () => {
    const { filePath, entries } = await auditFixture();
    const result = await migrate("audit-jsonl");

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 2 Reef audit entries -> plugin state",
      expect.stringContaining("Archived Reef audit trail legacy source"),
    ]);
    const store = openStore<ReefAuditStateRecord>(
      REEF_AUDIT_NAMESPACE,
      REEF_AUDIT_STORE_MAX_ENTRIES,
    );
    const headStore = openStore<ReefAuditHeadRecord>(
      REEF_AUDIT_HEAD_NAMESPACE,
      REEF_AUDIT_HEAD_MAX_ENTRIES,
    );
    await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toEqual({
      kind: "head",
      hash: entries[1]!.entryHash,
      seq: 2,
      oldestHash: entries[0]!.entryHash,
    });
    await expect(store.lookup(reefAuditEntryKey(entries[0]!.entryHash))).resolves.toEqual({
      kind: "entry",
      entry: entries[0],
      nextHash: entries[1]!.entryHash,
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("finishes an interrupted migration of an empty audit trail", async () => {
    const filePath = writeLegacy("audit.jsonl", "", true);
    const migration = migrationById("audit-jsonl");
    const params = migrationParams();

    const imported = await migration.migrateLegacyState(params);
    expect(imported.warnings).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);

    const migrationStore = openStore<{
      pending: true;
      expectedEntries: number;
    }>(REEF_AUDIT_MIGRATION_NAMESPACE, REEF_AUDIT_MIGRATION_MAX_ENTRIES);
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, {
      pending: true,
      expectedEntries: 0,
    });

    const recovered = await migration.migrateLegacyState(params);

    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes).toContain(
      "Verified Reef audit trail; cleared completed migration marker",
    );
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
  });

  it("blocks runtime audit writes until a failed legacy import is repaired", async () => {
    const filePath = writeLegacy("audit.jsonl", "{broken\n", true);
    const migration = migrationById("audit-jsonl");
    const params = migrationParams();

    const failed = await migration.migrateLegacyState(params);

    expect(failed.warnings).toEqual([expect.stringContaining("Failed importing Reef audit trail")]);
    const migrationStore = openStore<{ pending: true }>(
      REEF_AUDIT_MIGRATION_NAMESPACE,
      REEF_AUDIT_MIGRATION_MAX_ENTRIES,
    );
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
    });
    await expectBlocked("audit", incompleteMigration);

    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("repaired", { id: 1 }, 10);
    const entries = await audit.entries();
    fs.writeFileSync(filePath, jsonLines(entries));

    const repaired = await migration.migrateLegacyState(params);

    expect(repaired.warnings).toEqual([]);
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
    await migrate("runtime-files", params);
    await expect(openStores(createRuntime(env), reefKeys())).resolves.toBeDefined();
  });

  it("imports registration and durable runtime state before archiving files", async () => {
    const legacyDir = createLegacyDir();
    writeLegacy("identity.json", identityBinding);
    writeLegacy("setup-session.json", {
      session: "setup-secret",
      relayUrl: "https://reefwire.ai",
      email: "molty@example.com",
    });
    const replayId = "01JZ0000000000000000000000";
    const secondReplayId = "01JZ0000000000000000000001";
    writeLegacy(
      "replay.jsonl",
      jsonLines([
        { op: "claim", peer: "alice", id: replayId, envelopeHash: "a".repeat(64) },
        { op: "consume", peer: "alice", id: replayId },
        { op: "claim", peer: "bob", id: secondReplayId, envelopeHash: "d".repeat(64) },
      ]),
      true,
    );
    const review = reviewRequest(replayId);
    writeLegacy("reviews.json", { [review.approvalDigest]: { review, approved: true } });
    writeLegacy("delivered.json", [replayId]);
    const partiallyImportedReplay = openStore<ReefReplayRecord>(
      REEF_REPLAY_NAMESPACE,
      REEF_REPLAY_MAX_ENTRIES,
      REEF_REPLAY_TTL_MS,
    );
    await partiallyImportedReplay.register(reefReplayStoreKey("alice", replayId), {
      peer: "alice",
      id: replayId,
      envelopeHash: "a".repeat(64),
      state: "consumed",
    });

    const registration = await migrate("registration-json");
    const runtimeState = await migrate("runtime-files");
    await expectBlocked("generate", /has no stored keys/);

    expect(registration.warnings).toEqual([]);
    expect(registration.changes).toHaveLength(4);
    expect(runtimeState.warnings).toEqual([]);
    expect(runtimeState.changes).toHaveLength(7);
    for (const filename of [
      "identity.json",
      "setup-session.json",
      "replay.jsonl",
      "reviews.json",
      "delivered.json",
    ]) {
      expect(fs.existsSync(path.join(legacyDir, filename))).toBe(false);
      expect(fs.existsSync(path.join(legacyDir, `${filename}.migrated`))).toBe(true);
    }
    const replayStore = openStore<ReefReplayRecord>(
      REEF_REPLAY_NAMESPACE,
      REEF_REPLAY_MAX_ENTRIES,
      REEF_REPLAY_TTL_MS,
    );
    await expect(replayStore.lookup(reefReplayStoreKey("alice", replayId))).resolves.toMatchObject({
      state: "consumed",
      envelopeHash: "a".repeat(64),
    });
    await expect(
      replayStore.lookup(reefReplayStoreKey("bob", secondReplayId)),
    ).resolves.toMatchObject({
      state: "available",
      envelopeHash: "d".repeat(64),
    });
    const reviewStore = openStore<ReefReviewRecord>(
      REEF_REVIEWS_NAMESPACE,
      REEF_REVIEWS_MAX_ENTRIES,
    );
    await expect(reviewStore.lookup(review.approvalDigest)).resolves.toEqual({
      review,
      approved: true,
    });
    const deliveredStore = openStore<{ id: string }>(
      REEF_DELIVERED_NAMESPACE,
      REEF_DELIVERED_MAX_ENTRIES,
      REEF_DELIVERED_TTL_MS,
    );
    await expect(deliveredStore.lookup(replayId)).resolves.toEqual({ id: replayId });
  });

  it.each([
    ["replay.jsonl", REEF_REPLAY_NAMESPACE, "Reef replay state"],
    ["reviews.json", REEF_REVIEWS_NAMESPACE, "Reef reviews"],
    ["delivered.json", REEF_DELIVERED_NAMESPACE, "Reef delivered markers"],
  ])("retains %s after a refused runtime insert", async (filename, namespace, label) => {
    const legacyDir = createLegacyDir();
    const review = reviewRequest();
    const sources = {
      "replay.jsonl": `${JSON.stringify({ op: "claim", peer: "alice", id: "replay-id", envelopeHash: "a".repeat(64) })}\n`,
      "reviews.json": JSON.stringify({ [review.approvalDigest]: { review } }),
      "delivered.json": JSON.stringify(["delivered-id"]),
    };
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(legacyDir, name), source);
    }

    const result = await migrate(
      "runtime-files",
      migrationParams({}, createDoctorContext(env, namespace)),
    );

    expect(result.warnings).toContainEqual(expect.stringContaining(`Failed importing ${label}`));
    expect(result.warnings).toContainEqual(
      expect.stringContaining("left migration blocker in place"),
    );
    for (const [name, source] of Object.entries(sources)) {
      const filePath = path.join(legacyDir, name);
      expect(fs.readFileSync(name === filename ? filePath : `${filePath}.migrated`, "utf8")).toBe(
        source,
      );
      expect(fs.existsSync(name === filename ? `${filePath}.migrated` : filePath)).toBe(false);
    }
    await expectBlocked("load");
  });

  it("leaves oversized replay and delivered sources blocked and unarchived", async () => {
    const legacyDir = createLegacyDir();
    const replayPath = path.join(legacyDir, "replay.jsonl");
    const deliveredPath = path.join(legacyDir, "delivered.json");
    const replayIds = Array.from(
      { length: REEF_REPLAY_MAX_ENTRIES + 1 },
      (_, index) => `replay-${index}`,
    );
    fs.writeFileSync(
      replayPath,
      `${replayIds
        .map((id) => JSON.stringify({ op: "claim", peer: "alice", id, envelopeHash: id }))
        .join("\n")}\n`,
    );
    fs.writeFileSync(
      deliveredPath,
      JSON.stringify(
        Array.from({ length: REEF_DELIVERED_MAX_ENTRIES + 1 }, (_, index) => `delivered-${index}`),
      ),
    );
    const result = await migrate("runtime-files");

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `${REEF_REPLAY_MAX_ENTRIES + 1} replay bindings exceed plugin-state capacity`,
      ),
      expect.stringContaining(
        `${REEF_DELIVERED_MAX_ENTRIES + 1} delivered markers exceed plugin-state capacity`,
      ),
      expect.stringContaining("Reef durable state migration is incomplete"),
    ]);
    for (const filePath of [replayPath, deliveredPath]) {
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
    }
  });

  it("imports config-backed trust into scoped plugin state without overwriting canonical rows", async () => {
    const cfg = legacyConfig();
    const migration = migrationById("config-trust");
    const params = migrationParams(cfg);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 0 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: [],
    });

    const canonical = ReefChannelConfigSchema.parse({
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
    });
    const store = openStore<{
      revision: number;
      trust: { autonomy: string; approvedAt: number };
    }>(REEF_TRUST_STORE_NAMESPACE, REEF_TRUST_STORE_MAX_ENTRIES);
    const peerKey = resolveReefTrustStoreKey(canonical, "peer");
    await expect(store.lookup(peerKey)).resolves.toMatchObject({
      revision: 1,
      trust: { autonomy: "extended", approvedAt: 0 },
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    await store.delete(peerKey);
    await expect(migration.migrateLegacyState(params)).resolves.toEqual(unchanged);
    await expect(store.lookup(peerKey)).resolves.toBeUndefined();
  });

  it("migrates valid rows but retains the legacy map when another row is invalid", async () => {
    const cfg = legacyConfig();
    const reef = cfg.channels?.reef as Record<string, unknown>;
    reef.friends = {
      ...(reef.friends as Record<string, unknown>),
      broken: { autonomy: "extended" },
    };
    const migration = migrationById("config-trust");
    const params = migrationParams(cfg);

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 1 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: ["Skipped 1 invalid Reef peer trust row(s); left legacy friends config in place"],
    });

    const normalized = normalizeCompatibilityConfig({ cfg });
    expect(normalized.config.channels?.reef).toHaveProperty("friends.broken");
    expect(normalized.config.channels?.reef).not.toHaveProperty("dmPolicy");
    expect(normalized.config.channels?.reef).not.toHaveProperty("allowFrom");
  });

  it("does not partially migrate when the trust namespace is full", async () => {
    const cfg = legacyConfig();
    const registerIfAbsent = vi.fn();
    const fullContext = {
      openPluginStateKeyedStore() {
        return {
          entries: async () =>
            Array.from({ length: REEF_TRUST_STORE_MAX_ENTRIES }, (_, index) => ({
              key: `existing-${index}`,
              value: {},
              createdAt: 0,
            })),
          registerIfAbsent,
        } as never;
      },
    } as PluginDoctorStateMigrationContext;

    await expect(migrate("config-trust", migrationParams(cfg, fullContext))).resolves.toEqual({
      changes: [],
      warnings: [
        "Skipped Reef peer trust migration because plugin state has room for 0 of 1 trust row(s) and 0 of 1 import marker(s); left legacy friends config in place",
      ],
    });
    expect(registerIfAbsent).not.toHaveBeenCalled();
  });
});
