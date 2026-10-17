import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveUsableAgentCredentialModes,
} from "./agent-auth-credentials.js";
import { addEnvBackedAgentCredentials } from "./agent-auth-discovery-core.js";
import { discoverAuthStorageFacts } from "./agent-model-discovery.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { writePersistedAuthProfileStoreRaw } from "./auth-profiles/sqlite.js";

vi.mock("./model-auth-env-vars.js", () => ({
  listProviderEnvAuthLookupKeys: () => ["workspace-cloud"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: {},
    authEvidenceMap: {
      "workspace-cloud": [
        {
          type: "local-file-with-env",
          credentialMarker: "workspace-cloud-local-credentials",
          source: "workspace cloud credentials",
        },
      ],
    },
  }),
}));

vi.mock("./model-auth-env.js", () => ({
  resolveEnvApiKey: (
    provider: string,
    _env: NodeJS.ProcessEnv,
    options?: { workspaceDir?: string },
  ) => {
    if (provider === "workspace-cloud" && options?.workspaceDir === "/tmp/workspace") {
      return {
        apiKey: "workspace-cloud-local-credentials",
        source: "workspace cloud credentials",
      };
    }
    return null;
  },
}));

const tempDirs = createTrackedTempDirs();
afterEach(() => tempDirs.cleanup());
const createAgentDir = () => tempDirs.make("openclaw-agent-auth-storage-");
const apiKey = (key: string) => ({ type: "api_key", key });

function writeProfiles(agentDir: string, profiles: AuthProfileStore["profiles"]): void {
  writePersistedAuthProfileStoreRaw(createAuthProfileStoreFixture(profiles), agentDir);
}

function oauth(expires = Date.now() + 3_600_000, access = "fake", refresh = "sample") {
  return { type: "oauth" as const, provider: "openai", access, refresh, expires };
}

function discover(agentDir: string, options: Parameters<typeof discoverAuthStorageFacts>[1] = {}) {
  return discoverAuthStorageFacts(agentDir, {
    skipExternalAuthProfiles: true,
    env: {},
    ...options,
  });
}

