import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "./models-config.providers.secrets.js";
import { resolveProviderUseAdmission } from "./provider-model-auth-source-plan.js";

const sharedProviderEnvVars = {
  opencode: ["OPENCODE_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
};

describe("resolveProviderUseAdmission", () => {
  it("does not replace an expired bound profile with shared environment auth", () => {
    const env = { OPENCODE_API_KEY: "unbound-key" };
    const store = {
      version: 1,
      profiles: {
        "opencode:expired": {
          provider: "opencode",
          type: "token" as const,
          token: "expired",
          expires: 1,
        },
        "opencode-go:other": {
          provider: "opencode-go",
          type: "api_key" as const,
          key: "other-key",
        },
      },
    };
    const admission = resolveProviderUseAdmission({ env, profiles: store.profiles });
    const apiKey = createProviderApiKeyResolver(
      env,
      store,
      {},
      undefined,
      undefined,
      env,
      admission,
    );
    const auth = createProviderAuthResolver(env, store, {}, undefined, undefined, env, admission);
    expect(apiKey("opencode").apiKey).toBeUndefined();
    expect(auth("opencode").mode).toBe("none");
    expect(apiKey("opencode-go").discoveryApiKey).toBe("other-key");
    const availability = createModelAuthAvailabilityResolver({ cfg: {}, env, authStore: store });
    expect(availability.resolveProviderAuthAvailability("opencode")).toBe(false);
    expect(availability.resolveProviderAuthAvailability("opencode-go")).toBe(true);
  });
  it("uses the admitted environment binding during catalog credential lookup", () => {
    const env = { OPENAI_API_KEY: "bound-key", CODEX_API_KEY: "unbound-key" };
    const resolve = createProviderApiKeyResolver(
      env,
      { version: 1, profiles: {} },
      {},
      undefined,
      undefined,
      env,
      new Map([["openai", { kind: "environment", envVar: "OPENAI_API_KEY" }]]),
    );
    expect(resolve("openai")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      discoveryApiKey: "bound-key",
    });
  });
  it("does not expose an auth-alias sibling through a stored family profile", () => {
    const resolver = createModelAuthAvailabilityResolver({
      cfg: {},
      env: {},
      authStore: {
        version: 1,
        profiles: {
          "family:account": { type: "api_key", provider: "family", key: "synthetic-key" },
        },
      },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "family",
            providers: ["family", "family-plan"],
            providerAuthAliases: { "family-plan": "family" },
          },
        ],
      }),
    });
    expect(resolver.resolveProviderAuthAvailability("family")).toBe(true);
    expect(resolver.resolveProviderAuthAvailability("family-plan")).toBe(false);
  });
  it("admits only the normalized direct owner and records no credential value", () => {
    const admission = resolveProviderUseAdmission({
      env: { OWNER_API_KEY: "synthetic-secret", EMPTY_API_KEY: "  " },
      providerEnvVars: {
        " Owner ": ["OWNER_API_KEY"],
        owner: ["OWNER_API_KEY"],
        borrower: [],
        empty: ["EMPTY_API_KEY"],
      },
    });

    expect(admission).toEqual(
      new Map([["owner", { kind: "environment", envVar: "OWNER_API_KEY" }]]),
    );
  });

  it("does not choose either provider from a shared environment key", () => {
    expect(
      resolveProviderUseAdmission({
        env: { OPENCODE_API_KEY: "synthetic-shared-secret" },
        providerEnvVars: sharedProviderEnvVars,
      }),
    ).toEqual(new Map());
  });

  it.each([
    {
      kind: "provider-config",
      binding: {
        config: {
          models: {
            providers: { " OPENCODE ": { baseUrl: "https://models.example", models: [] } },
          },
        } satisfies OpenClawConfig,
      },
      source: { kind: "provider-config" },
    },
    {
      kind: "profile",
      binding: { profiles: { "saved-account": { provider: " OPENCODE " } } },
      source: { kind: "profile", profileId: "saved-account" },
    },
    {
      kind: "native-account",
      binding: { nativeProviders: new Set([" OPENCODE "]) },
      source: { kind: "native-account" },
    },
  ])("keeps shared credentials bound to the $kind provider", ({ binding, source }) => {
    const admission = resolveProviderUseAdmission({
      ...binding,
      env: { OPENCODE_API_KEY: "synthetic-shared-secret" },
      providerEnvVars: sharedProviderEnvVars,
    });

    expect(admission).toEqual(new Map([["opencode", source]]));
  });

  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "MODEL_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ])("does not admit a provider from generic credential %s", (envVar) => {
    expect(
      resolveProviderUseAdmission({
        env: { [envVar]: "synthetic-value" },
        providerEnvVars: { cloud: [envVar] },
      }),
    ).toEqual(new Map());
  });

  it.each([undefined, "api-key", "aws-sdk"] as const)(
    "accepts an explicit %s provider without inline credentials",
    (auth) => {
      const admission = resolveProviderUseAdmission({
        config: {
          models: {
            providers: {
              cloud: { baseUrl: "https://models.example", auth, models: [] },
            },
          },
        },
        env: {},
        providerEnvVars: {},
      });

      expect(admission).toEqual(new Map([["cloud", { kind: "provider-config" }]]));
    },
  );
});
