import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { visitorListDetailsSchema, type VisitorListDetails } from "./src/tool-results.js";
import type { VisitorGrant } from "./src/visitors.js";
import {
  guestRole,
  namedPolicy,
  staffRole,
  visitorProfileFixture,
} from "./src/visitors.test-support.js";

type PluginGatewayAccessPolicy = Parameters<OpenClawPluginApi["registerGatewayAccessPolicy"]>[0];

const TOKEN = "visitor-test-token-never-echo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const policiesUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const gatewayConfig: OpenClawConfig = {
  gateway: {
    roles: {
      default: "external-work",
      definitions: {
        "external-work": guestRole,
        staff: staffRole,
      },
    },
  },
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

const textContaining = (text: string) => [{ type: "text", text: expect.stringContaining(text) }];
const oidcProvider = {
  issuer: "https://example.cloudflareaccess.com",
  providerId: "test-oidc",
  githubAccountIdClaim: "github_id",
};
function required<T>(value: T | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function resolveTools(
  registration: Parameters<OpenClawPluginApi["registerTool"]>[0],
  context: OpenClawPluginToolContext<2>,
): AnyAgentTool[] {
  const resolved =
    typeof registration === "function"
      ? registration(context)
      : "contextVersion" in registration
        ? registration.create(context)
        : registration;
  return Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
}

async function expectDetails(
  result: ReturnType<AnyAgentTool["execute"]>,
  details: object,
  text?: string,
) {
  expect(await result).toMatchObject({
    details,
    ...(text ? { content: textContaining(text) } : {}),
  });
}

const visitor = (
  emails: string[],
  profileId = "visitor-profile",
  assignedRole: string | null = "external-work",
) => ({ profileId, emails, assignedRole });

function createPolicyFetch(initialTargets: Array<string | number> = []) {
  let targets = [...initialTargets];
  const controls = { failWrites: false, loseWriteResponse: false };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (!url.href.startsWith(policiesUrl)) {
      throw new Error(`Unexpected test request: ${url}`);
    }
    const policy = {
      ...namedPolicy(targets, "Visitors (openclaw-managed)", oidcProvider),
      id: "visitor-policy",
    };
    if (init?.method === "GET") {
      const result = url.search ? (targets.length ? [policy] : []) : policy;
      return Response.json({ success: true, result });
    }
    if (controls.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (init?.method === "DELETE") {
      targets = [];
    } else {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy body");
      }
      const body: unknown = JSON.parse(init.body);
      const schema = Type.Object({
        include: Type.Array(
          Type.Union([
            Type.Object({ email: Type.Object({ email: Type.String() }) }),
            Type.Object({
              oidc: Type.Object({
                identity_provider_id: Type.Literal("test-oidc"),
                claim_name: Type.Literal("github_id"),
                claim_value: Type.Literal("42"),
              }),
            }),
          ]),
        ),
      });
      if (!Value.Check(schema, body)) {
        throw new Error("Unexpected visitor policy rules");
      }
      targets = body.include.map((rule) =>
        "email" in rule ? rule.email.email : Number(rule.oidc.claim_value),
      );
    }
    if (controls.loseWriteResponse) {
      throw new Error(`Transport failure with Authorization: Bearer ${TOKEN}`);
    }
    return Response.json({ success: true, result: {} });
  });
  return {
    fetcher,
    emails: () => targets.filter((target) => typeof target === "string"),
    controls,
  };
}