describe("discoverAuthStorageFacts auth storage", () => {
  it("converts runtime auth profiles into agent discovery credentials", () => {
    const credentials = resolveAgentCredentialMapFromStore(
      createAuthProfileStoreFixture({
        "openrouter:default": createApiKeyCredential("openrouter", "sk-or-v1-runtime"),
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-runtime",
        },
        "openai:default": oauth(Date.now() + 60_000, "oauth-access", "oauth-refresh"),
      }),
    );

    expect(credentials.openrouter).toEqual(apiKey("sk-or-v1-runtime"));
    expect(credentials.anthropic).toEqual(apiKey("sk-ant-runtime"));
    expect(credentials.openai).toMatchObject({
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
    });
    expect(resolveUsableAgentCredentialModes(credentials)).toEqual({
      anthropic: "api_key",
      openai: "oauth",
      openrouter: "api_key",
    });
    expect(
      resolveUsableAgentCredentialModes({
        bearer: { type: "token", token: "runtime-token", expires: Date.now() + 60_000 },
        expired: { type: "token", token: "expired-token", expires: Date.now() - 1 },
      }),
    ).toEqual({ bearer: "token" });
  });

  it("drops runtime auth profiles with out-of-range expiry values", () => {
    const credentials = resolveAgentCredentialMapFromStore({
      version: 1,
      profiles: {
        "anthropic:bad-token-expiry": {
          type: "token",
          provider: "anthropic",
          token: "sk-ant-runtime",
          expires: MAX_DATE_TIMESTAMP_MS + 1,
        },
        "openai:bad-oauth-expiry": oauth(MAX_DATE_TIMESTAMP_MS + 1),
      },
    });

    expect(credentials.anthropic).toBeUndefined();
    expect(credentials.openai).toBeUndefined();
  });

  it("uses canonical mode and expiry ordering instead of profile insertion order", () => {
    const resolved = resolveAgentCredentialMapFromStore(
      createAuthProfileStoreFixture({
        "openai:key": createApiKeyCredential("openai", "test-key"),
        "openai:expired": oauth(Date.now() - 3_600_000),
        "openai:valid": oauth(),
      }),
    );

    expect(resolved.openai).toEqual({
      type: "oauth",
      access: "fake",
      refresh: "sample",
      expires: expect.any(Number),
    });
  });

  it("passes configured auth order through discovery selection", async () => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "openai:oauth": oauth(),
      "openai:key": createApiKeyCredential("openai", "test-key"),
    });
    const { authStorage } = await discover(agentDir, {
      config: {
        auth: { order: { openai: ["openai:key", "openai:oauth"] } },
      },
    });

    expect(authStorage.get("openai")).toEqual(apiKey("test-key"));
  });

  it("keeps keyRef and tokenRef profiles visible only for read-only agent discovery", () => {
    const store = createAuthProfileStoreFixture<AuthProfileStore["profiles"]>({
      "openrouter:default": {
        type: "api_key",
        provider: "openrouter",
        keyRef: { source: "exec", provider: "keychain", id: "OPENROUTER_API_KEY" },
      },
      "anthropic:default": {
        type: "token",
        provider: "anthropic",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
      },
      "expired:default": {
        type: "token",
        provider: "expired",
        tokenRef: { source: "env", provider: "default", id: "EXPIRED_AUTH_TOKEN" },
        expires: Date.now() - 1_000,
      },
    });
    const credentials = resolveAgentCredentialMapFromStore(store);
    const discoveryCredentials = resolveAgentCredentialMapFromStore(store, {
      includeSecretRefPlaceholders: true,
    });

    expect(credentials.openrouter).toBeUndefined();
    expect(credentials.anthropic).toBeUndefined();
    expect(discoveryCredentials.openrouter?.type).toBe("api_key");
    expect(discoveryCredentials.anthropic?.type).toBe("api_key");
    expect(discoveryCredentials.expired).toBeUndefined();
    expect(resolveUsableAgentCredentialModes(discoveryCredentials)).toEqual({});
  });

  it("marks keyRef-only auth profiles configured for read-only model discovery", async () => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "fixture-ref-provider:default": {
        type: "api_key",
        provider: "fixture-ref-provider",
        keyRef: { source: "exec", provider: "keychain", id: "FIXTURE_API_KEY" },
      },
    });

    const { authStorage: readOnlyStorage } = await discover(agentDir, {
      readOnly: true,
    });
    const { authStorage: runtimeStorage } = await discover(agentDir);

    expect(readOnlyStorage.hasAuth("fixture-ref-provider")).toBe(true);
    expect(runtimeStorage.hasAuth("fixture-ref-provider")).toBe(false);
  });

  it("uses the lifecycle owner's explicit inherited auth directory", async () => {
    const inheritedAuthDir = await createAgentDir();
    const agentDir = await createAgentDir();
    writeProfiles(inheritedAuthDir, {
      "inherited-provider:default": createApiKeyCredential("inherited-provider", "inherited-key"),
      "shared-provider:inherited": createApiKeyCredential(
        "shared-provider",
        "inherited-shared-key",
      ),
    });
    writeProfiles(agentDir, {
      "shared-provider:local": createApiKeyCredential("shared-provider", "local-shared-key"),
    });

    const { authStorage: storage } = await discover(agentDir, {
      inheritedAuthDir,
    });

    expect(storage.get("inherited-provider")).toEqual(apiKey("inherited-key"));
    expect(storage.get("shared-provider")).toEqual(apiKey("local-shared-key"));
  });

  it("includes workspace-scoped auth evidence in agent discovery credentials", () => {
    const credentials = addEnvBackedAgentCredentials(
      {},
      {
        env: {},
        workspaceDir: "/tmp/workspace",
      },
    );

    expect(credentials["workspace-cloud"]).toEqual(apiKey("workspace-cloud-local-credentials"));
  });
});
