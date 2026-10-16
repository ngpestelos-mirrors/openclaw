import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn());
const coerceSecretRefMock = vi.hoisted(() => vi.fn());
const resolveConfiguredSecretInputWithFallbackMock = vi.hoisted(() => vi.fn());
const resolveRequiredConfiguredSecretRefInputStringMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  const { normalizeOptionalString } = await import("openclaw/plugin-sdk/string-coerce-runtime");
  return {
    ...actual,
    coerceSecretRef: coerceSecretRefMock,
    ensureAuthProfileStoreAsync: ensureAuthProfileStoreMock,
    listProfilesForProvider: listProfilesForProviderMock,
    normalizeOptionalSecretInput: normalizeOptionalString,
  };
});

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  resolveConfiguredSecretInputWithFallback: resolveConfiguredSecretInputWithFallbackMock,
  resolveRequiredConfiguredSecretRefInputString: resolveRequiredConfiguredSecretRefInputStringMock,
}));

import { resolveFirstGithubToken } from "./auth.js";

const tokenProfile = (token: string) => ({ type: "token", provider: "github-copilot", token });
const makeTokenRef = (source: "file" | "env", id: string) => ({ source, provider: "default", id });
const orderedConfig = (profileId: string) => ({
  auth: { order: { "github-copilot": [profileId] } },
});
const providerConfig = (
  provider: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string],
): OpenClawConfig => ({ models: { providers: { "github-copilot": provider } } });
function setProfiles(profiles: Record<string, unknown>, order?: Record<string, string[]>) {
  ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles, ...(order ? { order } : {}) });
  listProfilesForProviderMock.mockReturnValue(Object.keys(profiles));
}
const oauthProfile = (enterpriseUrl?: string, refresh = " durable-github-token ") => ({
  type: "oauth",
  provider: "github-copilot",
  access: "short-lived-copilot-token",
  refresh,
  expires: Date.now() + 60_000,
  ...(enterpriseUrl ? { enterpriseUrl } : {}),
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/secret-input-runtime");
  vi.resetModules();
});

