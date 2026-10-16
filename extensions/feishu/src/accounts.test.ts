import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import {
  FeishuSecretRefUnavailableError,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveDefaultFeishuAccountSelection,
  resolveFeishuAccount,
  resolveFeishuCredentials,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  createFeishuTestConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuConfig } from "./types.js";

function asConfig(config: Partial<FeishuConfig>): FeishuConfig {
  return config as unknown as FeishuConfig;
}

const credentials = { appId: "cli_123", appSecret: "secret_456" };
const resolvedCredentials = {
  ...credentials,
  encryptKey: undefined,
  verificationToken: undefined,
  domain: "feishu",
};
const envRef = (provider = "default") => ({
  source: "env" as const,
  provider,
  id: FEISHU_SELECTED_SECRET_ENV,
});

describe("resolveDefaultFeishuAccountId", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = createFeishuTestConfig({
      appId: "cli_default",
      appSecret: "secret_default",
      accounts: { work: { enabled: false } },
    });

    expect(listFeishuAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultFeishuAccountId(cfg)).toBe("default");
  });

  it("reports selection source for configured defaults and mapped defaults", () => {
    const selection = (config: Partial<FeishuConfig>) =>
      resolveDefaultFeishuAccountSelection(createFeishuTestConfig(config));
    expect(selection({ defaultAccount: "router-d", accounts: {} })).toEqual({
      accountId: "router-d",
      source: "explicit-default",
    });

    expect(selection({ accounts: { default: credentials } })).toEqual({
      accountId: "default",
      source: "mapped-default",
    });
  });
});

describe("resolveFeishuCredentials", () => {
  it("resolves env SecretRef objects in inspect mode", () => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: " secret_from_env " }, () => {
      const cfg = asConfig({ ...credentials, appSecret: envRef() as never });
      expect(resolveFeishuCredentials(cfg, { mode: "inspect" })).toEqual({
        ...resolvedCredentials,
        appSecret: "secret_from_env", // pragma: allowlist secret
      });
    });
  });

  it("does not resolve encryptKey SecretRefs outside webhook mode", () => {
    const cfg = asConfig({
      ...credentials,
      connectionMode: "websocket",
      encryptKey: { source: "file", provider: "default", id: "path/to/secret" } as never,
    });
    expect(resolveFeishuCredentials(cfg)).toEqual(resolvedCredentials);
  });
});

describe("resolveFeishuAccount", () => {
  it("normalizes only the scheme after account inheritance and selection", () => {
    const rootDomain = "HtTpS://Root.Example:8443/Root%2FPath/?tenant=Keep#Fragment";
    const accountDomain = "HtTpS://fixture-user@Account.Example:9443/Account%2FPath/";
    const cfg = createFeishuTestConfig({
      appId: "root-app",
      appSecret: "root-secret",
      domain: rootDomain,
      defaultAccount: "work",
      accounts: {
        inherited: {},
        work: { appId: "work-app", appSecret: "work-secret", domain: accountDomain },
      },
    });
    for (const resolveAccount of [resolveFeishuAccount, resolveFeishuRuntimeAccount]) {
      expect(resolveAccount({ cfg, accountId: "inherited" })).toMatchObject({
        accountId: "inherited",
        appId: "root-app",
        domain: "https://Root.Example:8443/Root%2FPath/?tenant=Keep#Fragment",
      });
      for (const accountId of [undefined, "work"]) {
        expect(resolveAccount({ cfg, accountId })).toMatchObject({
          accountId: "work",
          appId: "work-app",
          domain: "https://fixture-user@Account.Example:9443/Account%2FPath/",
        });
      }
    }
    expect(cfg).toMatchObject({
      channels: { feishu: { domain: rootDomain, accounts: { work: { domain: accountDomain } } } },
    });
  });

  it.each(["encryptKey", "verificationToken"] as const)(
    "inspects webhook %s through the selected env collision without weakening strict mode",
    (field) => {
      withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "event-secret" }, () => {
        const cfg = createFeishuTestConfig(
          {
            connectionMode: "webhook",
            appId: "app",
            appSecret: "app-secret",
            [field]: envRef("selected"),
          },
          {
            secrets: {
              defaults: { env: "selected" },
              providers: { selected: { source: "exec", command: "/unused" } },
            },
          },
        );
        expect(() => resolveFeishuRuntimeAccount({ cfg }, { requireEventSecrets: true })).toThrow(
          FeishuSecretRefUnavailableError,
        );
        expect(resolveFeishuAccount({ cfg })[field]).toBe("event-secret");
        expect(resolveFeishuRuntimeAccount({ cfg })[field]).toBe("event-secret");
      });
    },
  );

  it.each(
    feishuSecretRefPolicyCases.filter(({ name }) =>
      [
        "unconfigured provider alias",
        "provider configured with a non-env source",
        "provider allowlist excluding the selected credential",
        "selected env default shadowing an exec provider",
      ].includes(name),
    ),
  )("enforces read-only provider policy for $name", (testCase) => {
    withEnv(
      {
        [FEISHU_SELECTED_SECRET_ENV]: " selected-secret ",
        [FEISHU_SIBLING_SECRET_ENV]: "sibling-secret",
      },
      () => {
        const account = resolveFeishuAccount({
          cfg: createFeishuSecretRefPolicyConfig(testCase),
          accountId: "selected",
        });

        expect(account).toMatchObject({
          accountId: "selected",
          configured: testCase.configured,
          appId: testCase.configured ? "selected-app" : undefined,
          appSecret: testCase.configured ? "selected-secret" : undefined,
        });
      },
    );
  });

  it("keeps account configured when optional event SecretRefs are unresolved in inspect mode", () => {
    const account = resolveFeishuAccount({
      cfg: createFeishuTestConfig({
        accounts: {
          main: {
            ...credentials,
            verificationToken: { source: "file", provider: "default", id: "path/to/token" },
          } as never,
        },
      }),
      accountId: "main",
    });

    expect(account).toMatchObject({
      configured: true,
      appSecret: "secret_456",
      verificationToken: undefined,
    });
  });

  it("does not resolve ambient env refs in strict runtime account snapshots", () => {
    withEnv({ [FEISHU_SELECTED_SECRET_ENV]: "selected-secret" }, () => {
      const cfg = createFeishuTestConfig({ appId: "selected-app", appSecret: envRef() });
      expect(() => resolveFeishuRuntimeAccount({ cfg })).toThrow(FeishuSecretRefUnavailableError);
    });
  });
});
