import { describe, expect, it } from "vitest";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import type { OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe("Copilot tenant identity-less adoption", () => {
  it.each([
    ["different enterprise tenant", "acme.ghe.com", "other.ghe.com", false],
    ["public versus enterprise tenant", undefined, "acme.ghe.com", false],
    ["public URL spellings", undefined, "https://github.com/", true],
    ["same enterprise tenant URL spelling", "HTTPS://ACME.GHE.COM/", "acme.ghe.com", true],
  ])(
    "applies provider routing scope before identity-less adoption: %s",
    (_name, existingDomain, incomingDomain, expected) => {
      expect(
        isSafeToAdoptMainStoreOAuthIdentity(
          createCredential({ provider: "github-copilot", enterpriseUrl: existingDomain }),
          createCredential({
            provider: "github-copilot",
            enterpriseUrl: incomingDomain,
            accountId: "acct-main",
          }),
        ),
      ).toBe(expected);
    },
  );
});

describe("shouldUseMainOwnerForLocalOAuthCredential", () => {
  it("does not transfer ownership across GitHub Copilot tenants", () => {
    expect(
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: "github-copilot:default",
        local: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "acme.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now(),
        }),
        main: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "other.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now() + 60_000,
          accountId: "acct-main",
        }),
      }),
    ).toBe(false);
  });

  it("keeps ownership transfer for the same tenant when main is fresher", () => {
    expect(
      shouldUseMainOwnerForLocalOAuthCredential({
        profileId: "github-copilot:default",
        local: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "acme.ghe.com",
          refresh: "shared-refresh-generation",
          expires: Date.now(),
        }),
        main: createCredential({
          provider: "github-copilot",
          enterpriseUrl: "https://acme.ghe.com/",
          refresh: "shared-refresh-generation",
          expires: Date.now() + 60_000,
          accountId: "acct-main",
        }),
      }),
    ).toBe(true);
  });
});

describe("Copilot persisted public-scope metadata", () => {
  it.each([
    { name: "absent", enterpriseUrl: undefined, expected: true },
    { name: "empty", enterpriseUrl: "", expected: true },
    { name: "spaces only", enterpriseUrl: "  ", expected: false },
    { name: "tabs and newlines only", enterpriseUrl: "\t\n", expected: false },
  ])(
    "aligns copy, adoption and copied-generation ownership for $name metadata",
    ({ enterpriseUrl, expected }) => {
      const credential = createCredential({ provider: "github-copilot", enterpriseUrl });
      const publicCredential = createCredential({
        provider: "github-copilot",
        enterpriseUrl: "https://github.com/",
      });
      // Check every actual gate in both directions, including the identical-refresh shortcut.
      for (const [existing, incoming] of [
        [credential, publicCredential],
        [publicCredential, credential],
      ] as const) {
        expect.soft(isSafeToCopyOAuthIdentity(existing, incoming)).toBe(expected);
        expect.soft(isSafeToAdoptMainStoreOAuthIdentity(existing, incoming)).toBe(expected);
        expect
          .soft(
            shouldUseMainOwnerForLocalOAuthCredential({
              profileId: "github-copilot:default",
              local: existing,
              main: incoming,
            }),
          )
          .toBe(expected);
      }
    },
  );
});
