// Covers fail-closed Doctor import of the retired Web Push JSON stores.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import * as durability from "./directory-durability.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  createWebPushVapidKeyPair,
  hashWebPushEndpoint,
  listWebPushSubscriptions,
  readPersistedVapidKeyPair,
  DEFAULT_WEB_PUSH_VAPID_SUBJECT,
  type VapidKeyPair,
  type WebPushSubscription,
} from "./push-web-store.js";
import {
  webPushSubscriptionToRow,
  WEB_PUSH_VAPID_STATE_KEY,
  type WebPushDatabase,
} from "./push-web-store.records.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import * as receipts from "./state-migrations.receipts.js";
import { detectLegacyWebPush, migrateLegacyWebPush } from "./state-migrations.web-push.js";

describe("legacy Web Push Doctor migration", () => {
  let envSnapshot: ReturnType<typeof captureEnv> | undefined;
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      __setFsSafeTestHooksForTest(undefined);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      envSnapshot?.restore();
      envSnapshot = undefined;
      cleanup();
    });
  });

  function useStateDir(): string {
    const stateDir = tempDirs.make("openclaw-web-push-migration-");
    envSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_VAPID_SUBJECT"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    return stateDir;
  }

  function subscription(overrides: Partial<WebPushSubscription> = {}): WebPushSubscription {
    return {
      subscriptionId: "c0a80101-0000-4000-8000-000000000001",
      endpoint: "https://push.example.com/send/legacy",
      keys: { p256dh: "legacy-p256dh", auth: "legacy-auth" },
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      ...overrides,
    };
  }

  function vapidKeys(overrides: Partial<VapidKeyPair> = {}): VapidKeyPair {
    return {
      ...createWebPushVapidKeyPair(
        "legacy-public-key",
        "legacy-private-key",
        "https://openclaw.ai",
      ),
      ...overrides,
    };
  }

  function withUnexpectedJsonFields<T extends object>(value: T) {
    return { "": 1, later: 2, ...value };
  }

  function subscriptionStore(value: unknown) {
    const endpoint = subscription().endpoint;
    return { subscriptionsByEndpointHash: { [hashWebPushEndpoint(endpoint)]: value } };
  }

  async function writeLegacyState(params: {
    stateDir: string;
    subscriptions?: unknown;
    vapid?: unknown;
  }): Promise<{ subscriptionsPath?: string; vapidKeysPath?: string }> {
    const pushDir = path.join(params.stateDir, "push");
    await fsp.mkdir(pushDir, { recursive: true });
    const result: { subscriptionsPath?: string; vapidKeysPath?: string } = {};
    if (params.subscriptions !== undefined) {
      result.subscriptionsPath = path.join(pushDir, "web-push-subscriptions.json");
      const subscriptionsByEndpointHash = Array.isArray(params.subscriptions)
        ? Object.fromEntries(
            (params.subscriptions as readonly WebPushSubscription[]).map((entry) => [
              hashWebPushEndpoint(entry.endpoint),
              entry,
            ]),
          )
        : params.subscriptions;
      await fsp.writeFile(
        result.subscriptionsPath,
        JSON.stringify({ subscriptionsByEndpointHash }, null, 2),
        "utf8",
      );
    }
    if (params.vapid !== undefined) {
      result.vapidKeysPath = path.join(pushDir, "vapid-keys.json");
      await fsp.writeFile(result.vapidKeysPath, JSON.stringify(params.vapid, null, 2), "utf8");
    }
    return result;
  }

  function seedSubscription(endpointHash: string, value: WebPushSubscription): void {
    const database = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<WebPushDatabase>(database.db)
        .insertInto("web_push_subscriptions")
        .values(webPushSubscriptionToRow({ endpointHash, subscription: value })),
    );
  }

  function seedVapid(value: VapidKeyPair): void {
    writeConfigMachineState(WEB_PUSH_VAPID_STATE_KEY, value);
  }

  it("finalizes an artifact-free pending receipt before accepting a newer source generation", async () => {
    const stateDir = useStateDir();
    const migrate = () =>
      migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });
    const key = receipts.resolveLegacyMigrationSourceKey(
      "legacy-web-push-json",
      subscriptionsPath!,
    );
    const mark = vi
      .spyOn(receipts, "markLegacyMigrationSourceRemoved")
      .mockImplementationOnce(() => {
        throw new Error("receipt completion interrupted");
      });
    expect((await migrate()).warnings.join("\n")).toContain("receipt completion interrupted");
    mark.mockRestore();
    expect(fs.existsSync(subscriptionsPath!)).toBe(false);
    expect(receipts.readLegacyMigrationReceipt(key, process.env)?.removedSource).toBe(false);
    await fsp.rmdir(path.dirname(subscriptionsPath!));
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);
    expect((await migrate()).warnings).toEqual([]);
    expect(receipts.readLegacyMigrationReceipt(key, process.env)?.removedSource).toBe(true);
    expect(fs.existsSync(path.dirname(subscriptionsPath!))).toBe(false);
    const newer = subscription({
      updatedAtMs: 3000,
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
    });
    await writeLegacyState({ stateDir, subscriptions: [newer] });
    expect((await migrate()).warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([newer]);
  });

  it("still imports a newer recreated legacy subscription after completed retirement", async () => {
    const stateDir = useStateDir();
    const migrate = () =>
      migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });
    await writeLegacyState({ stateDir, subscriptions: [subscription()] });
    expect((await migrate()).warnings).toEqual([]);
    const updated = subscription({
      updatedAtMs: 3_000,
      keys: { p256dh: "new-key", auth: "new-auth" },
    });
    const paths = await writeLegacyState({ stateDir, subscriptions: [updated] });
    expect((await migrate()).warnings).toEqual([]);
    expect(await listWebPushSubscriptions()).toContainEqual(updated);
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(false);
  });

  it("finishes receipt-covered cleanup when a copied original could not be removed", async () => {
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "off");
    const stateDir = useStateDir();
    const { vapidKeysPath } = await writeLegacyState({ stateDir, vapid: vapidKeys() });
    const link = vi
      .spyOn(fsp, "link")
      .mockRejectedValue(
        Object.assign(new Error("link denied"), { code: "EPERM", syscall: "link" }),
      );
    const migrate = (removeSource?: () => void) =>
      migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
        removeSource,
      });
    expect(
      (
        await migrate(() => {
          throw new Error("unlink refused");
        })
      ).warnings.join("\n"),
    ).toContain("unlink refused");
    expect(fs.existsSync(vapidKeysPath!)).toBe(true);
    const canonical = await readPersistedVapidKeyPair();
    link.mockRestore();
    expect((await migrate()).warnings).toEqual([]);
    expect(await readPersistedVapidKeyPair()).toEqual(canonical);
    expect(fs.existsSync(vapidKeysPath!)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(stateDir, "push"))
        .some((name) => name.startsWith(".doctor-source-copy-")),
    ).toBe(false);
  });

  it("does not adopt an APNs private copy from the shared push directory", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({ stateDir, vapid: vapidKeys() });
    const otherSource = Buffer.from("apns-registrations.json").toString("base64url");
    const otherStage = path.join(
      stateDir,
      "push",
      ".doctor-source-copy-00000000-0000-4000-8000-000000000001-" + otherSource,
    );
    await fsp.mkdir(otherStage, { mode: 0o700 });
    const otherPayload = path.join(otherStage, "payload");
    await fsp.writeFile(otherPayload, "synthetic-other-owner-bytes", { mode: 0o600 });
    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(false);
    expect(await fsp.readFile(otherPayload, "utf8")).toBe("synthetic-other-owner-bytes");
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(
      false,
    );
  });

  it.each(["subscriptions", "vapid"] as const)(
    "recovers committed %s secrets from a private copy after post-delete sync failure",
    async (kind) => {
      vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
      vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", "off");
      const stateDir = useStateDir();
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const paths = await writeLegacyState({
        stateDir,
        ...(kind === "subscriptions"
          ? { subscriptions: [subscription()] }
          : { vapid: vapidKeys() }),
      });
      const sourcePath = (
        kind === "subscriptions" ? paths.subscriptionsPath : paths.vapidKeysPath
      )!;
      const original = await fsp.readFile(sourcePath);
      const link = vi
        .spyOn(fsp, "link")
        .mockRejectedValue(
          Object.assign(new Error("link denied"), { code: "EPERM", syscall: "link" }),
        );
      const requireSync = durability.requireDirectorySync;
      const failedSync = vi
        .spyOn(durability, "requireDirectorySync")
        .mockImplementation((outcome, label) => {
          if (label === "Legacy migration source directory" && !fs.existsSync(sourcePath)) {
            throw new Error("post-delete parent sync failed");
          }
          requireSync(outcome, label);
        });
      const migrate = () =>
        migrateLegacyWebPush({
          detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
          env,
          stateDir,
        });

      const first = await migrate();
      expect(first.warnings.join("\n")).toContain("post-delete parent sync failed");
      const copies = fs
        .readdirSync(path.dirname(sourcePath))
        .filter((name) => name.startsWith(".doctor-source-copy-"));
      expect(copies).toHaveLength(1);
      const directory = path.join(path.dirname(sourcePath), copies[0]!);
      const payload = path.join(directory, "payload");
      expect(await fsp.readFile(payload)).toEqual(original);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(
        kind === "subscriptions"
          ? await listWebPushSubscriptions(stateDir)
          : await readPersistedVapidKeyPair(stateDir),
      ).toEqual(kind === "subscriptions" ? [subscription()] : vapidKeys());
      failedSync.mockRestore();
      link.mockRestore();
      closeOpenClawStateDatabaseForTest();

      await fsp.writeFile(payload, "changed recovery bytes");
      expect((await migrate()).warnings.join("\n")).toContain("differs from its migration receipt");
      expect(fs.existsSync(payload)).toBe(true);
      await fsp.writeFile(payload, original);
      if (kind === "vapid") {
        await fsp.writeFile(payload, Buffer.alloc(64 * 1024 + 1, 0x41));
        expect((await migrate()).warnings.join("\n")).toContain(
          "Preserved interrupted Web Push copy",
        );
        expect(fs.statSync(payload).size).toBe(64 * 1024 + 1);
        await fsp.writeFile(payload, original);
        seedVapid(vapidKeys({ privateKey: "changed-canonical" }));
        expect((await migrate()).warnings.join("\n")).toContain("canonical Web Push state changed");
        expect(fs.existsSync(payload)).toBe(true);
        seedVapid(vapidKeys());
      }

      const retry = await migrate();
      expect(retry.warnings).toEqual([]);
      expect(retry.changes).toContain(
        "Removed interrupted private Web Push copy covered by its SQLite receipt.",
      );
      expect(fs.existsSync(directory)).toBe(false);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(
        kind === "subscriptions"
          ? await listWebPushSubscriptions(stateDir)
          : await readPersistedVapidKeyPair(stateDir),
      ).toEqual(kind === "subscriptions" ? [subscription()] : vapidKeys());
      expect((await migrate()).changes).toEqual([]);
    },
  );

  it("preserves a changed receipt-covered claim at the destructive recovery boundary", async () => {
    const stateDir = useStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });
    const claimPath = subscriptionsPath + ".doctor-importing";
    const migrate = (removeSource?: (sourcePath: string) => void) =>
      migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
        env,
        removeSource,
      });
    const first = await migrate(() => {
      throw new Error("leave committed claim");
    });
    expect(first.warnings.join("\n")).toContain("legacy cleanup failed");
    expect(fs.existsSync(claimPath)).toBe(true);
    const canonical = await listWebPushSubscriptions(stateDir);
    const changed = "different validly owned retired source generation";
    let replaced = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation(operation, targetPath) {
        if (operation === "remove" && targetPath === claimPath && !replaced) {
          fs.writeFileSync(claimPath, changed);
          replaced = true;
        }
      },
    });

    const retry = await migrate();
    expect(replaced).toBe(true);
    expect(retry.warnings.join("\n")).toContain("source generation changed before cleanup");
    expect(fs.readFileSync(claimPath, "utf8")).toBe(changed);
    expect(await listWebPushSubscriptions(stateDir)).toEqual(canonical);
  });

  it("preserves an unbound old private copy without replaying the VAPID identity", async () => {
    const stateDir = useStateDir();
    const { vapidKeysPath } = await writeLegacyState({ stateDir, vapid: vapidKeys() });
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    expect(
      (
        await migrateLegacyWebPush({
          detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
          env,
        })
      ).warnings,
    ).toEqual([]);
    const canonical = await readPersistedVapidKeyPair(stateDir);
    const directory = path.join(
      path.dirname(vapidKeysPath!),
      ".doctor-source-copy-11111111-1111-4111-8111-111111111111",
    );
    await fsp.mkdir(directory, { mode: 0o700 });
    await fsp.writeFile(path.join(directory, "payload"), JSON.stringify(vapidKeys()));

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      env,
    });
    expect(retry.warnings.join("\n")).toContain("Preserved unbound Web Push private copy");
    expect(fs.existsSync(path.join(directory, "payload"))).toBe(true);
    expect(await readPersistedVapidKeyPair(stateDir)).toEqual(canonical);
  });

  it("detects original and interrupted-claim files only for explicit Doctor repair", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [],
    });
    expect(detectLegacyWebPush({ stateDir }).hasLegacy).toBe(false);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);

    await fsp.rename(subscriptionsPath!, `${subscriptionsPath}.doctor-importing`);
    expect(detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }).hasLegacy).toBe(true);
  });

  it("requires exclusive state ownership before reading or committing legacy state", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
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

    let blocked: Awaited<ReturnType<typeof migrateLegacyWebPush>>;
    try {
      blocked = await migrateLegacyWebPush({
        detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
        env,
        stateDir,
      });
    } finally {
      await gatewayLock.release();
    }

    expect(blocked.warnings[0]).toContain("Gateway or another SQLite maintenance command");
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      env,
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(false);
  });

  it("routes explicit Doctor repair through the Web Push SQLite importer", async () => {
    const stateDir = useStateDir();
    const cfg: OpenClawConfig = {
      agents: { entries: { "worker-1": { default: true } } },
      session: { mainKey: "desk" },
    };
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
    };
    const expectedSubscription = subscription();
    const expectedVapid = vapidKeys();
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [expectedSubscription],
      vapid: expectedVapid,
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => stateDir,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.webPush.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Web Push subscriptions and VAPID identity: legacy JSON → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      env,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toStrictEqual([expectedSubscription]);
    expect(await readPersistedVapidKeyPair(stateDir)).toStrictEqual(expectedVapid);
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(false);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(false);
  });

  it("imports subscriptions and VAPID identity in one verified operation", async () => {
    const stateDir = useStateDir();
    const first = subscription();
    const second = subscription({
      subscriptionId: "c0a80101-0000-4000-8000-000000000002",
      endpoint: "https://push.example.com/send/second",
    });
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [first, second],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([first, second]);
    expect(await readPersistedVapidKeyPair(stateDir)).toEqual(vapidKeys());
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(false);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(false);
  });

  it.each([
    ["missing legacy subject", undefined, undefined, DEFAULT_WEB_PUSH_VAPID_SUBJECT],
    ["empty legacy subject", "", undefined, DEFAULT_WEB_PUSH_VAPID_SUBJECT],
    ["blank injected subject", undefined, "   ", DEFAULT_WEB_PUSH_VAPID_SUBJECT],
    [
      "padded injected subject",
      undefined,
      "  mailto:injected@example.com  ",
      "mailto:injected@example.com",
    ],
    [
      "padded legacy subject",
      "  mailto:legacy@example.com  ",
      "mailto:injected@example.com",
      "mailto:legacy@example.com",
    ],
  ])("normalizes a %s", async (_label, legacySubject, injectedSubject, expectedSubject) => {
    const stateDir = useStateDir();
    setTestEnvValue("OPENCLAW_VAPID_SUBJECT", "mailto:ambient@example.com");
    const legacyKeys = vapidKeys({ subject: legacySubject ?? "" });
    if (legacySubject === undefined) {
      delete (legacyKeys as Partial<VapidKeyPair>).subject;
    }
    await writeLegacyState({ stateDir, vapid: legacyKeys });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: injectedSubject },
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect((await readPersistedVapidKeyPair(stateDir))?.subject).toBe(expectedSubject);
  });

  it("rejects a present non-string legacy VAPID subject", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({
      stateDir,
      vapid: { ...vapidKeys(), subject: 42 },
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      env: { ...process.env, OPENCLAW_VAPID_SUBJECT: "mailto:fallback@example.com" },
      stateDir,
    });

    expect(result.warnings[0]).toContain("VAPID keys are invalid");
    expect(await readPersistedVapidKeyPair(stateDir)).toBeNull();
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(true);
  });

  it.each([
    ["subscriptions store", false, withUnexpectedJsonFields({ subscriptionsByEndpointHash: {} })],
    ["subscription", false, subscriptionStore(withUnexpectedJsonFields(subscription()))],
    [
      "subscription keys",
      false,
      subscriptionStore({
        ...subscription(),
        keys: withUnexpectedJsonFields(subscription().keys),
      }),
    ],
    ["VAPID keys", true, withUnexpectedJsonFields(vapidKeys())],
  ])("rejects unexpected JSON fields before mutation: %s", async (label, isVapid, value) => {
    const stateDir = useStateDir();
    const pushDir = path.join(stateDir, "push");
    const sourcePath = path.join(
      pushDir,
      isVapid ? "vapid-keys.json" : "web-push-subscriptions.json",
    );
    await fsp.mkdir(pushDir, { recursive: true });
    await fsp.writeFile(sourcePath, JSON.stringify(value), "utf8");

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toBe(
      `Failed reading legacy Web Push state: Error: legacy Web Push ${label} has unexpected field ""`,
    );
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(await readPersistedVapidKeyPair(stateDir)).toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
  });

  it("removes an empty valid store only after opening SQLite", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({ stateDir, subscriptions: [] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);
    expect(fs.existsSync(subscriptionsPath!)).toBe(false);
  });

  it("rejects either malformed file without importing its valid pair", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: { publicKey: "incomplete" },
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("VAPID keys are invalid");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(await readPersistedVapidKeyPair(stateDir)).toBeNull();
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(true);
  });

  it("rejects a forged endpoint hash and duplicate subscription ids", async () => {
    const stateDir = useStateDir();
    const pushDir = path.join(stateDir, "push");
    await fsp.mkdir(pushDir, { recursive: true });
    const sourcePath = path.join(pushDir, "web-push-subscriptions.json");
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({ subscriptionsByEndpointHash: { forged: subscription() } }),
      "utf8",
    );
    let result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(result.warnings[0]).toContain("subscription is invalid");

    const first = subscription();
    const second = subscription({ endpoint: "https://push.example.com/send/second" });
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          [hashWebPushEndpoint(first.endpoint)]: first,
          [hashWebPushEndpoint(second.endpoint)]: second,
        },
      }),
      "utf8",
    );
    result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(result.warnings[0]).toContain("duplicate subscription id");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("keeps newer SQLite fields while preserving the earliest creation time", async () => {
    const stateDir = useStateDir();
    const legacy = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const canonical = subscription({
      keys: { p256dh: "canonical-p256dh", auth: "canonical-auth" },
      createdAtMs: 150,
      updatedAtMs: 300,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    await writeLegacyState({ stateDir, subscriptions: [legacy] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...canonical, createdAtMs: 100 }]);
  });

  it("updates an older SQLite row from newer legacy state", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ updatedAtMs: 200 });
    const legacy = subscription({
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
      createdAtMs: 500,
      updatedAtMs: 600,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    await writeLegacyState({ stateDir, subscriptions: [legacy] });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([legacy]);
  });

  it("retries a committed newer-row merge after normalizing its creation time", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ createdAtMs: 100, updatedAtMs: 200 });
    const legacy = subscription({
      keys: { p256dh: "newer-p256dh", auth: "newer-auth" },
      createdAtMs: 500,
      updatedAtMs: 600,
    });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [legacy],
    });

    const first = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([{ ...legacy, createdAtMs: 100 }]);
    expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
  });

  it("rolls back equal-timestamp divergence and VAPID identity conflicts", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ keys: { p256dh: "canonical", auth: "canonical" } });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    seedVapid(
      createWebPushVapidKeyPair("canonical-public", "canonical-private", "https://openclaw.ai"),
    );
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("diverges at the same timestamp");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect((await readPersistedVapidKeyPair(stateDir))?.publicKey).toBe("canonical-public");
    expect(fs.existsSync(paths.subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(paths.vapidKeysPath!)).toBe(true);
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(false);
  });

  it("rolls back subscription changes when only VAPID conflicts", async () => {
    const stateDir = useStateDir();
    seedVapid(
      createWebPushVapidKeyPair("canonical-public", "canonical-private", "https://openclaw.ai"),
    );
    await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("VAPID identity conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("rejects a subscription id already owned by another endpoint", async () => {
    const stateDir = useStateDir();
    const canonical = subscription({ endpoint: "https://push.example.com/canonical" });
    const legacy = subscription({ endpoint: "https://push.example.com/legacy" });
    seedSubscription(hashWebPushEndpoint(canonical.endpoint), canonical);
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [legacy],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("subscription id conflicts");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([canonical]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
  });

  it("fails before database mutation when a source changes after parsing", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      beforeVerify: () => fs.appendFileSync(subscriptionsPath!, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
  });

  it("restores claimed sources without database mutation when claim verification fails", async () => {
    const stateDir = useStateDir();
    const { subscriptionsPath } = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
    });

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      beforeClaim: () => fs.appendFileSync(subscriptionsPath!, "\n"),
    });

    expect(result.warnings[0]).toContain("source changed before doctor could claim it");
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
    expect(fs.existsSync(subscriptionsPath!)).toBe(true);
    expect(fs.existsSync(`${subscriptionsPath}.doctor-importing`)).toBe(false);
  });

  it("retains fixed claims on cleanup failure and retries idempotently", async () => {
    const stateDir = useStateDir();
    const paths = await writeLegacyState({
      stateDir,
      subscriptions: [subscription()],
      vapid: vapidKeys(),
    });
    const first = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
      removeSource: () => {
        throw new Error("simulated unlink failure");
      },
    });
    expect(first.warnings[0]).toContain("legacy cleanup failed");
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(true);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([subscription()]);

    const retry = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });
    expect(retry.warnings).toEqual([]);
    expect(fs.existsSync(`${paths.subscriptionsPath}.doctor-importing`)).toBe(false);
    expect(fs.existsSync(`${paths.vapidKeysPath}.doctor-importing`)).toBe(false);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([subscription()]);
  });

  it("refuses symlinked sources", async () => {
    const stateDir = useStateDir();
    const outside = path.join(stateDir, "outside.json");
    await fsp.writeFile(outside, JSON.stringify({ subscriptionsByEndpointHash: {} }), "utf8");
    const sourcePath = path.join(stateDir, "push", "web-push-subscriptions.json");
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.symlink(outside, sourcePath);

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });

  it("refuses a legacy store reached through a symlinked state-directory ancestor", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = useStateDir();
    const outside = tempDirs.make("openclaw-web-push-outside-");
    const legacy = subscription();
    const sourcePath = path.join(outside, "web-push-subscriptions.json");
    await fsp.writeFile(
      sourcePath,
      JSON.stringify({
        subscriptionsByEndpointHash: {
          [hashWebPushEndpoint(legacy.endpoint)]: legacy,
        },
      }),
      "utf8",
    );
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.symlink(outside, path.join(stateDir, "push"));

    const result = await migrateLegacyWebPush({
      detected: detectLegacyWebPush({ stateDir, doctorOnlyStateMigrations: true }),
      stateDir,
    });

    expect(result.warnings[0]).toContain("Failed reading legacy Web Push state");
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(await listWebPushSubscriptions(stateDir)).toEqual([]);
  });
});