describe("visitor-access plugin lifecycle", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "visitor-access-test-")));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(START_MS);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function registerPlugin(
    contextOverrides: Partial<OpenClawPluginToolContext<2>> = {},
    config: OpenClawConfig = gatewayConfig,
    githubProfiles: Parameters<typeof visitorProfileFixture>[1] = [],
  ) {
    const tools = new Map<string, AnyAgentTool>();
    const backgroundTasks: Promise<unknown>[] = [];
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    const accessPolicies: PluginGatewayAccessPolicy[] = [];
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const toolContext: OpenClawPluginToolContext<2> = {
      sessionKey: "agent:main:maintainer",
      senderIsOwner: true,
      assertInvocationCurrent() {},
      ...contextOverrides,
    };
    const api = createTestPluginApi({
      id: "visitor-access",
      pluginConfig: { accountId: "test-account", appId: "test-app", apiToken: TOKEN },
      logger,
      on,
      registerService: (service) => services.push(service),
      registerGatewayAccessPolicy: (policy) => accessPolicies.push(policy),
      registerTool: (registration) => {
        for (const tool of resolveTools(registration, toolContext)) {
          tools.set(tool.name, tool);
        }
      },
    });
    api.lifecycle.runInBackgroundContext = (run) => {
      const result = run();
      if (result instanceof Promise) {
        backgroundTasks.push(result);
      }
      return result;
    };
    api.runtime.state = {
      ...api.runtime.state,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("visitor-access", { ...options, env }),
    };
    const directory = visitorProfileFixture([], githubProfiles);
    api.runtime.gateway = directory.gateway;
    const gatewayRequest = directory.request;
    api.runtime.config = {
      current: () => config,
      async mutateConfigFile() {
        throw new Error("Visitor operations must not change Gateway configuration");
      },
      async replaceConfigFile() {
        throw new Error("Visitor operations must not replace Gateway configuration");
      },
    };
    plugin.register(api);
    const service = required(services[0], "Plugin did not register its expiry service");
    const accessPolicy = required(
      accessPolicies[0],
      "Plugin did not register its Gateway access policy",
    );
    const scheduler = createTestPluginServiceScheduler();
    const context: OpenClawPluginServiceContextV2 = { config: {}, stateDir, logger, scheduler };
    const stop = async () => {
      scheduler.beginClose();
      try {
        await service.stop?.(context);
      } finally {
        await scheduler.stop();
      }
    };
    cleanups.push(stop);
    const store = createPluginStateKeyedStoreForTests<VisitorGrant>("visitor-access", {
      namespace: "visitor-grants",
      maxEntries: 500,
      overflowPolicy: "reject-new",
      env,
    });
    return {
      tools,
      gatewayRequest,
      setProfiles: directory.setProfiles,
      logger,
      store,
      authorize: (
        profile: Parameters<PluginGatewayAccessPolicy["authorize"]>[0]["profile"],
        requiredByRole = true,
      ) => accessPolicy.authorize({ config, profile, requiredByRole }),
      toolContext,
      start: () => service.start(context),
      settle: () => Promise.allSettled(backgroundTasks),
      stop,
      gatewayStart: () => {
        const hook = required(
          on.mock.calls.find(([name]) => name === "gateway_start")?.[1],
          "Plugin did not register its Gateway startup sweep",
        );
        const startHook = hook as (
          event: { port: number },
          context: { port?: number },
        ) => void | Promise<void>;
        return startHook({ port: 18789 }, {});
      },
      execute: async (name: string, input: Record<string, unknown> = {}) => {
        const tool = required(tools.get(name), `Plugin did not register ${name}`);
        const result = await tool.execute("visitor-test-call", input);
        expect(
          Value.Check(
            required(tool.outputSchema, `${name} did not declare an output schema`),
            result.details,
          ),
        ).toBe(true);
        return result;
      },
    };
  }

  function setup(
    context: Partial<OpenClawPluginToolContext<2>> = {},
    config = gatewayConfig,
    githubProfiles: Parameters<typeof visitorProfileFixture>[1] = [],
    targets: Array<string | number> = [],
  ) {
    const policy = createPolicyFetch(targets);
    vi.stubGlobal("fetch", policy.fetcher);
    return { ...registerPlugin(context, config, githubProfiles), policy };
  }

  it("keeps CLI metadata discovery free of runtime access and background work", () => {
    const api = createTestPluginApi({ registrationMode: "cli-metadata" });
    const runtime = vi.fn(() => {
      throw new Error("Metadata discovery accessed runtime");
    });
    Object.defineProperty(api, "runtime", { get: runtime });
    expect(() => plugin.register(api)).not.toThrow();
    expect(runtime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["email", "github"] as const)(
    "lists verified profile identity for the %s target and revokes by listed profileId",
    async (selector) => {
      const config = structuredClone(gatewayConfig);
      config.gateway = {
        ...config.gateway,
        auth: {
          trustedProxy: {
            userHeader: "cf-access-authenticated-user-email",
            cloudflareAccessOidc: oidcProvider,
          },
        },
      };
      const app = setup({}, config, [{ accountId: 42, profileId: "linked-person" }]);
      const { policy } = app;
      await app.start();
      const invited = await app.execute("visitor_invite", {
        ...(selector === "email"
          ? { email: "alias@example.test" }
          : { github: "invitation-login" }),
        days: 7,
      });
      expect(invited).not.toHaveProperty("isError", true);
      if (selector === "github") {
        expect(invited.details).toMatchObject({
          githubAccountId: 42,
          githubLogin: "invitation-login",
        });
      }
      const key = selector === "email" ? "alias@example.test" : "github:42";
      const recorded = required(await app.store.lookup(key), "Missing invitation grant");
      const grant = { ...recorded, githubLogin: "invitation-login" };
      if (selector === "email") {
        await app.store.register(key, grant);
      }

      const pending = await app.execute("visitor_list");
      expect(pending.details).not.toHaveProperty("grants.0.githubLogin");
      expect(pending.content).toEqual(textContaining("Verified GitHub: unavailable"));
      expect(pending.content).toEqual(textContaining("first sign-in pending"));

      await app.execute("visitor_invite", {
        email: "unrelated@example.test",
        days: 7,
      });
      const otherRecorded = required(
        await app.store.lookup("unrelated@example.test"),
        "Missing unrelated invitation grant",
      );
      const otherGrant = { ...otherRecorded, githubLogin: "current-person" };
      await app.store.register("unrelated@example.test", otherGrant);
      let listedGrant: VisitorListDetails["grants"][number] | undefined;
      for (const login of ["verified-person", null, "current-person"]) {
        app.setProfiles([
          {
            id: "linked-person",
            emails: ["primary@example.test", "alias@example.test"],
            githubIdentity: login ? { login } : null,
          },
          {
            id: "unrelated-person",
            emails: ["unrelated@example.test"],
            githubIdentity: { login: "other-person" },
          },
        ]);
        const listed = await app.execute("visitor_list");
        expect(listed.content).toEqual(
          textContaining(`Verified GitHub: ${login ? `@${login}` : "unavailable"}`),
        );
        expect(listed.content).not.toEqual(textContaining("first sign-in pending"));
        expect(listed.content).not.toEqual(textContaining("invitation-login"));
        if (!Value.Check(visitorListDetailsSchema, listed.details)) {
          throw new Error("Invalid visitor_list details");
        }
        const target = listed.details.grants.find((entry) => entry.grantId === grant.grantId);
        expect(target).toMatchObject({
          ...(selector === "email" ? { email: "alias@example.test" } : { githubAccountId: 42 }),
          profileId: "linked-person",
          ...(login ? { githubLogin: login } : {}),
        });
        if (!login) {
          expect(target).not.toHaveProperty("githubLogin");
        }
        listedGrant = target;
      }
      expect(await app.store.lookup(key)).toEqual(grant);
      policy.fetcher.mockClear();
      const revoked = await app.execute("visitor_revoke", {
        profileId: required(listedGrant, "Missing listed grant").profileId,
      });
      expect(revoked.details).toEqual({
        outcome: "revoked",
        emails: selector === "email" ? ["alias@example.test"] : [],
        ...(selector === "github" ? { githubAccountIds: [42] } : {}),
      });
      expect(await app.store.lookup(key)).toBeUndefined();
      expect(await app.store.lookup("unrelated@example.test")).toEqual(otherGrant);
      expect(policy.emails()).toEqual(["unrelated@example.test"]);
      expect(
        policy.fetcher.mock.calls.filter(
          ([input]) => requestUrl(input).hostname === "api.github.com",
        ),
      ).toHaveLength(0);
    },
  );

  async function startVisitors() {
    const emails = [
      "first@example.test",
      "alias@example.test",
      "staff@example.test",
      "pending@example.test",
    ] as const;
    const app = setup({}, gatewayConfig, [], [...emails, "manual@example.test"]);
    const profiles = [
      { id: "visitor-profile", emails: emails.slice(0, 2) },
      { id: "staff-profile", emails: [emails[2]], role: "staff" },
    ];
    app.setProfiles(profiles);
    await app.start();
    for (const email of emails) {
      expect(
        await app.execute("visitor_invite", {
          email,
          ...(email === emails[0] ? { forever: true } : {}),
        }),
      ).not.toHaveProperty("isError");
    }
    app.policy.fetcher.mockClear();
    return { ...app, profiles, emails };
  }

  it("distinguishes person-wide revocation from exact pending invitation cancellation", async () => {
    const app = await startVisitors();
    const [first, alias, staff, pending] = app.emails;
    const pendingGrant = await app.store.lookup(pending);
    expect(pendingGrant?.grantId).toEqual(expect.any(String));
    const listed = await app.execute("visitor_list");
    expect(listed.details).toMatchObject({
      grants: [
        { email: alias, profileId: "visitor-profile", grantId: expect.any(String) },
        { email: first, profileId: "visitor-profile", grantId: expect.any(String) },
        { email: pending, grantId: pendingGrant?.grantId },
        { email: staff, profileId: "staff-profile", grantId: expect.any(String) },
      ],
    });
    if (!Value.Check(visitorListDetailsSchema, listed.details)) {
      throw new Error("Invalid visitor_list details");
    }
    const listedPending = listed.details.grants.find((grant) => grant.email === pending);
    const listedPerson = listed.details.grants.find((grant) => grant.email === first);
    if (!listedPending?.grantId || !listedPerson?.profileId) {
      throw new Error("Missing listed revocation selectors");
    }
    const authorities = [first, alias].map((email) =>
      app.authorize(visitor([email], "visitor-profile", null)),
    );
    expect(authorities.every(Boolean)).toBe(true);
    await app.execute("visitor_invite", { email: pending, days: 30 });
    expect((await app.store.lookup(pending))?.grantId).toBe(pendingGrant?.grantId);
    await expectDetails(app.execute("visitor_revoke", { grantId: listedPending.grantId }), {
      outcome: "revoked",
      emails: [pending],
    });
    expect(app.policy.emails()).toEqual([first, alias, staff, "manual@example.test"]);
    await expectDetails(app.execute("visitor_revoke", { profileId: listedPerson.profileId }), {
      outcome: "revoked",
      emails: [alias, first],
    });
    expect(app.policy.emails()).toEqual([staff, "manual@example.test"]);
    expect((await app.store.entries()).map(({ key }) => key)).toEqual([staff]);
    expect(
      app.authorize({ profileId: "staff-profile", emails: [staff], assignedRole: "staff" }, false),
    ).toBeUndefined();
    for (const authority of authorities) {
      expect(authority?.signal.aborted).toBe(true);
      expect(() => authority?.assertCurrent()).toThrow(/access ended/);
    }
    await app.execute("visitor_invite", { email: pending });
    const replacement = await app.store.lookup(pending);
    expect(replacement?.grantId).not.toBe(pendingGrant?.grantId);
    await expectDetails(app.execute("visitor_revoke", { grantId: listedPending.grantId }), {
      outcome: "not_found",
      emails: [],
    });
    expect(await app.store.lookup(pending)).toEqual(replacement);
    expect(app.policy.emails()).toContain(pending);
  });

  it("ends every selected grant before failed provider cleanup without ending another person's grant", async () => {
    const app = await startVisitors();
    const selected = app.authorize(visitor([app.emails[0]], "visitor-profile", null));
    const other = app.authorize(visitor([app.emails[3]], "pending-profile", null));
    expect(selected && other).toBeTruthy();
    app.policy.controls.failWrites = true;
    expect(await app.execute("visitor_revoke", { profileId: "visitor-profile" })).toHaveProperty(
      "isError",
      true,
    );
    for (const email of app.emails.slice(0, 2)) {
      expect(await app.store.lookup(email)).toMatchObject({ expiresAt: START_MS });
    }
    expect(selected?.signal.aborted).toBe(true);
    expect(() => other?.assertCurrent()).not.toThrow();
    expect(app.policy.emails()).toContain(app.emails[0]);
    app.policy.controls.failWrites = false;
    await expectDetails(app.execute("visitor_revoke", { profileId: "visitor-profile" }), {
      outcome: "revoked",
    });
    expect(app.policy.emails()).toEqual([app.emails[2], app.emails[3], "manual@example.test"]);
  });

  it("rejects changed person bindings after provider reads and ambiguous explicit selectors", async () => {
    const app = await startVisitors();
    const pending = await app.store.lookup(app.emails[3]);
    for (const input of [
      { profileId: "visitor-profile", grantId: pending?.grantId },
      { grantId: pending?.grantId, email: app.emails[3] },
      { profileId: "merged-profile" },
    ]) {
      expect(await app.execute("visitor_revoke", input)).toHaveProperty("isError", true);
    }
    expect(app.policy.fetcher).not.toHaveBeenCalled();
    const original = app.policy.fetcher.getMockImplementation();
    let reassignedAfterRead = false;
    app.policy.fetcher.mockImplementation(async (input, init) => {
      const response = await original!(input, init);
      if (init?.method === "GET") {
        reassignedAfterRead = true;
        app.setProfiles([
          { id: "visitor-profile", emails: [app.emails[1]] },
          {
            id: "staff-profile",
            emails: [app.emails[0], app.emails[2]],
            role: "staff",
          },
        ]);
      }
      return response;
    });
    expect(await app.execute("visitor_revoke", { profileId: "visitor-profile" })).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "Visitor access operation failed. Check gateway health and retry; use visitor_list to inspect drift.",
        },
      ],
    });
    expect(reassignedAfterRead).toBe(true);
    expect(app.policy.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(app.policy.emails()).toEqual([...app.emails, "manual@example.test"]);
    for (const email of app.emails.slice(0, 2)) {
      expect(await app.store.lookup(email)).toMatchObject({ expiresAt: START_MS });
    }
    expect(await app.store.lookup(app.emails[2])).toMatchObject({
      expiresAt: START_MS + 14 * DAY_MS,
    });
    expect(await app.store.lookup(app.emails[3])).toEqual(pending);
  });

  it("denies available visitor tools without trusted owner authority", async () => {
    const app = setup({ senderIsOwner: undefined });
    const { policy } = app;
    await app.start();
    await app.settle();
    policy.fetcher.mockClear();

    for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
      const result = await app.execute(
        name,
        name === "visitor_list" ? {} : { email: "visitor@example.test" },
      );
      expect(result).toMatchObject({
        isError: true,
        content: textContaining("Only administrators"),
      });
    }

    expect(policy.fetcher).not.toHaveBeenCalled();
    expect(app.gatewayRequest).not.toHaveBeenCalled();
    expect(await app.store.entries()).toEqual([]);
  });

  it.each(["invocation", "manager"] as const)(
    "does not renew a grant after %s authority closes during access lookup",
    async (revoked) => {
      let current = true;
      const assertInvocationCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("Invocation is closed");
        }
      });
      const app = setup({ assertInvocationCurrent });
      const { policy } = app;
      await app.start();
      const email = "visitor@example.test";
      await expectDetails(app.execute("visitor_invite", { email, days: 1 }), {
        outcome: "invited",
      });
      policy.fetcher.mockClear();

      await expectDetails(
        app.execute("visitor_invite", { email, days: 2 }),
        { outcome: "renewed" },
        "Renewed",
      );
      const renewed = await app.store.lookup(email);
      expect(renewed).toMatchObject({ createdAt: START_MS, expiresAt: START_MS + 2 * DAY_MS });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      app.gatewayRequest.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { profiles: [] };
      });
      const invitation = app.execute("visitor_invite", { email, days: 30 });
      await entered.promise;
      if (revoked === "invocation") {
        current = false;
      } else {
        app.toolContext.senderIsOwner = false;
      }
      release.resolve();

      await expect(invitation).resolves.toHaveProperty("isError", true);

      expect(policy.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
      expect(policy.emails()).toEqual([email]);
      expect(await app.store.lookup(email)).toEqual(renewed);
      if (revoked === "manager") {
        expect(assertInvocationCurrent).not.toThrow();
      }
    },
  );

  it("gates registered visitor access across restart, expiry, and failed provider revocation", async () => {
    const grants = [
      { email: "expired@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 1_000 },
      { email: "deadline@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 2_000 },
      { email: "revoked@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + DAY_MS },
    ] satisfies VisitorGrant[];
    const first = setup(
      {},
      gatewayConfig,
      [],
      grants.map((grant) => grant.email),
    );
    const { policy } = first;
    for (const grant of grants) {
      await first.store.register(grant.email, grant);
    }
    const profile = visitor(["revoked@example.test"]);
    expect(() => first.authorize(profile)).toThrow(/starting/);
    await first.start();
    await first.settle();
    const original = required(
      first.authorize(profile),
      "Expected visitor authority from the registered policy",
    );
    await first.stop();
    expect(original.signal.aborted).toBe(true);
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + 1_000);
    policy.controls.failWrites = true;

    const restarted = registerPlugin();
    await restarted.start();
    await restarted.settle();
    expect(restarted.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("visitor-access sweep failed"),
    );
    for (const assignedRole of [null, "external-work", "removed-role"]) {
      for (const email of ["missing@example.test", "expired@example.test"]) {
        expect(() => restarted.authorize({ ...profile, emails: [email], assignedRole })).toThrow(
          /active visitor invitation/,
        );
      }
    }
    for (const independent of [
      { profileId: "staff-profile", emails: ["expired@example.test"], assignedRole: "staff" },
      { profileId: "gateway-owner", emails: [], assignedRole: null },
    ]) {
      expect(restarted.authorize(independent, false)).toBeUndefined();
    }
    const deadline = restarted.authorize({
      ...profile,
      emails: ["other-verified@example.test", "deadline@example.test"],
    });
    const revoked = restarted.authorize(profile);
    if (!deadline || !revoked) {
      throw new Error("Expected initialized active visitor grants");
    }
    expect(() => deadline.assertCurrent()).not.toThrow();
    expect(() => revoked.assertCurrent()).not.toThrow();
    await expectDetails(restarted.execute("visitor_revoke", { email: "revoked@example.test" }), {
      error: true,
    });
    expect(revoked.signal.aborted).toBe(true);
    expect(() => revoked.assertCurrent()).toThrow(/access ended/);
    expect(() => restarted.authorize(profile)).toThrow(/active visitor invitation/);
    expect(await restarted.store.lookup("revoked@example.test")).toMatchObject({
      expiresAt: START_MS + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deadline.signal.aborted).toBe(true);
    expect(() => deadline.assertCurrent()).toThrow(/access ended/);
    expect(policy.emails()).toEqual(grants.map((grant) => grant.email));
    expect(await restarted.store.entries()).toHaveLength(grants.length);
  });

  it("revokes persisted expiries after restart, coalesces startup, and continues hourly", async () => {
    const first = setup();
    const { policy } = first;
    await first.start();
    await expectDetails(
      first.execute("visitor_invite", { email: "expired@example.test", days: 1 }),
      { outcome: "invited" },
      "restricted guest",
    );
    await expectDetails(
      first.execute("visitor_invite", { email: "active@example.test", days: 2 }),
      { outcome: "invited" },
    );
    await first.stop();
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + DAY_MS + 1);
    policy.fetcher.mockClear();

    const restarted = registerPlugin();
    await Promise.all([restarted.start(), restarted.gatewayStart()]);
    await restarted.settle();
    expect(policy.emails()).toEqual(["active@example.test"]);
    expect((await restarted.store.entries()).map((entry) => entry.key)).toEqual([
      "active@example.test",
    ]);
    expect(policy.fetcher.mock.calls.filter(([url]) => requestUrl(url).search !== "")).toHaveLength(
      1,
    );
    expect(restarted.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("expired@example.test"),
    );

    vi.setSystemTime(START_MS + 2 * DAY_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await restarted.execute("visitor_list");
    expect(policy.emails()).toEqual([]);
    expect(await restarted.store.entries()).toEqual([]);
    await restarted.stop();
    const callsAfterStop = policy.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(policy.fetcher).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("admits only live grants before provider cleanup and aborts that cleanup on stop", async () => {
    const entered = createDeferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expiry requests must be cancellable");
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)), {
          once: true,
        });
        entered.resolve(signal);
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const app = registerPlugin();
    for (const [email, expiresAt] of [
      ["expired@example.test", START_MS],
      ["active@example.test", START_MS + DAY_MS],
    ] as const) {
      await app.store.register(email, {
        email,
        grantId: "00000000-0000-4000-8000-000000000001",
        createdAt: START_MS - DAY_MS,
        expiresAt,
      });
    }
    await app.start();
    const signal = await entered.promise;
    const profile = { profileId: "visitor", assignedRole: "external-work" };
    expect(() => app.authorize({ ...profile, emails: ["expired@example.test"] })).toThrow(
      /active visitor invitation/,
    );
    const authority = app.authorize({ ...profile, emails: ["active@example.test"] });
    expect(authority).toBeDefined();
    expect(() => authority?.assertCurrent()).not.toThrow();
    await app.stop();
    expect(authority?.signal.aborted).toBe(true);
    expect(signal.aborted).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    expect(vi.getTimerCount()).toBe(0);
    const callsAfterStop = fetcher.mock.calls.length;
    const result = await app.execute("visitor_invite", { email: "late@example.test" });
    expect(result).toMatchObject({ details: { error: true } });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterStop);
    expect(await app.store.entries()).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(app.logger.error).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous invite inactive and sweepable across the registered service restart", async () => {
    const app = setup();
    const { policy } = app;
    await app.start();
    policy.controls.loseWriteResponse = true;
    const result = await app.execute("visitor_invite", { email: "pending@example.test" });
    expect(result).toMatchObject({ details: { error: true }, content: [{ type: "text" }] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await app.store.lookup("pending@example.test")).toMatchObject({
      email: "pending@example.test",
      invitedVia: "agent:main:maintainer",
      expiresAt: START_MS,
    });
    const profile = visitor(["pending@example.test"], "pending-visitor");
    expect(policy.emails()).toEqual(profile.emails);
    expect(() => app.authorize(profile)).toThrow(/active visitor invitation/);
    await app.stop();
    resetPluginStateStoreForTests();
    policy.controls.loseWriteResponse = false;
    const restarted = registerPlugin();
    await restarted.start();
    await restarted.settle();
    expect(() => restarted.authorize(profile)).toThrow(/active visitor invitation/);
    expect(await restarted.store.lookup("pending@example.test")).toBeUndefined();
    expect(policy.emails()).toEqual([]);
  });

  it("routes discovery tools through the Gateway owner and fences them after replacement", async () => {
    const owner = setup();
    const { policy } = owner;
    await owner.start();
    let invite: AnyAgentTool | undefined;
    const discovery = createTestPluginApi({
      registrationMode: "tool-discovery",
      registerTool(registration) {
        const context: OpenClawPluginToolContext<2> = {
          senderIsOwner: true,
          assertInvocationCurrent() {},
        };
        invite =
          resolveTools(registration, context).find((tool) => tool.name === "visitor_invite") ??
          invite;
      },
    });
    Object.defineProperty(discovery, "runtime", {
      get() {
        throw new Error("Discovery must use the active Gateway owner");
      },
    });
    plugin.register(discovery);
    if (!invite) {
      throw new Error("Discovery did not register visitor_invite");
    }
    await expectDetails(invite.execute("invite", { email: "discovered@example.test" }), {
      outcome: "invited",
    });
    expect(await owner.store.lookup("discovered@example.test")).toBeDefined();
    await owner.stop();
    const replacement = registerPlugin();
    await replacement.start();
    await replacement.settle();
    const callsBeforeStaleTool = policy.fetcher.mock.calls.length;
    expect(await invite.execute("stale", { email: "late@example.test" })).toHaveProperty(
      "details.error",
      true,
    );
    expect(policy.fetcher).toHaveBeenCalledTimes(callsBeforeStaleTool);
    expect(
      await replacement.execute("visitor_invite", { email: "current@example.test" }),
    ).toMatchObject({ details: { outcome: "invited" } });
  });
});
