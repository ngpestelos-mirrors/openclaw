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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
const address = (name: string) => `${name}@example.test`;
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
function required<T>(value: T | undefined): T {
  if (!value) {
    throw new Error("Missing required visitor test fixture value");
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
  const value = await result;
  expect(value).toMatchObject({
    details,
    ...(text ? { content: textContaining(text) } : {}),
  });
  return value;
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
            Type.Const({
              oidc: {
                identity_provider_id: "test-oidc",
                claim_name: "github_id",
                claim_value: "42",
              },
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
  const service = required(services[0]);
  const accessPolicy = required(accessPolicies[0]);
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
  const execute = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = required(tools.get(name));
    const result = await tool.execute("visitor-test-call", input);
    const schema = required(tool.outputSchema);
    expect(Value.Check(schema, result.details)).toBe(true);
    return result;
  };
  return {
    execute,
    invite: (input: Record<string, unknown>, outcome = "invited", text?: string) =>
      expectDetails(execute("visitor_invite", input), { outcome }, text),
    revoke: (input: Record<string, unknown>, emails?: string[], outcome = "revoked") =>
      expectDetails(execute("visitor_revoke", input), { outcome, ...(emails ? { emails } : {}) }),
    list: () => execute("visitor_list"),
    lookup: store.lookup.bind(store),
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
      const hook = required(on.mock.calls.find(([name]) => name === "gateway_start")?.[1]);
      const startHook = hook as (
        event: { port: number },
        context: { port?: number },
      ) => void | Promise<void>;
      return startHook({ port: 18789 }, {});
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

it("isolates CLI metadata discovery from runtime and timers", () => {
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
  "lists verified %s identities and revokes by listed profileId",
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
    const invited = await app.invite({
      ...(selector === "email" ? { email: address("alias") } : { github: "invitation-login" }),
      days: 7,
    });
    expect(invited).not.toHaveProperty("isError", true);
    if (selector === "github") {
      expect(invited.details).toMatchObject({
        githubAccountId: 42,
        githubLogin: "invitation-login",
      });
    }
    const key = selector === "email" ? address("alias") : "github:42";
    const recorded = required(await app.lookup(key));
    const grant = { ...recorded, githubLogin: "invitation-login" };
    if (selector === "email") {
      await app.store.register(key, grant);
    }

    const pending = await app.list();
    expect(pending.details).not.toHaveProperty("grants.0.githubLogin");
    expect(pending.content).toEqual(textContaining("Verified GitHub: unavailable"));
    expect(pending.content).toEqual(textContaining("first sign-in pending"));

    await app.invite({ email: address("unrelated"), days: 7 });
    const otherRecorded = required(await app.lookup(address("unrelated")));
    const otherGrant = { ...otherRecorded, githubLogin: "current-person" };
    await app.store.register(address("unrelated"), otherGrant);
    let listedGrant: VisitorListDetails["grants"][number] | undefined;
    for (const login of ["verified-person", null, "current-person"]) {
      app.setProfiles([
        {
          id: "linked-person",
          emails: [address("primary"), address("alias")],
          githubIdentity: login ? { login } : null,
        },
        {
          id: "unrelated-person",
          emails: [address("unrelated")],
          githubIdentity: { login: "other-person" },
        },
      ]);
      const listed = await app.list();
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
        ...(selector === "email" ? { email: address("alias") } : { githubAccountId: 42 }),
        profileId: "linked-person",
        ...(login ? { githubLogin: login } : {}),
      });
      if (!login) {
        expect(target).not.toHaveProperty("githubLogin");
      }
      listedGrant = target;
    }
    expect(await app.lookup(key)).toEqual(grant);
    policy.fetcher.mockClear();
    const revoked = await app.execute("visitor_revoke", {
      profileId: required(listedGrant).profileId,
    });
    expect(revoked.details).toEqual({
      outcome: "revoked",
      emails: selector === "email" ? [address("alias")] : [],
      ...(selector === "github" ? { githubAccountIds: [42] } : {}),
    });
    expect(await app.lookup(key)).toBeUndefined();
    expect(await app.lookup(address("unrelated"))).toEqual(otherGrant);
    expect(policy.emails()).toEqual([address("unrelated")]);
    expect(
      policy.fetcher.mock.calls.filter(
        ([input]) => requestUrl(input).hostname === "api.github.com",
      ),
    ).toHaveLength(0);
  },
);

async function startVisitors() {
  const emails = [
    address("first"),
    address("alias"),
    address("staff"),
    address("pending"),
  ] as const;
  const app = setup({}, gatewayConfig, [], [...emails, address("manual")]);
  app.setProfiles([
    { id: "visitor-profile", emails: emails.slice(0, 2) },
    { id: "staff-profile", emails: [emails[2]], role: "staff" },
  ]);
  await app.start();
  for (const email of emails) {
    expect(
      await app.invite({ email, ...(email === emails[0] ? { forever: true } : {}) }),
    ).not.toHaveProperty("isError");
  }
  app.policy.fetcher.mockClear();
  return { ...app, emails };
}

it("separates person revocation from pending invitation cancellation", async () => {
  const app = await startVisitors();
  const [first, alias, staff, pending] = app.emails;
  const pendingGrant = await app.lookup(pending);
  expect(pendingGrant?.grantId).toEqual(expect.any(String));
  const listed = await app.list();
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
  await app.invite({ email: pending, days: 30 }, "renewed");
  expect((await app.lookup(pending))?.grantId).toBe(pendingGrant?.grantId);
  await app.revoke({ grantId: listedPending.grantId }, [pending]);
  expect(app.policy.emails()).toEqual([first, alias, staff, address("manual")]);
  await app.revoke({ profileId: listedPerson.profileId }, [alias, first]);
  expect(app.policy.emails()).toEqual([staff, address("manual")]);
  expect((await app.store.entries()).map(({ key }) => key)).toEqual([staff]);
  expect(
    app.authorize({ profileId: "staff-profile", emails: [staff], assignedRole: "staff" }, false),
  ).toBeUndefined();
  for (const authority of authorities) {
    expect(authority?.signal.aborted).toBe(true);
    expect(() => authority?.assertCurrent()).toThrow(/access ended/);
  }
  await app.invite({ email: pending });
  const replacement = await app.lookup(pending);
  expect(replacement?.grantId).not.toBe(pendingGrant?.grantId);
  await app.revoke({ grantId: listedPending.grantId }, [], "not_found");
  expect(await app.lookup(pending)).toEqual(replacement);
  expect(app.policy.emails()).toContain(pending);
});

it("ends only selected grants before failed provider cleanup", async () => {
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
    expect(await app.lookup(email)).toMatchObject({ expiresAt: START_MS });
  }
  expect(selected?.signal.aborted).toBe(true);
  expect(() => selected?.assertCurrent()).toThrow(/access ended/);
  expect(() => app.authorize(visitor([app.emails[0]], "visitor-profile", null))).toThrow(
    /active visitor invitation/,
  );
  expect(() => other?.assertCurrent()).not.toThrow();
  expect(app.policy.emails()).toContain(app.emails[0]);
  app.policy.controls.failWrites = false;
  await app.revoke({ profileId: "visitor-profile" });
  expect(app.policy.emails()).toEqual([app.emails[2], app.emails[3], address("manual")]);
});

it("rejects ambiguous selectors and sanitizes profile lookup failures", async () => {
  const app = await startVisitors();
  const pending = await app.lookup(app.emails[3]);
  for (const input of [
    { profileId: "visitor-profile", grantId: pending?.grantId },
    { grantId: pending?.grantId, email: app.emails[3] },
    { profileId: "merged-profile" },
  ]) {
    expect(await app.execute("visitor_revoke", input)).toHaveProperty("isError", true);
  }
  expect(app.policy.fetcher).not.toHaveBeenCalled();
  app.gatewayRequest.mockRejectedValueOnce(new Error(`Profile lookup failed: ${TOKEN}`));
  const result = await app.execute("visitor_revoke", { profileId: "visitor-profile" });
  expect(result).toMatchObject({
    isError: true,
    content: [
      {
        type: "text",
        text: "Visitor access operation failed. Check gateway health and retry; use visitor_list to inspect drift.",
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(app.policy.fetcher).not.toHaveBeenCalled();
  expect(app.policy.emails()).toEqual([...app.emails, address("manual")]);
  expect(await app.lookup(app.emails[3])).toEqual(pending);
});

it("denies visitor tools without owner authority", async () => {
  const app = setup({ senderIsOwner: undefined });
  const { policy } = app;
  await app.start();
  await app.settle();
  policy.fetcher.mockClear();

  for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
    const result = await app.execute(
      name,
      name === "visitor_list" ? {} : { email: address("visitor") },
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
  "rejects renewal when %s authority closes during lookup",
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
    const email = address("visitor");
    await app.invite({ email, days: 1 });
    policy.fetcher.mockClear();

    await app.invite({ email, days: 2 }, "renewed", "Renewed");
    const renewed = await app.lookup(email);
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
    expect(await app.lookup(email)).toEqual(renewed);
    if (revoked === "manager") {
      expect(assertInvocationCurrent).not.toThrow();
    }
  },
);

it.each([false, true])(
  "coalesces startup and expiry sweeps (provider fails: %s)",
  async (failWrites) => {
    const first = setup();
    const { policy } = first;
    expect(() => first.authorize(visitor([address("active")]))).toThrow(/starting/);
    await first.start();
    await first.invite({ email: address("expired"), days: 1 }, "invited", "restricted guest");
    await first.invite({ email: address("active"), days: 2 });
    const original = required(first.authorize(visitor([address("active")])));
    await first.stop();
    expect(original.signal.aborted).toBe(true);
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + DAY_MS + 1);
    policy.fetcher.mockClear();
    policy.controls.failWrites = failWrites;

    const restarted = registerPlugin();
    await Promise.all([restarted.start(), restarted.gatewayStart()]);
    await restarted.settle();
    const retained = failWrites ? [address("expired"), address("active")] : [address("active")];
    expect(policy.emails()).toEqual(retained);
    expect((await restarted.store.entries()).map((entry) => entry.key).toSorted()).toEqual(
      retained.toSorted(),
    );
    expect(() => restarted.authorize(visitor([address("expired")]))).toThrow(
      /active visitor invitation/,
    );
    const active = required(
      restarted.authorize(visitor([address("other-verified"), address("active")])),
    );
    expect(() => active.assertCurrent()).not.toThrow();
    expect(policy.fetcher.mock.calls.filter(([url]) => requestUrl(url).search !== "")).toHaveLength(
      1,
    );
    if (failWrites) {
      expect(restarted.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("visitor-access sweep failed"),
      );
    } else {
      expect(restarted.logger.info).toHaveBeenCalledWith(
        expect.stringContaining(address("expired")),
      );
    }

    policy.controls.failWrites = false;
    vi.setSystemTime(START_MS + 2 * DAY_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await restarted.list();
    expect(active.signal.aborted).toBe(true);
    expect(() => active.assertCurrent()).toThrow(/access ended/);
    expect(policy.emails()).toEqual([]);
    expect(await restarted.store.entries()).toEqual([]);
    await restarted.stop();
    const callsAfterStop = policy.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(policy.fetcher).toHaveBeenCalledTimes(callsAfterStop);
  },
);

it("admits live grants during cleanup and aborts cleanup on stop", async () => {
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
    [address("expired"), START_MS],
    [address("active"), START_MS + DAY_MS],
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
  for (const assignedRole of [null, "external-work", "removed-role"]) {
    for (const email of [address("missing"), address("expired")]) {
      expect(() => app.authorize({ ...profile, emails: [email], assignedRole })).toThrow(
        /active visitor invitation/,
      );
    }
  }
  for (const independent of [
    visitor([address("expired")], "staff-profile", "staff"),
    visitor([], "gateway-owner", null),
  ]) {
    expect(app.authorize(independent, false)).toBeUndefined();
  }
  const authority = app.authorize({ ...profile, emails: [address("active")] });
  expect(authority).toBeDefined();
  expect(() => authority?.assertCurrent()).not.toThrow();
  await app.stop();
  expect(authority?.signal.aborted).toBe(true);
  expect(signal.aborted).toBe(true);
  await closeOpenClawStateDatabaseAsync();
  expect(vi.getTimerCount()).toBe(0);
  const callsAfterStop = fetcher.mock.calls.length;
  const result = await app.execute("visitor_invite", { email: address("late") });
  expect(result).toMatchObject({ details: { error: true } });
  expect(fetcher).toHaveBeenCalledTimes(callsAfterStop);
  expect(await app.store.entries()).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(app.logger.error).not.toHaveBeenCalled();
});

it("keeps ambiguous invites inactive and sweepable across restart", async () => {
  const app = setup();
  const { policy } = app;
  await app.start();
  policy.controls.loseWriteResponse = true;
  const result = await app.execute("visitor_invite", { email: address("pending") });
  expect(result).toMatchObject({ details: { error: true }, content: [{ type: "text" }] });
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(await app.lookup(address("pending"))).toMatchObject({
    email: address("pending"),
    invitedVia: "agent:main:maintainer",
    expiresAt: START_MS,
  });
  const profile = visitor([address("pending")], "pending-visitor");
  expect(policy.emails()).toEqual(profile.emails);
  expect(() => app.authorize(profile)).toThrow(/active visitor invitation/);
  await app.stop();
  resetPluginStateStoreForTests();
  policy.controls.loseWriteResponse = false;
  const restarted = registerPlugin();
  await restarted.start();
  await restarted.settle();
  expect(() => restarted.authorize(profile)).toThrow(/active visitor invitation/);
  expect(await restarted.lookup(address("pending"))).toBeUndefined();
  expect(policy.emails()).toEqual([]);
});

it("binds discovered tools to the Gateway owner until replacement", async () => {
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
  await expectDetails(invite.execute("invite", { email: address("discovered") }), {
    outcome: "invited",
  });
  expect(await owner.lookup(address("discovered"))).toBeDefined();
  await owner.stop();
  const replacement = registerPlugin();
  await replacement.start();
  await replacement.settle();
  const callsBeforeStaleTool = policy.fetcher.mock.calls.length;
  expect(await invite.execute("stale", { email: address("late") })).toHaveProperty(
    "details.error",
    true,
  );
  expect(policy.fetcher).toHaveBeenCalledTimes(callsBeforeStaleTool);
  await replacement.invite({ email: address("current") });
});