describe("resolveFirstGithubToken", () => {
  beforeEach(() => {
    setProfiles({
      "github-copilot:github": {
        type: "token",
        tokenRef: makeTokenRef("file", "/providers/github-copilot/token"),
      },
    });
    coerceSecretRefMock.mockImplementation((value: unknown) =>
      typeof value === "object" && value !== null && "source" in value ? value : null,
    );
    resolveRequiredConfiguredSecretRefInputStringMock.mockImplementation(
      async ({ value }: { value: unknown }) => (value ? "resolved-profile-token" : undefined),
    );
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
      value: "test-token-placeholder",
      source: "config",
      secretRefConfigured: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    coerceSecretRefMock.mockReset();
    resolveConfiguredSecretInputWithFallbackMock.mockReset();
    resolveRequiredConfiguredSecretRefInputStringMock.mockReset();
  });

  it.each([
    {
      label: "provider keys are matched case-insensitively",
      providerKey: " GITHUB-COPILOT ",
      configuredOrder: ["github-copilot:first"],
      storedOrder: ["github-copilot:preferred"],
      expectedToken: "preferred-token",
    },
    {
      label: "an explicit empty order does not fall back to another account",
      configuredOrder: [],
      expectedToken: "",
    },
  ])("honors auth profile order when $label", async (testCase) => {
    const providerKey = testCase.providerKey ?? "github-copilot";
    setProfiles(
      {
        "github-copilot:first": tokenProfile("first-token"),
        "github-copilot:preferred": tokenProfile("preferred-token"),
      },
      testCase.storedOrder ? { [providerKey]: testCase.storedOrder } : undefined,
    );

    await expect(
      resolveFirstGithubToken({
        config: {
          auth: { order: { [providerKey]: testCase.configuredOrder } },
        },
        env: {},
      }),
    ).resolves.toEqual({
      githubToken: testCase.expectedToken,
      hasProfile: true,
      ...(testCase.expectedToken ? { profileId: "github-copilot:preferred" } : {}),
    });
  });

  it.each([
    {
      label: "a public GitHub OAuth account",
      enterpriseUrl: undefined,
      expected: {
        githubToken: "durable-github-token",
        githubDomain: "github.com",
        hasProfile: true,
        profileId: "github-copilot:preferred",
      },
    },
    {
      label: "an enterprise GitHub OAuth account",
      enterpriseUrl: "acme.ghe.com",
      expected: {
        githubToken: "durable-github-token",
        githubDomain: "acme.ghe.com",
        hasProfile: true,
        profileId: "github-copilot:preferred",
      },
    },
    {
      label: "an enterprise OAuth account with a whitespace-only durable credential",
      enterpriseUrl: "acme.ghe.com",
      refresh: "   ",
      expected: { githubToken: "", hasProfile: true },
    },
  ])("uses the durable credential when explicit order selects $label", async (testCase) => {
    setProfiles({
      "github-copilot:first": tokenProfile("first-token"),
      "github-copilot:preferred": oauthProfile(testCase.enterpriseUrl, testCase.refresh),
    });

    await expect(
      resolveFirstGithubToken({
        config: orderedConfig("github-copilot:preferred"),
        env: {},
      }),
    ).resolves.toEqual(testCase.expected);
  });

  it.each(["durable-github-token"])(
    "rejects an explicitly ordered OAuth account with an unsupported enterprise domain (refresh: %j)",
    async (refresh) => {
      setProfiles({ "github-copilot:preferred": oauthProfile("attacker.example", refresh) });

      await expect(
        resolveFirstGithubToken({
          config: orderedConfig("github-copilot:preferred"),
          env: {},
        }),
      ).rejects.toThrow(/attacker\.example/);
    },
  );

  it("preserves explicitly requested profiles even when account order excludes them", async () => {
    setProfiles({
      "github-copilot:first": tokenProfile("first-token"),
      "github-copilot:preferred": tokenProfile("preferred-token"),
    });

    await expect(
      resolveFirstGithubToken({
        config: orderedConfig("github-copilot:first"),
        env: {},
        profileId: "github-copilot:preferred",
      }),
    ).resolves.toEqual({
      githubToken: "preferred-token",
      hasProfile: true,
      profileId: "github-copilot:preferred",
    });
  });

  it.each(["api-key"] as const)(
    "does not fall back to ambient tokens when a direct apiKey SecretRef is unavailable (auth: %s)",
    async (auth) => {
      setProfiles({});
      const config = providerConfig({
        auth,
        apiKey: makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"),
        baseUrl: "https://api.githubcopilot.com",
        models: [],
      });
      const env = {
        COPILOT_GITHUB_TOKEN: "ambient-copilot-token",
        GH_TOKEN: "ambient-gh-token",
        GITHUB_TOKEN: "ambient-github-token",
      };
      resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({
        secretRefConfigured: true,
        unresolvedRefReason: "models.providers.github-copilot.apiKey SecretRef is unresolved.",
      });

      for (const authProfileMode of [undefined, "api_key"] as const) {
        await expect(
          resolveFirstGithubToken({ config, env, ...(authProfileMode ? { authProfileMode } : {}) }),
        ).rejects.toThrow("models.providers.github-copilot.apiKey");
      }
    },
  );

  it("lets explicit api-key config outrank environment direct auth", async () => {
    const config = providerConfig({
      auth: "api-key",
      apiKey: "test-token-placeholder",
      baseUrl: "https://api.githubcopilot.com",
      models: [],
    });
    const env = { COPILOT_GITHUB_TOKEN: "test-auth-token" } as NodeJS.ProcessEnv;

    const result = await resolveFirstGithubToken({
      config,
      env,
      authProfileMode: "api_key",
    });

    expect(result).toEqual({
      githubToken: "test-token-placeholder",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith({
      config,
      env,
      value: "test-token-placeholder",
      path: "models.providers.github-copilot.apiKey",
      readFallback: expect.any(Function),
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("ignores inactive apiKey refs for OAuth profiles and profile-less direct auth", async () => {
    setProfiles({ "github-copilot:github": tokenProfile("profile-token") });
    resolveRequiredConfiguredSecretRefInputStringMock.mockResolvedValue(undefined);
    const config = providerConfig({
      auth: "oauth",
      apiKey: makeTokenRef("env", "MISSING_COPILOT_DIRECT_TOKEN"),
      baseUrl: "https://api.githubcopilot.com",
      models: [],
    });

    await expect(
      resolveFirstGithubToken({
        config,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ githubToken: "ambient-token", hasProfile: false });
    expect(resolveConfiguredSecretInputWithFallbackMock).not.toHaveBeenCalled();

    setProfiles({});
    resolveConfiguredSecretInputWithFallbackMock.mockResolvedValue({ secretRefConfigured: false });
    await expect(resolveFirstGithubToken({ config, env: {} })).resolves.toEqual({
      githubToken: "",
      hasProfile: false,
    });
    expect(resolveConfiguredSecretInputWithFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: undefined }),
    );
  });

  it.each(["GITHUB_TOKEN"])("does not authenticate with generic %s", async (key) => {
    setProfiles({});
    await expect(resolveFirstGithubToken({ env: { [key]: "generic-token" } })).resolves.toEqual({
      githubToken: "",
      hasProfile: false,
    });
  });

  it("never replaces an explicitly requested missing profile with ambient auth or another profile", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", token: "other-profile-token" },
      },
    });

    await expect(
      resolveFirstGithubToken({
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
        profileId: "github-copilot:missing",
      }),
    ).resolves.toEqual({ githubToken: "", hasProfile: true });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).not.toHaveBeenCalled();
  });

  it("does not read process.env or swallow an explicitly requested unavailable profile ref", async () => {
    const tokenRef = { source: "env", provider: "default", id: "COPILOT_PROCESS_ONLY_TOKEN" };
    vi.stubEnv(tokenRef.id, "process-only-token");
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", tokenRef },
        "github-copilot:other": { type: "token", token: "other-profile-token" },
      },
    });
    listProfilesForProviderMock.mockReturnValue(["github-copilot:github", "github-copilot:other"]);
    resolveRequiredConfiguredSecretRefInputStringMock.mockRejectedValue(
      new Error("github-copilot:github tokenRef unavailable"),
    );

    await expect(
      resolveFirstGithubToken({
        env: {},
        profileId: "github-copilot:github",
      }),
    ).rejects.toThrow("github-copilot:github tokenRef unavailable");
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, env: {}, value: tokenRef }),
    );
  });

  it("resolves a profile SecretRef before stale plaintext through the central resolver", async () => {
    const config = { secrets: { defaults: { provider: "default" } } } as never;
    const env = {} as NodeJS.ProcessEnv;
    const tokenRef = { source: "file", provider: "default", id: "/providers/github-copilot/token" };
    ensureAuthProfileStoreMock.mockReturnValue({
      profiles: {
        "github-copilot:github": { type: "token", token: "stale-profile-token", tokenRef },
      },
    });
    const result = await resolveFirstGithubToken({
      config,
      env,
    });

    expect(result).toEqual({
      githubToken: "resolved-profile-token",
      hasProfile: true,
      profileId: "github-copilot:github",
    });
    expect(resolveRequiredConfiguredSecretRefInputStringMock).toHaveBeenCalledWith({
      config,
      env,
      value: tokenRef,
      path: "providers.github-copilot.authProfiles.github-copilot:github.tokenRef",
    });
  });
});
