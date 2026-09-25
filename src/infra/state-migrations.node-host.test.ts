// Covers fail-closed Doctor import of the retired node-host JSON config.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadNodeHostConfig,
  NODE_HOST_CONFIG_KEY,
  type NodeHostConfig,
} from "../node-host/config.js";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as durability from "./directory-durability.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  detectLegacyNodeHostConfig,
  migrateLegacyNodeHostConfig,
} from "./state-migrations.node-host.js";
import * as receipts from "./state-migrations.receipts.js";

type NodeHostConfigDatabase = Pick<OpenClawStateKyselyDatabase, "config_machine_state">;
const fixtureDigest = ["fixture", "digest"].join("-");

describe("legacy node-host Doctor migration", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function useStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
    const stateDir = tempDirs.make("openclaw-node-host-migration-");
    return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir }, stateDir };
  }

  function legacyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      nodeId: "legacy-node-id",
      token: "test-token-placeholder",
      displayName: "Legacy Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
      ...overrides,
    };
  }

  async function writeLegacy(
    stateDir: string,
    value: unknown = legacyConfig(),
  ): Promise<{ mtimeMs: number; sourcePath: string }> {
    const sourcePath = path.join(stateDir, "node.json");
    await fsp.writeFile(sourcePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return { sourcePath, mtimeMs: Math.floor((await fsp.stat(sourcePath)).mtimeMs) };
  }

  function seedCanonical(params: {
    env: NodeJS.ProcessEnv;
    nodeId?: string;
    displayName?: string;
    gatewayHost?: string;
    updatedAtMs: number;
  }): void {
    const database = openOpenClawStateDatabase({ env: params.env });
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<NodeHostConfigDatabase>(database.db)
        .insertInto("config_machine_state")
        .values({
          state_key: NODE_HOST_CONFIG_KEY,
          value_json: JSON.stringify({
            version: 1,
            nodeId: params.nodeId ?? "legacy-node-id",
            displayName: params.displayName ?? "Legacy Node",
            gateway: {
              host: params.gatewayHost ?? "gateway.example",
              port: 18443,
              tls: false,
              tlsFingerprint: fixtureDigest,
              contextPath: "/openclaw-gw",
            },
            installedAppsSharing: false,
          } satisfies NodeHostConfig),
          updated_at_ms: params.updatedAtMs,
        }),
    );
  }

  function readCanonicalRow(env: NodeJS.ProcessEnv) {
    return readConfigMachineStateWithMetadata<NodeHostConfig>(NODE_HOST_CONFIG_KEY, { env });
  }

  it("refuses a raw-byte change that preserves the pending decoded-text hash", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const original = await fsp.readFile(sourcePath);
    const offset = original.indexOf("test-token-placeholder");
    expect(offset).toBeGreaterThanOrEqual(0);
    original[offset] = 0xff;
    await fsp.writeFile(sourcePath, original);
    const run = (removeSource?: () => void) =>
      migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
        removeSource,
      });
    expect(
      (
        await run(() => {
          throw new Error("held pending source");
        })
      ).warnings.join("\n"),
    ).toContain("held pending source");
    const changed = Buffer.from(original);
    changed[offset] = 0xfe;
    expect(changed.toString("utf8")).toBe(original.toString("utf8"));
    await fsp.writeFile(sourcePath + ".doctor-importing", changed);
    expect((await run()).warnings.join("\n")).toContain(
      "differs from its prior SQLite migration receipt",
    );
    expect(await fsp.readFile(sourcePath)).toEqual(changed);
    expect(
      receipts.readLegacyMigrationReceipt(
        receipts.resolveLegacyMigrationSourceKey("node-host-json", sourcePath),
        env,
      )?.removedSource,
    ).toBe(false);
  });

  it("warns about unbound private material beside an original node-host source", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(stateDir);
    const stage = path.join(stateDir, ".doctor-source-copy-11111111-1111-4111-8111-111111111111");
    await fsp.mkdir(stage, { mode: 0o700 });
    await fsp.writeFile(path.join(stage, "payload"), "unbound test bytes", { mode: 0o600 });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(result.warnings.join("\n")).toContain("Preserved unbound node-host private copy");
    expect(await fsp.readFile(path.join(stage, "payload"), "utf8")).toBe("unbound test bytes");
  });

  it("finalizes a pending receipt after every source artifact was already removed", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath, mtimeMs } = await writeLegacy(stateDir);
    const migrate = () =>
      migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    const key = receipts.resolveLegacyMigrationSourceKey("node-host-json", sourcePath);
    const mark = vi
      .spyOn(receipts, "markLegacyMigrationSourceRemoved")
      .mockImplementationOnce(() => {
        throw new Error("receipt completion interrupted");
      });
    expect((await migrate()).warnings.join("\n")).toContain("receipt completion interrupted");
    mark.mockRestore();
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(receipts.readLegacyMigrationReceipt(key, env)?.removedSource).toBe(false);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
    expect((await migrate()).warnings).toEqual([]);
    expect(receipts.readLegacyMigrationReceipt(key, env)?.removedSource).toBe(true);
    await writeLegacy(stateDir, legacyConfig({ displayName: "Newer Legacy Node" }));
    const newer = new Date(mtimeMs + 1000);
    await fsp.utimes(sourcePath, newer, newer);
    expect((await migrate()).warnings).toEqual([]);
    expect(readCanonicalRow(env)?.value.displayName).toBe("Newer Legacy Node");
  });

  it("recovers a private node-host copy after the original-delete sync failure without replaying config", async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "off");
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const encoded = await fsp.readFile(sourcePath);
    const tokenOffset = encoded.indexOf("test-token-placeholder");
    if (tokenOffset < 0) {
      throw new Error("expected synthetic legacy token marker");
    }
    encoded[tokenOffset] = 0xff;
    await fsp.writeFile(sourcePath, encoded);
    const original = await fsp.readFile(sourcePath);
    seedCanonical({ env, displayName: "Newer Canonical Node", updatedAtMs: Date.now() + 60_000 });
    const link = vi
      .spyOn(fsp, "link")
      .mockRejectedValue(
        Object.assign(new Error("link denied"), { code: "EPERM", syscall: "link" }),
      );
    const originalSync = durability.requireDirectorySync;
    const failedSync = vi
      .spyOn(durability, "requireDirectorySync")
      .mockImplementation((outcome, label) => {
        if (label === "Legacy migration source directory" && !fs.existsSync(sourcePath)) {
          throw new Error("post-delete sync failed");
        }
        originalSync(outcome, label);
      });
    const migrate = () =>
      migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    expect((await migrate()).warnings.join("\n")).toContain("post-delete sync failed");
    failedSync.mockRestore();
    link.mockRestore();
    const copy = fs.readdirSync(stateDir).find((name) => name.startsWith(".doctor-source-copy-"));
    expect(copy).toBeDefined();
    const payload = path.join(stateDir, copy!, "payload");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(await fsp.readFile(payload)).toEqual(original);
    const canonical = readCanonicalRow(env);
    expect(canonical?.value.displayName).toBe("Newer Canonical Node");
    const db = openOpenClawStateDatabase({ env }).db;
    const stored = db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
      .get(NODE_HOST_CONFIG_KEY) as { value_json: string };

    const changedEncoding = Buffer.from(original);
    changedEncoding[tokenOffset] = 0xfe;
    expect(changedEncoding.toString("utf8")).toEqual(original.toString("utf8"));
    await fsp.writeFile(payload, changedEncoding);
    expect((await migrate()).warnings.join("\n")).toContain("migration receipt");
    expect(fs.existsSync(payload)).toBe(true);
    await fsp.writeFile(payload, original);
    await fsp.writeFile(payload, "different bytes");
    expect((await migrate()).warnings.join("\n")).toContain("differs from its migration receipt");
    expect(fs.existsSync(payload)).toBe(true);
    await fsp.writeFile(payload, original);
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
      JSON.stringify({ ...JSON.parse(stored.value_json), displayName: "newer" }),
      NODE_HOST_CONFIG_KEY,
    );
    expect((await migrate()).warnings.join("\n")).toContain(
      "canonical node-host state no longer matches",
    );
    expect(fs.existsSync(payload)).toBe(true);
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
      stored.value_json,
      NODE_HOST_CONFIG_KEY,
    );
    db.prepare("UPDATE migration_sources SET source_sha256 = ? WHERE migration_kind = ?").run(
      "0".repeat(64),
      "legacy-node-host-json",
    );
    expect((await migrate()).warnings.join("\n")).toContain("differs from its migration receipt");
    db.prepare("UPDATE migration_sources SET source_sha256 = ? WHERE migration_kind = ?").run(
      createHash("sha256").update(original.toString("utf8")).digest("hex"),
      "legacy-node-host-json",
    );
    db.prepare(
      "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
    ).run(
      JSON.stringify({ ...JSON.parse(stored.value_json), displayName: "Runtime Updated Node" }),
      (canonical?.updatedAtMs ?? 0) + 1,
      NODE_HOST_CONFIG_KEY,
    );
    const otherNode = { ...JSON.parse(stored.value_json), nodeId: "different-node-id" };
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
      JSON.stringify(otherNode),
      NODE_HOST_CONFIG_KEY,
    );
    expect((await migrate()).warnings.join("\n")).toContain(
      "canonical node-host state no longer matches",
    );
    expect(fs.existsSync(payload)).toBe(true);
    db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?").run(
      JSON.stringify({ ...JSON.parse(stored.value_json), displayName: "Runtime Updated Node" }),
      NODE_HOST_CONFIG_KEY,
    );
    const newerCanonical = readCanonicalRow(env);
    expect((await migrate()).warnings).toEqual([]);
    expect(fs.existsSync(payload)).toBe(false);
    expect(readCanonicalRow(env)).toEqual(newerCanonical);
    expect((await migrate()).changes).toEqual([]);
    const unknown = path.join(stateDir, ".doctor-source-copy-11111111-1111-4111-8111-111111111111");
    await fsp.mkdir(unknown, { mode: 0o700 });
    await fsp.writeFile(path.join(unknown, "payload"), "unknown private bytes", { mode: 0o600 });
    expect((await migrate()).warnings.join("\n")).toContain(
      "Preserved unbound node-host private copy",
    );
    expect(fs.existsSync(unknown)).toBe(true);
  });

  it("merges newer recreated node-host state after completed retirement", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(stateDir);
    const migrate = () =>
      migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    expect((await migrate()).warnings).toEqual([]);
    const nextTimestamp = readCanonicalRow(env)!.updatedAtMs + 1_000;
    const { sourcePath } = await writeLegacy(
      stateDir,
      legacyConfig({ displayName: "Newer Legacy Node" }),
    );
    await fsp.utimes(sourcePath, new Date(nextTimestamp), new Date(nextTimestamp));
    expect((await migrate()).warnings).toEqual([]);
    expect(readCanonicalRow(env)?.value.displayName).toBe("Newer Legacy Node");
    expect(fs.existsSync(sourcePath)).toBe(false);
    openOpenClawStateDatabase({ env })
      .db.prepare("DELETE FROM config_machine_state WHERE state_key = ?")
      .run(NODE_HOST_CONFIG_KEY);
    await writeLegacy(stateDir, legacyConfig({ displayName: "Restored Node" }));
    expect((await migrate()).warnings).toEqual([]);
    expect(readCanonicalRow(env)?.value.displayName).toBe("Restored Node");
  });

  it("preserves a changed claim while its previous import is still pending cleanup", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const run = (removeSource?: () => void) =>
      migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
        removeSource,
      });
    expect(
      (
        await run(() => {
          throw new Error("unlink refused");
        })
      ).warnings.join("\n"),
    ).toContain("unlink refused");
    const canonical = readCanonicalRow(env);
    expect(canonical).not.toBeNull();
    const db = openOpenClawStateDatabase({ env }).db;
    const replaceCanonical = (value: NodeHostConfig) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<NodeHostConfigDatabase>(db)
          .updateTable("config_machine_state")
          .set({ value_json: JSON.stringify(value) })
          .where("state_key", "=", NODE_HOST_CONFIG_KEY),
      );
    replaceCanonical({ ...canonical!.value, nodeId: "different-canonical-node" });
    expect((await run()).warnings.join("\n")).toContain("nodeId conflicts");
    expect(
      receipts.readLegacyMigrationReceipt(
        receipts.resolveLegacyMigrationSourceKey("node-host-json", sourcePath),
        env,
      )?.removedSource,
    ).toBe(false);
    replaceCanonical(canonical!.value);
    const claim = sourcePath + ".doctor-importing";
    const pendingPath = fs.existsSync(sourcePath) ? sourcePath : claim;
    await fsp.writeFile(
      pendingPath,
      JSON.stringify(legacyConfig({ displayName: "Changed Pending Input" })),
    );
    expect((await run()).warnings.join("\n")).toContain(
      "differs from its prior SQLite migration receipt",
    );
    expect(readCanonicalRow(env)).toEqual(canonical);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("detects source and interrupted claim only for explicit Doctor repair", async () => {
    const { stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    expect(detectLegacyNodeHostConfig({ stateDir }).hasLegacy).toBe(false);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);

    await fsp.rename(sourcePath, `${sourcePath}.doctor-importing`);
    expect(
      detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy,
    ).toBe(true);
  });

  it("imports the complete snapshot, discards token, and removes node.json", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(loadNodeHostConfig(env)).resolves.toEqual({
      version: 1,
      nodeId: "legacy-node-id",
      displayName: "Legacy Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: false,
        tlsFingerprint: fixtureDigest,
        contextPath: "/openclaw-gw",
      },
      installedAppsSharing: false,
    });
    expect(readCanonicalRow(env)?.value).not.toHaveProperty("token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("normalizes a legacy empty gateway context path to unset", async () => {
    const { env, stateDir } = useStateDir();
    await writeLegacy(
      stateDir,
      legacyConfig({
        gateway: {
          host: "gateway.example",
          port: 18443,
          tls: false,
          tlsFingerprint: fixtureDigest,
          contextPath: "",
        },
      }),
    );

    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect((await loadNodeHostConfig(env))?.gateway?.contextPath).toBeUndefined();
  });

  it("requires exclusive state ownership", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const gatewayLock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 10,
      port: 18_789,
      timeoutMs: 100,
    });
    if (!gatewayLock) {
      throw new Error("expected test Gateway lock");
    }
    let blocked: Awaited<ReturnType<typeof migrateLegacyNodeHostConfig>>;
    try {
      blocked = await migrateLegacyNodeHostConfig({
        detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(blocked.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it.each([
    [
      "unknown top-level field",
      legacyConfig({ unknown: true }),
      "legacy node-host config has unexpected field unknown",
    ],
    [
      "empty top-level field",
      legacyConfig({ "": 1, later: 2 }),
      'legacy node-host config has unexpected field ""',
    ],
    ["invalid version", legacyConfig({ version: 2 }), "legacy node-host config version must be 1"],
    [
      "blank node id",
      legacyConfig({ nodeId: " " }),
      "legacy node-host nodeId must be a non-empty string",
    ],
    [
      "unknown gateway field",
      legacyConfig({ gateway: { host: "gateway.example", unknown: true } }),
      "legacy node-host gateway has unexpected field unknown",
    ],
    [
      "__proto__ gateway field",
      legacyConfig({ gateway: { ["__proto__"]: 1, later: 2 } }),
      "legacy node-host gateway has unexpected field __proto__",
    ],
    [
      "invalid token",
      legacyConfig({ token: 42 }),
      "legacy node-host token must be a string when present",
    ],
  ])("rejects strict legacy shape: %s", async (_label, value, message) => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir, value);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings[0]).toBe(`Failed reading legacy node-host state: Error: ${message}`);
    expect(readCanonicalRow(env)).toBeUndefined();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("keeps a newer canonical snapshot with the same node id", async () => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Newer Canonical",
      gatewayHost: "newer.example",
      updatedAtMs: mtimeMs + 1_000,
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain("Kept newer canonical node-host SQLite state.");
    expect(readCanonicalRow(env)).toMatchObject({
      value: {
        displayName: "Newer Canonical",
        gateway: { host: "newer.example" },
      },
    });
    expect(readCanonicalRow(env)?.value).not.toHaveProperty("token");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("replaces an older canonical snapshot from the newer file", async () => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      displayName: "Older Canonical",
      gatewayHost: "older.example",
      updatedAtMs: mtimeMs - 1,
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(readCanonicalRow(env)).toMatchObject({
      value: {
        displayName: "Legacy Node",
        gateway: { host: "gateway.example" },
      },
      updatedAtMs: mtimeMs,
    });
  });

  it.each([
    ["different node id", { nodeId: "different-node", equalTimestamp: false }, "nodeId conflicts"],
    [
      "equal timestamp divergence",
      { nodeId: "legacy-node-id", equalTimestamp: true },
      "diverges at the same timestamp",
    ],
  ])("restores source on conflict: %s", async (_label, setup, message) => {
    const { env, stateDir } = useStateDir();
    const { mtimeMs, sourcePath } = await writeLegacy(stateDir);
    seedCanonical({
      env,
      nodeId: setup.nodeId,
      displayName: "Divergent",
      updatedAtMs: setup.equalTimestamp ? mtimeMs : mtimeMs + 1,
    });
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });

    expect(result.warnings[0]).toContain(message);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("fails before mutation when the source changes after parsing or before claim", async () => {
    const first = useStateDir();
    const firstLegacy = await writeLegacy(first.stateDir);
    const afterParse = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: first.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: first.env,
      stateDir: first.stateDir,
      beforeVerify: () => fs.appendFileSync(firstLegacy.sourcePath, "\n"),
    });
    expect(afterParse.warnings[0]).toContain("source changed after Doctor loaded it");
    expect(readCanonicalRow(first.env)).toBeUndefined();

    const second = useStateDir();
    const secondLegacy = await writeLegacy(second.stateDir);
    const beforeClaim = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: second.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: second.env,
      stateDir: second.stateDir,
      beforeClaim: () => fs.appendFileSync(secondLegacy.sourcePath, "\n"),
    });
    expect(beforeClaim.warnings[0]).toContain("source changed before Doctor could claim it");
    expect(readCanonicalRow(second.env)).toBeUndefined();
    expect(fs.existsSync(secondLegacy.sourcePath)).toBe(true);
  });

  it("retains a fixed claim on cleanup failure and retries idempotently", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const first = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(true);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");

    const retry = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
    expect(readCanonicalRow(env)?.value.nodeId).toBe("legacy-node-id");
  });

  it("refuses symlinked, hardlinked, and oversized sources", async () => {
    const symlinkCase = useStateDir();
    const outside = path.join(symlinkCase.stateDir, "outside.json");
    await fsp.writeFile(outside, JSON.stringify(legacyConfig()), "utf8");
    const symlinkPath = path.join(symlinkCase.stateDir, "node.json");
    await fsp.symlink(outside, symlinkPath);
    const symlinkResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: symlinkCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: symlinkCase.env,
      stateDir: symlinkCase.stateDir,
    });
    expect(symlinkResult.warnings[0]).toContain("Failed reading legacy node-host state");

    const hardlinkCase = useStateDir();
    const hardlinkOutside = path.join(hardlinkCase.stateDir, "outside.json");
    await fsp.writeFile(hardlinkOutside, JSON.stringify(legacyConfig()), "utf8");
    const hardlinkPath = path.join(hardlinkCase.stateDir, "node.json");
    await fsp.link(hardlinkOutside, hardlinkPath);
    const hardlinkResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: hardlinkCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: hardlinkCase.env,
      stateDir: hardlinkCase.stateDir,
    });
    expect(hardlinkResult.warnings[0]).toContain("Failed reading legacy node-host state");

    const oversizedCase = useStateDir();
    await fsp.writeFile(path.join(oversizedCase.stateDir, "node.json"), "x".repeat(65 * 1024));
    const oversizedResult = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({
        stateDir: oversizedCase.stateDir,
        doctorOnlyStateMigrations: true,
      }),
      env: oversizedCase.env,
      stateDir: oversizedCase.stateDir,
    });
    expect(oversizedResult.warnings[0]).toContain("Failed reading legacy node-host state");
  });

  it("fails cleanup when an old writer recreates node.json", async () => {
    const { env, stateDir } = useStateDir();
    const { sourcePath } = await writeLegacy(stateDir);
    const result = await migrateLegacyNodeHostConfig({
      detected: detectLegacyNodeHostConfig({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
      removeSource: async (claimPath) => {
        await fsp.rm(claimPath);
        await fsp.writeFile(sourcePath, JSON.stringify(legacyConfig()), "utf8");
      },
    });

    expect(result.warnings[0]).toContain("source or Doctor claim remains after cleanup");
    expect(fs.existsSync(sourcePath)).toBe(true);
    await expect(loadNodeHostConfig(env)).rejects.toThrow("openclaw doctor --fix");
  });
});
