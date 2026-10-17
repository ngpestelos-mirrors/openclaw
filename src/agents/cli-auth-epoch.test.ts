/** Tests CLI auth epoch stability across token refreshes and identity changes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthProfileStoreFixture } from "./auth-profiles/credential-fixtures.test-support.js";
import { updateAuthProfileStoreWithLock } from "./auth-profiles/store-runtime.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
} from "./auth-profiles/types.js";
import {
  resolveCliAuthBindingFingerprint,
  resolveCliAuthEpoch,
  resolveCliRuntimeOwnerFingerprint,
} from "./cli-auth-epoch.js";
import {
  resetCliAuthEpochTestDeps,
  setCliAuthEpochTestDeps,
} from "./cli-auth-epoch.test-support.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { resolveCliExecutableIdentity } from "./cli-executable-identity.js";

function oauth<Provider extends string>(
  provider: Provider,
  overrides: Partial<Omit<OAuthCredential, "provider">> = {},
): OAuthCredential & { provider: Provider } {
  return {
    type: "oauth",
    access: "access-a",
    refresh: "refresh-a",
    expires: 1,
    ...overrides,
    provider,
  };
}

function profileEpoch(authProfileId: string) {
  return resolveCliAuthEpoch({ provider: "google-gemini-cli", authProfileId });
}

function useProfileStore(store: AuthProfileStore) {
  setCliAuthEpochTestDeps({
    readGeminiCliCredentialsCached: () => null,
    loadAuthProfileStoreForRuntime: () => store,
  });
}

function ownerFingerprint(
  config: OpenClawConfig,
  overrides: Partial<Parameters<typeof resolveCliRuntimeOwnerFingerprint>[0]> = {},
) {
  return resolveCliRuntimeOwnerFingerprint({
    provider: "claude-cli",
    config,
    agentId: "openclaw",
    ...overrides,
  });
}

const tempDirs: string[] = [];
function tempDir(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}

describe("resolveCliAuthEpoch", () => {
  afterEach(() => {
    resetCliAuthEpochTestDeps();
    cliBackendsTesting.resetDepsForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function expectCliAuthEpoch(
    epoch: Awaited<ReturnType<typeof resolveCliAuthEpoch>>,
    label = "auth epoch",
  ): asserts epoch is string {
    // Epochs are cache/session keys, so tests assert hash shape without caring
    // about the exact digest value.
    expect(typeof epoch, label).toBe("string");
    expect(epoch, label).toMatch(/^[a-f0-9]{64}$/);
  }

  it("returns undefined when no local or auth-profile credentials exist", async () => {
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () => null,
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => createAuthProfileStoreFixture({}),
    });

    await expect(
      resolveCliAuthEpoch({
        provider: "claude-cli",
        authProfileId: "anthropic:work",
      }),
    ).resolves.toBeUndefined();
    await expect(profileEpoch("google:work")).resolves.toBeUndefined();
  });

  it("loads auth-profile epochs from the selected agent directory", async () => {
    const stores: Record<string, AuthProfileStore> = {
      "/agents/work/agent": createAuthProfileStoreFixture({
        "google-gemini-cli:default": oauth("google-gemini-cli", {
          access: "work-access",
          refresh: "work-refresh",
          email: "work@example.test",
          projectId: "work-project",
        }),
      }),
      "/agents/personal/agent": createAuthProfileStoreFixture({
        "google-gemini-cli:default": oauth("google-gemini-cli", {
          access: "personal-access",
          refresh: "personal-refresh",
          email: "personal@example.test",
          projectId: "personal-project",
        }),
      }),
    };
    const loadAuthProfileStoreForRuntime = vi.fn((agentDir?: string) => {
      return stores[agentDir ?? ""] ?? { version: 1, profiles: {} };
    });
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime,
    });

    const work = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      agentDir: "/agents/work/agent",
      authProfileId: "google-gemini-cli:default",
      skipLocalCredential: true,
    });
    const personal = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      agentDir: "/agents/personal/agent",
      authProfileId: "google-gemini-cli:default",
      skipLocalCredential: true,
    });

    expectCliAuthEpoch(work);
    expectCliAuthEpoch(personal);
    expect(work).not.toBe(personal);
    expect(loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/agents/work/agent", {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    expect(loadAuthProfileStoreForRuntime).toHaveBeenCalledWith("/agents/personal/agent", {
      readOnly: true,
      allowKeychainPrompt: false,
    });
  });

  it("separates Gemini CLI OAuth profile epochs by profile id", async () => {
    let access = "access-a";
    let refresh = "refresh-a";
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "google-gemini-cli:primary": {
        type: "oauth",
        provider: "google-gemini-cli",
        access,
        refresh,
        expires: 1,
        email: "user@example.test",
        accountId: "google-account-1",
        projectId: "project-1",
      },
      "google-gemini-cli:renamed": {
        type: "oauth",
        provider: "google-gemini-cli",
        access,
        refresh,
        expires: 1,
        email: "user@example.test",
        accountId: "google-account-1",
        projectId: "project-1",
      },
    });
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () => null,
      loadAuthProfileStoreForRuntime: () => store,
    });

    const primary = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      agentDir: "/agents/main/agent",
      authProfileId: "google-gemini-cli:primary",
      skipLocalCredential: true,
    });
    access = "access-b";
    refresh = "refresh-b";
    store.profiles["google-gemini-cli:primary"] = {
      type: "oauth",
      provider: "google-gemini-cli",
      access,
      refresh,
      expires: 2,
      email: "user@example.test",
      accountId: "google-account-1",
      projectId: "project-1",
    };
    const primaryAfterRefresh = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      agentDir: "/agents/main/agent",
      authProfileId: "google-gemini-cli:primary",
      skipLocalCredential: true,
    });
    const renamed = await resolveCliAuthEpoch({
      provider: "google-gemini-cli",
      agentDir: "/agents/main/agent",
      authProfileId: "google-gemini-cli:renamed",
      skipLocalCredential: true,
    });

    expectCliAuthEpoch(primary);
    expect(primaryAfterRefresh).toBe(primary);
    expect(renamed).not.toBe(primary);
  });

  it("keeps strict CLI bindings stable for a known OAuth principal", async () => {
    let access = "access-a";
    let refresh = "refresh-a";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () =>
        oauth("codex-cli", {
          access,
          refresh,
          accountId: "account-1",
        }),
    });

    const first = await resolveCliAuthBindingFingerprint({ provider: "codex-cli", config: {} });
    access = "access-b";
    refresh = "refresh-b";
    const second = await resolveCliAuthBindingFingerprint({ provider: "codex-cli", config: {} });

    expect(second).toBe(first);
  });

  it("fingerprints the materialized value selected for a profile SecretRef", async () => {
    const profileId = "google-gemini-cli:work";
    const credential = {
      type: "api_key" as const,
      provider: "google-gemini-cli",
      keyRef: { source: "file" as const, provider: "vault", id: "/gemini/work" },
    };
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => createAuthProfileStoreFixture({ [profileId]: credential }),
    });
    const params = {
      provider: "google-gemini-cli",
      config: {},
      authProfileId: profileId,
      skipLocalCredential: true,
    };
    await expect(resolveCliAuthBindingFingerprint(params)).resolves.toBeUndefined();
    const first = await resolveCliAuthBindingFingerprint({
      ...params,
      resolvedAuth: {
        apiKey: "materialized-a",
        profileId,
        source: `profile:${profileId}`,
        mode: "api-key",
      },
    });
    const second = await resolveCliAuthBindingFingerprint({
      ...params,
      resolvedAuth: {
        apiKey: "materialized-b",
        profileId,
        source: `profile:${profileId}`,
        mode: "api-key",
      },
    });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("excludes unused ambient CLI auth from profile-owned bindings", async () => {
    let localAccess = "local-access-a";
    const profileStore: AuthProfileStore = createAuthProfileStoreFixture({
      "google-gemini-cli:work": oauth("google-gemini-cli", {
        access: "profile-access",
        refresh: "profile-refresh",
        accountId: "profile-account",
      }),
    });
    setCliAuthEpochTestDeps({
      readGeminiCliCredentialsCached: () =>
        oauth("google-gemini-cli", {
          access: localAccess,
          refresh: `refresh-${localAccess}`,
        }),
      ensureAuthProfileStore: () => profileStore,
    });

    const params = {
      provider: "google-gemini-cli",
      config: {},
      authProfileId: "google-gemini-cli:work",
      skipLocalCredential: true,
    };
    const first = await resolveCliAuthBindingFingerprint(params);
    localAccess = "local-access-b";
    const second = await resolveCliAuthBindingFingerprint(params);

    expect(second).toBe(first);
  });

  it("reads strict credential bindings off-thread and observes an in-process replacement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profileId = "fixture:binding";
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "fixture", key: "synthetic-first" },
        },
      });
      const params = {
        provider: "fixture",
        config: {},
        agentDir: state.agentDir(),
        authProfileId: profileId,
        skipLocalCredential: true,
      };
      const observation = observeHostDataSql();
      let first: string | undefined;
      try {
        first = await resolveCliAuthBindingFingerprint(params);
        expect(
          observation.queries.filter((sql) => /\bauth_profile_(?:store|state)\b/iu.test(sql)),
        ).toEqual([]);
      } finally {
        observation.restore();
      }
      expectCliAuthEpoch(first);
      const updated = await updateAuthProfileStoreWithLock({
        agentDir: state.agentDir(),
        saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
        updater(store) {
          store.profiles[profileId] = {
            type: "api_key",
            provider: "fixture",
            key: "synthetic-replacement",
          };
          return true;
        },
      });
      expect(updated).not.toBeNull();
      const second = await resolveCliAuthBindingFingerprint(params);
      expectCliAuthEpoch(second);
      expect(second).not.toBe(first);
    });
  });

  it("keeps identity-less oauth auth-profile epochs scoped to the profile id", async () => {
    const store: AuthProfileStore = createAuthProfileStoreFixture({
      "anthropic:work": oauth("anthropic", {}),
      "anthropic:personal": oauth("anthropic", {
        access: "access-b",
        refresh: "refresh-b",
        expires: 2,
      }),
    });
    useProfileStore(store);

    const first = await profileEpoch("anthropic:work");
    const second = await profileEpoch("anthropic:personal");

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it.each([
    {
      label: "keeps ref-backed token epochs stable on rotation",
      profileId: "anthropic:work",
      credential: {
        token: "token-a",
        displayName: "Work",
        email: "user@example.com",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
      },
      replacement: { token: "token-b" },
      changes: false,
    },
    {
      label: "changes token-only epochs on replacement",
      profileId: "anthropic:token-only",
      credential: { token: "token-a", displayName: "Manual token" },
      replacement: { token: "token-b" },
      changes: true,
    },
    {
      label: "changes token epochs when email identity changes",
      profileId: "anthropic:work",
      credential: { token: "token", displayName: "Work", email: "user-a@example.com" },
      replacement: { email: "user-b@example.com" },
      changes: true,
    },
  ] satisfies Array<{
    label: string;
    profileId: string;
    credential: Omit<Extract<AuthProfileCredential, { type: "token" }>, "type" | "provider">;
    replacement: Partial<Extract<AuthProfileCredential, { type: "token" }>>;
    changes: boolean;
  }>)("$label", async ({ profileId, credential: fields, replacement, changes }) => {
    const credential: Extract<AuthProfileCredential, { type: "token" }> = {
      type: "token",
      provider: "anthropic",
      ...fields,
    };
    useProfileStore(createAuthProfileStoreFixture({ [profileId]: credential }));
    const first = await profileEpoch(profileId);
    Object.assign(credential, replacement);
    const second = await profileEpoch(profileId);
    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    if (changes) {
      expect(second).not.toBe(first);
    } else {
      expect(second).toBe(first);
    }
  });

  it("mixes local codex and auth-profile state", async () => {
    let access = "local-access-a";
    let localRefresh = "local-refresh-a";
    let refresh = "profile-refresh-a";
    let accountId = "acct-1";
    let email = "user-a@example.com";
    setCliAuthEpochTestDeps({
      readCodexCliCredentialsCached: () =>
        oauth("openai", {
          access,
          refresh: localRefresh,
          accountId,
        }),
      loadAuthProfileStoreForRuntime: () =>
        createAuthProfileStoreFixture({
          "openai:work": oauth("openai", {
            access: "profile-access",
            refresh,
            email,
          }),
        }),
    });

    const resolve = () =>
      resolveCliAuthEpoch({
        provider: "codex-cli",
        authProfileId: "openai:work",
      });
    const first = await resolve();
    access = "local-access-b";
    const second = await resolve();
    localRefresh = "local-refresh-b";
    const third = await resolve();
    refresh = "profile-refresh-b";
    const fourth = await resolve();
    accountId = "acct-2";
    const fifth = await resolve();
    email = "user-b@example.com";
    const sixth = await resolve();

    expectCliAuthEpoch(first);
    expect(second).toBe(first);
    expect(third).toBe(second);
    expect(fourth).toBe(third);
    expectCliAuthEpoch(fifth);
    expectCliAuthEpoch(sixth);
    expect(fifth).not.toBe(fourth);
    expect(sixth).not.toBe(fifth);
  });

  function cliConfig(command: string): OpenClawConfig {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "anthropic",
          config: { command },
          runtimeArtifact: {
            kind: "bundled-package-tree",
            packageName: "@fixture/claude-cli",
            entrypoint: "command",
            nativeExecutableNames: ["claude", "claude.exe"],
          },
        },
      ],
    });
    return {};
  }

  function copyNativeExecutable(filePath: string, source = process.execPath): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.copyFileSync(source, filePath);
    fs.chmodSync(filePath, 0o755);
  }

  function nativeUtility(name: "true" | "false"): string {
    for (const candidate of [`/usr/bin/${name}`, `/bin/${name}`]) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return process.execPath;
  }

  it("attests an opaque CLI backend owner without reading credential material", async () => {
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    });

    const dir = tempDir("openclaw-cli-owner-native-");
    const executable = path.join(dir, "claude");
    copyNativeExecutable(executable);
    const config = cliConfig(executable);
    const fingerprint = await ownerFingerprint(config);

    expectCliAuthEpoch(fingerprint);
    await expect(
      ownerFingerprint(config, { runtimeOwnerId: "replacement-backend" }),
    ).resolves.toBeUndefined();
  });

  it("changes an opaque owner when PATH selects a different executable", async () => {
    const dir = tempDir("openclaw-cli-owner-path-");
    const firstBin = path.join(dir, "first");
    const secondBin = path.join(dir, "second");
    copyNativeExecutable(path.join(firstBin, "claude"), nativeUtility("true"));
    copyNativeExecutable(path.join(secondBin, "claude"), nativeUtility("false"));
    const config = cliConfig("claude");
    const first = await ownerFingerprint(config, { env: { PATH: firstBin } });
    const second = await ownerFingerprint(config, { env: { PATH: secondBin } });

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("changes an opaque owner when the executable is replaced in place", async () => {
    const dir = tempDir("openclaw-cli-owner-replace-");
    const executable = path.join(dir, "claude");
    copyNativeExecutable(executable, nativeUtility("true"));
    const config = cliConfig(executable);
    const first = await ownerFingerprint(config);
    copyNativeExecutable(executable, nativeUtility("false"));
    if (nativeUtility("true") === nativeUtility("false")) {
      fs.appendFileSync(executable, "replacement");
    }
    const second = await ownerFingerprint(config);

    expectCliAuthEpoch(first);
    expectCliAuthEpoch(second);
    expect(second).not.toBe(first);
  });

  it("pins a symlinked CLI invocation to the canonical file that was hashed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = tempDir("openclaw-cli-owner-symlink-");
    const target = nativeUtility("true");
    const link = path.join(dir, "bin", "claude");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    const identity = await resolveCliExecutableIdentity({
      command: link,
      runtimeArtifact: {
        kind: "bundled-package-tree",
        packageName: "@fixture/native-cli",
        entrypoint: "command",
        nativeExecutableNames: [path.basename(fs.realpathSync(target))],
      },
    });
    expect(identity?.resolvedPath).toBe(fs.realpathSync(target));
    expect(identity?.invocation.command).toBe(fs.realpathSync(target));
  });

  it("refuses a cwd-relative executable as a persistent opaque owner", async () => {
    const dir = tempDir("openclaw-cli-owner-relative-");
    copyNativeExecutable(path.join(dir, "claude"), nativeUtility("true"));
    await expect(
      resolveCliRuntimeOwnerFingerprint({
        provider: "claude-cli",
        config: cliConfig("./claude"),
        agentId: "openclaw",
        cwd: dir,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not collapse a missing explicit CLI profile to ambient authority", async () => {
    setCliAuthEpochTestDeps({
      ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
    });

    await expect(
      resolveCliRuntimeOwnerFingerprint({
        provider: "claude-cli",
        config: cliConfig(process.execPath),
        agentId: "openclaw",
        authProfileId: "anthropic:missing",
      }),
    ).resolves.toBeUndefined();
  });
});
