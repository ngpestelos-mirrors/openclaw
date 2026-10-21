import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import { withEnv } from "../../test-utils/env.js";
import {
  formatProviderAuthProfileCounts,
  resolveProviderAuthOverview,
} from "./list.auth-overview.js";

const persistedStores = vi.hoisted(() => new Map<string, { profiles: Record<string, unknown> }>());

vi.mock("../../agents/auth-profiles/display.js", () => ({
  resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
}));

vi.mock("../../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: vi.fn((agentDir?: string) =>
    persistedStores.get(agentDir ?? "__main__"),
  ),
}));

vi.mock("../../agents/auth-profiles/paths.js", () => ({
  resolveAuthStorePathForDisplay: vi.fn((agentDir?: string) =>
    agentDir ? `${agentDir}/auth-profiles.json` : "/tmp/auth-profiles.json",
  ),
}));

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  listProfilesForProvider: vi.fn(
    (store: { profiles?: Record<string, { provider?: string }> }, provider: string) =>
      Object.keys(store.profiles ?? {}).filter(
        (profileId) => store.profiles?.[profileId]?.provider === provider,
      ),
  ),
}));

vi.mock("../../agents/auth-profiles/usage.js", () => ({
  resolveProfileUnusableUntilForDisplay: vi.fn(() => undefined),
}));

type OverviewParams = Parameters<typeof resolveProviderAuthOverview>[0];
function resolveOverview(params: Pick<OverviewParams, "provider"> & Partial<OverviewParams>) {
  return resolveProviderAuthOverview({
    cfg: {},
    store: { version: 1, profiles: {} },
    modelsPath: "/tmp/models.json",
    ...params,
  });
}

function providerConfig(
  provider: string,
  entry: NonNullable<NonNullable<OverviewParams["cfg"]["models"]>["providers"]>[string],
) {
  return { models: { providers: { [provider]: entry } } };
}

function resolveOpenAiOverview(apiKey: string) {
  return resolveOverview({
    provider: "openai",
    cfg: providerConfig("openai", {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      apiKey,
      models: [],
    }),
  });
}

describe("resolveProviderAuthOverview", () => {
  beforeEach(() => {
    persistedStores.clear();
  });

  it("labels token profiles that only have tokenRef", () => {
    const result = resolveOverview({
      provider: "github-copilot",
      store: createAuthProfileStoreFixture({
        "github-copilot:default": {
          type: "token",
          provider: "github-copilot",
          tokenRef: { source: "env", provider: "default", id: "GITHUB_TOKEN" },
        },
      }),
    });

    expect(result.profiles.labels[0]).toContain("token:ref(env:GITHUB_TOKEN)");
  });

  it("reports an explicit provider env SecretRef ahead of stored profiles", () => {
    const cfg = providerConfig("custom", {
      apiKey: "current-provider-key",
      baseUrl: "https://models.example/v1",
      models: [],
    });
    setConfigResolutionFacts(
      cfg,
      createConfigResolutionFacts(
        [],
        new Map(),
        undefined,
        new Map([["models.providers.custom.apiKey", "CUSTOM_PROVIDER_KEY"]]),
      ),
    );
    const result = withEnv({ CUSTOM_PROVIDER_KEY: "current-provider-key" }, () =>
      resolveOverview({
        provider: "custom",
        cfg,
        store: createAuthProfileStoreFixture({
          "custom:models-json": createApiKeyCredential("custom", "stale-provider-key"),
        }),
      }),
    );

    expect(result.effective).toEqual({
      kind: "env",
      detail: expect.not.stringContaining("current-provider-key"),
    });
    expect(result.profiles.count).toBe(1);
  });

  it.each([
    ["api-key", "models.json"],
    [undefined, "profiles"],
  ] as const)("reports the credential inference selects with auth %s", (auth, kind) => {
    const result = resolveOverview({
      provider: "ollama-2",
      cfg: providerConfig("ollama-2", {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        ...(auth ? { auth } : {}),
        apiKey: "configured-key",
        models: [],
      }),
      store: createAuthProfileStoreFixture({
        "ollama-2:ambient": createApiKeyCredential("ollama-2", "ambient-key"),
      }),
    });

    expect(result.effective.kind).toBe(kind);
  });

  it("reports the main auth store for inherited profiles", () => {
    persistedStores.set("__main__", { profiles: { "openai:peter@example.test": {} } });
    const result = resolveOverview({
      provider: "openai",
      store: createAuthProfileStoreFixture({
        "openai:peter@example.test": createOAuthRefreshCredential(),
      }),
      modelsPath: "/tmp/openclaw-agent-custom/models.json",
      agentDir: "/tmp/openclaw-agent-custom",
    });

    expect(result.effective).toEqual({
      kind: "profiles",
      detail: "/tmp/auth-profiles.json",
    });
  });

  it("treats OAuth delegation markers as effective models.json auth", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("oauth:openai"),
    );

    expect(overview.effective).toEqual({
      kind: "models.json",
      detail: "marker(oauth:openai)",
    });
    expect(overview.modelsJson?.value).toBe("marker(oauth:openai)");
  });

  it("keeps env-var-shaped models.json values masked to avoid accidental plaintext exposure", () => {
    const overview = withEnv({ OPENAI_API_KEY: undefined }, () =>
      resolveOpenAiOverview("OPENAI_API_KEY"),
    );

    expect(overview.effective).toEqual({ kind: "missing", detail: "missing" });
    expect(overview.modelsJson?.value).not.toContain("marker(");
    expect(overview.modelsJson?.value).not.toContain("OPENAI_API_KEY");
  });
});

describe("formatProviderAuthProfileCounts", () => {
  it("renders the exact count line and survives console secret redaction", async () => {
    const { redactSensitiveText } = await import("../../logging/redact.js");
    const line = formatProviderAuthProfileCounts({ count: 2, oauth: 1, token: 1, apiKey: 0 });
    expect(line).toBe("2 (1 oauth, 1 token, 0 api-key)");
    // Regression: `token=1, api_key=0)` matched the console redactor's
    // key=value secret patterns and printed as `token=*** api_key=*** |`.
    expect(redactSensitiveText(`profiles=${line}`)).toBe(`profiles=${line}`);
  });
});
