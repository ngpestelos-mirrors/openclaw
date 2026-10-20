import { afterEach, expect, it, vi } from "vitest";
import type { GitHubAppSelection } from "../agents/github-credential-reader.js";
import { readFactoryRepositoryAdmission } from "./factory-github-repository-admission.js";

const selection: GitHubAppSelection = {
  kind: "app-installation",
  profileId: "ghp_00000000000000000000000000000001",
  app: {
    appId: 10,
    installationId: 20,
    accountId: 30,
    repositories: [{ id: 40, fullName: "example/repository" }],
    permissions: { contents: "write" },
    privateKey: "synthetic",
    keyVersion: "synthetic-v1",
  },
};
const claim = {
  purpose: "session-item-read" as const,
  binding: {
    kind: "session" as const,
    agentId: "main",
    sessionKey: "agent:main:owned",
    sessionId: "session-1",
    lifecycleRevision: null,
    requestDigest: "digest-1",
  },
};
const receipt = () => ({
  version: 1,
  kind: "repository-admission",
  host: "example.ghe.com",
  appId: 10,
  installationId: 20,
  repository: { id: 40, fullName: "example/repository" },
  actor: { accountId: 50, profileId: "person-1" },
  purpose: claim.purpose,
  binding: claim.binding,
  expiresAtMs: Date.now() + 60_000,
});
const params = {
  env: {
    OPENCLAW_FACTORY_GITHUB_PROOF: "synthetic-proof",
    OPENCLAW_GATEWAY_PASSWORD: "synthetic-password",
    OPENCLAW_FACTORY_ACTOR_ID: "50",
  },
  request: { kind: "repository-admission" as const, host: "example.ghe.com", selection },
  claim,
  profileId: "person-1",
  assertCurrent: () => {},
};
afterEach(() => vi.unstubAllGlobals());
const respondWith = (value: ReturnType<typeof receipt>) => {
  const fetcher = vi.fn(async () => Response.json(value));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
it("accepts only the exact current actor, App installation, repository and session receipt", async () => {
  const fetcher = respondWith(receipt());
  await readFactoryRepositoryAdmission(params);
  expect(fetcher.mock.calls.length).toBe(1);
});
it.each<[string, (value: ReturnType<typeof receipt>) => void]>([
  ["actor", (value) => Object.assign(value.actor, { accountId: 51 })],
  ["installation", (value) => Object.assign(value, { installationId: 21 })],
  ["repository", (value) => Object.assign(value.repository, { id: 41 })],
  [
    "session",
    (value) => {
      value.binding = { ...value.binding, sessionId: "other-session" };
    },
  ],
  ["expired", (value) => Object.assign(value, { expiresAtMs: Date.now() - 1 })],
])("rejects a %s mismatch before execution issuance", async (_changed, mutate) => {
  const value = receipt();
  mutate(value);
  respondWith(value);
  await expect(readFactoryRepositoryAdmission(params)).rejects.toThrow(
    "Factory repository admission failed",
  );
});
it("checks current authority after the broker response", async () => {
  let current = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      current = false;
      return Response.json(receipt());
    }),
  );
  await expect(
    readFactoryRepositoryAdmission({
      ...params,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Session revoked");
        }
      },
    }),
  ).rejects.toThrow("Session revoked");
});
