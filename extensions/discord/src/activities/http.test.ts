import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { createDiscordActivityHttpHandler } from "./http.js";
import { DiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startServer(
  runtime: DiscordActivitiesRuntime,
  options: Omit<
    Parameters<typeof createDiscordActivityHttpHandler>[0],
    "runtime" | "vendorAssetPath"
  > & {
    vendorAssetPath?: string;
  } = {},
): Promise<string> {
  const route = createDiscordActivityHttpHandler({
    runtime,
    ...options,
    vendorAssetPath:
      options.vendorAssetPath ?? path.join(os.tmpdir(), "missing-discord-activity-sdk.mjs"),
  });
  const server = createServer((req, res) => {
    void route.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function guardedJsonFetch(params?: {
  tokenStatus?: number;
  userId?: string;
  instanceStatus?: number;
  channelId?: string;
  instanceUsers?: string[];
  onExchange?: (code: string | null) => Promise<number | void> | number | void;
}) {
  return vi.fn(async ({ url, init }: { url: string; init?: RequestInit }) => {
    const wantsExchange = url.includes("/oauth2/token");
    const wantsInstance = url.includes("/activity-instances/");
    const exchangeStatus = wantsExchange
      ? await params?.onExchange?.(
          init?.body instanceof URLSearchParams ? init.body.get("code") : null,
        )
      : undefined;
    const status = wantsExchange
      ? (exchangeStatus ?? params?.tokenStatus ?? 200)
      : wantsInstance
        ? (params?.instanceStatus ?? 200)
        : 200;
    const body = wantsExchange
      ? { access_token: "atoken" }
      : wantsInstance
        ? {
            location: { channel_id: params?.channelId ?? "777" },
            users: params?.instanceUsers ?? ["42"],
          }
        : { id: params?.userId ?? "42", username: "alice", discriminator: "0" };
    return {
      response: new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => undefined),
    };
  }) as unknown as typeof fetchWithSsrFGuard;
}

async function createWidget(
  runtime: DiscordActivitiesRuntime,
  params?: { createdAt?: number; channelId?: string; accountId?: string },
) {
  const createdAt = params?.createdAt ?? 1;
  const widgetId = await runtime.store.createWidget({
    html: "<!doctype html><html><body><script>document.body.dataset.ready='yes'</script></body></html>",
    title: "Activity status",
    channelId: params?.channelId ?? "777",
    accountId: params?.accountId ?? "default",
    createdAt,
  });
  await runtime.store.markWidgetDelivered(
    widgetId,
    String(1_000_000_000_000_000_000n + BigInt(createdAt)),
  );
  return widgetId;
}

function startTokenServer(fetchGuard = guardedJsonFetch()) {
  const cfg = createActivityTestConfig();
  cfg.gateway = { trustedProxies: ["127.0.0.1"] };
  return startServer(createActivityTestRuntime(cfg), { fetchGuard, now: () => 1_000 });
}

const activityOrigin = "https://123456789012345678.discordsays.com";

function tokenSource(index: number, code = "ok") {
  return { code, origin: activityOrigin, forwardedFor: `198.51.100.${index + 1}` };
}

function requestToken(
  base: string,
  params: {
    body?: string;
    code?: string;
    forwardedFor?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  return fetch(`${base}/discord/activity/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.origin ? { Origin: params.origin } : {}),
      ...(params.forwardedFor ? { "X-Forwarded-For": params.forwardedFor } : {}),
    },
    body: params.body ?? JSON.stringify({ code: params.code ?? "oauth-code" }),
  });
}

async function requestTokens(
  base: string,
  count: number,
  params: (index: number) => Parameters<typeof requestToken>[1],
  status: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    expect((await requestToken(base, params(index))).status).toBe(status);
  }
}

async function expectWidget(response: Response, id: string) {
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ id });
}

function requestWidget(base: string, query: string, sessionToken?: string): Promise<Response> {
  return fetch(
    `${base}/discord/activity/api/widget?${query}`,
    sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : undefined,
  );
}

function recordPendingLaunch(
  runtime: DiscordActivitiesRuntime,
  widgetId: string,
  createdAt: number,
  accountId = "default",
) {
  return runtime.store.recordPendingLaunch({
    accountId,
    channelId: "777",
    discordUserId: "42",
    widgetId,
    createdAt,
  });
}

function consumePendingLaunch(runtime: DiscordActivitiesRuntime, accountId = "default") {
  return runtime.store.consumePendingLaunch(accountId, "777", "42");
}

async function createWidgetFixture(
  options: Parameters<typeof startServer>[1] = { fetchGuard: guardedJsonFetch() },
) {
  const runtime = createActivityTestRuntime();
  const session = await runtime.store.createSession({ discordUserId: "42", accountId: "default" });
  const base = await startServer(runtime, options);
  const request = (query: string) => requestWidget(base, query, session);
  return {
    base,
    runtime,
    widget: (params?: Parameters<typeof createWidget>[1]) => createWidget(runtime, params),
    request,
    customId: (id: string) =>
      request(
        `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(id))}&instance_id=instance-1`,
      ),
    recordPending: (widgetId: string, createdAt = 3) =>
      recordPendingLaunch(runtime, widgetId, createdAt),
    consumePending: () => consumePendingLaunch(runtime),
  };
}

describe("Discord Activity HTTP OAuth", () => {
  it("leaves the public prefix externally absent when the bot token is unresolved", async () => {
    const cfg = createActivityTestConfig();
    const config = {
      ...cfg,
      channels: {
        discord: {
          ...cfg.channels?.discord,
          token: { source: "env" as const, provider: "default", id: "DISCORD_BOT_TOKEN" },
        },
      },
    };
    const base = await startServer(createActivityTestRuntime(config));

    const response = await fetch(`${base}/discord/activity/`);
    await expect(response.text()).resolves.toBe("not found");
    expect(response.status).toBe(404);
  });

  it.each([
    {
      name: "413 when the token body exceeds its limit",
      bodyTimeoutMs: 5_000,
      // Declared and sent in one write: the shape whose rejection used to race the flush.
      body: JSON.stringify({ code: "x".repeat(8 * 1024) }),
      contentLength: undefined,
      statusLine: "HTTP/1.1 413 Payload Too Large",
      error: "request body too large",
    },
    {
      name: "408 when the sender stalls mid-upload",
      bodyTimeoutMs: 50,
      // Promises more than is ever sent, so the read deadline fires with the request open.
      body: "{",
      contentLength: 4 * 1024,
      statusLine: "HTTP/1.1 408 Request Timeout",
      error: "request body timeout",
    },
  ])("delivers $name and then closes the connection", async (scenario) => {
    const base = await startServer(createActivityTestRuntime(), {
      bodyTimeoutMs: scenario.bodyTimeoutMs,
    });

    const result = await postRawWebhook({
      url: `${base}/discord/activity/api/token`,
      body: scenario.body,
      contentLength: scenario.contentLength,
      headers: { "content-type": "application/json" },
    });

    expect(result.statusLine).toBe(scenario.statusLine);
    expect(JSON.parse(result.body)).toEqual({ error: scenario.error });
    expect(result.closedByServer).toBe(true);
  });

  it("lets a channel member outside the agent allowlist open the widget", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ userId: "99", instanceUsers: ["99"] }),
    });
    const response = await requestToken(base);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { session_token: string };

    await expectWidget(
      await requestWidget(
        base,
        `custom_id=${widgetId}&instance_id=instance-1`,
        token.session_token,
      ),
      widgetId,
    );
  });

  it("limits token requests to ten per source IP per minute", async () => {
    const base = await startServer(createActivityTestRuntime(), { now: () => 1_000 });
    await requestTokens(base, 10, () => ({ body: "{}" }), 401);
    const limited = await requestToken(base, { body: "{}" });
    expect(limited.status).toBe(429);
  });

  it("does not charge malformed or unresolved requests to the global budget", async () => {
    const base = await startTokenServer();
    await requestTokens(
      base,
      61,
      (index) => ({
        body: "{}",
        origin: `https://${100_000_000_000_000_000n + BigInt(index)}.discordsays.com`,
        forwardedFor: `198.51.100.${index + 1}`,
      }),
      503,
    );
    await requestTokens(
      base,
      61,
      (index) => ({
        body: "{}",
        origin: activityOrigin,
        forwardedFor: `203.0.113.${index + 1}`,
      }),
      401,
    );
    const legitimate = await requestToken(base, tokenSource(249));
    expect(legitimate.status).toBe(200);
  });

  it("does not charge Discord-rejected codes to the global budget", async () => {
    const base = await startTokenServer(
      guardedJsonFetch({
        onExchange: (code) => (code === "bogus" ? 400 : 200),
      }),
    );
    await requestTokens(base, 61, (index) => tokenSource(index, "bogus"), 401);
    const legitimate = await requestToken(base, tokenSource(249));
    expect(legitimate.status).toBe(200);
  });

  it("limits valid token exchanges globally across rotating source IPs", async () => {
    const base = await startTokenServer();
    await requestTokens(base, 60, tokenSource, 200);
    const limited = await requestToken(base, tokenSource(249));
    expect(limited.status).toBe(429);
  });

  it("reserves global capacity before concurrent exchanges complete", async () => {
    let releaseExchanges = () => {};
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchanges = resolve;
    });
    let exchangeCalls = 0;
    const guard = guardedJsonFetch({
      onExchange: async () => {
        exchangeCalls += 1;
        await exchangeGate;
      },
    });
    const base = await startTokenServer(guard);
    const pending = Array.from({ length: 60 }, (_, index) =>
      requestToken(base, tokenSource(index)),
    );
    let limited: Response;
    try {
      await vi.waitFor(() => expect(exchangeCalls).toBe(60), { timeout: 5_000 });
      limited = await requestToken(base, tokenSource(249));
    } finally {
      releaseExchanges();
    }
    expect(limited.status).toBe(429);
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });
});

describe("Discord Activity widget routes", () => {
  it("requires a valid bearer session", async () => {
    const base = await startServer(createActivityTestRuntime());
    expect((await requestWidget(base, "instance_id=abc")).status).toBe(401);
    expect((await requestWidget(base, "instance_id=abc", "a".repeat(43))).status).toBe(401);
  });

  it("resolves a custom ID in the validated instance channel and consumes its doc token", async () => {
    const fixture = await createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(firstId);

    const direct = await fixture.customId(firstId);
    expect(direct.status).toBe(200);
    const metadata = (await direct.json()) as { id: string; docUrl: string };
    expect(metadata.id).toBe(firstId);
    await expect(fixture.consumePending()).resolves.toBeUndefined();
    const documentUrl = new URL(metadata.docUrl, fixture.base);
    const firstDocument = await fetch(documentUrl);
    expect(firstDocument.status).toBe(200);
    const firstCsp = firstDocument.headers.get("content-security-policy");
    expect(firstCsp).toContain("sandbox allow-scripts");
    expect(firstCsp).toContain("connect-src 'none'");
    expect(firstCsp).toContain("https://cdn.jsdelivr.net");
    expect(firstCsp).toContain("https://fonts.googleapis.com");
    expect(firstCsp).toContain("https://fonts.gstatic.com");
    expect(await firstDocument.text()).toContain("document.body.dataset.ready");
    const secondDocument = await fetch(documentUrl);
    expect(secondDocument.status).toBe(404);
    const secondCsp = secondDocument.headers.get("content-security-policy");
    expect(secondCsp).toContain("sandbox allow-scripts");
    expect(secondCsp).toContain("connect-src 'none'");
  });

  it("keeps a different-widget pending launch when a custom ID resolves", async () => {
    const fixture = await createWidgetFixture();
    const requestedId = await fixture.widget({ createdAt: 1 });
    const pendingId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    await expectWidget(await fixture.customId(requestedId), requestedId);
    await expect(fixture.consumePending()).resolves.toMatchObject({ widgetId: pendingId });
  });

  it("falls through to the newest widget when overlapping launches target different widgets", async () => {
    const fixture = await createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await Promise.all([fixture.recordPending(firstId, 3), fixture.recordPending(newestId, 4)]);

    await expectWidget(await fixture.request("instance_id=instance-1"), newestId);
    await expect(fixture.consumePending()).resolves.toBeUndefined();
  });

  it("keeps a pending launch when the same widget is clicked twice", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime, { createdAt: 1 });
    await recordPendingLaunch(runtime, widgetId, 2);
    await recordPendingLaunch(runtime, widgetId, 3);

    await expect(consumePendingLaunch(runtime)).resolves.toMatchObject({ widgetId });
  });

  it("consumes a pending launch after one widget resolution", async () => {
    const fixture = await createWidgetFixture();
    const pendingId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    await expectWidget(
      await fixture.request("custom_id=ocactivity1_mangled&instance_id=instance-1"),
      pendingId,
    );
    await expectWidget(await fixture.request("instance_id=instance-1"), newestId);
  });

  it("keeps pending launches isolated by Discord account", async () => {
    const runtime = createActivityTestRuntime();
    await recordPendingLaunch(runtime, "AAAAAAAAAAAAAAAAAAAAAA", 1, "account-b");

    await expect(consumePendingLaunch(runtime, "account-a")).resolves.toBeUndefined();
    await expect(consumePendingLaunch(runtime, "account-b")).resolves.toMatchObject({
      widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("keeps the newest-widget fallback when pending launch lookup fails", async () => {
    const logError = vi.fn();
    const fixture = await createWidgetFixture({ fetchGuard: guardedJsonFetch(), logError });
    await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    const pendingLaunchLookup = vi
      .spyOn(fixture.runtime.store, "consumePendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    for (let index = 0; index < 2; index += 1) {
      await expectWidget(
        await fixture.request("custom_id=missing&instance_id=instance-1"),
        newestId,
      );
    }
    expect(pendingLaunchLookup).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("rejects a custom ID outside the validated instance channel", async () => {
    const fixture = await createWidgetFixture({
      fetchGuard: guardedJsonFetch({ channelId: "777" }),
    });
    const widgetId = await fixture.widget({ channelId: "888" });
    const response = await fixture.request(`custom_id=${widgetId}&instance_id=instance-1`);

    expect(response.status).toBe(404);
  });

  it("ignores a forged channel ID when no Activity instance is supplied", async () => {
    const fixture = await createWidgetFixture({});
    await fixture.widget();
    const response = await fixture.request("channel_id=777");
    expect(response.status).toBe(404);
  });

  it("uses the Activity Instance API channel when exactly one widget matches", async () => {
    const guard = guardedJsonFetch({ channelId: "777" });
    const fixture = await createWidgetFixture({ fetchGuard: guard });
    await fixture.widget({ channelId: "888", createdAt: 1 });
    const newestId = await fixture.widget({ channelId: "777", createdAt: 2 });
    const response = await fixture.request(
      "custom_id=missing&instance_id=instance-1&channel_id=888",
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({ id: newestId });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://discord.com/api/v10/applications/123456789012345678/activity-instances/instance-1",
        init: expect.objectContaining({ headers: { Authorization: "Bot testtok" } }),
      }),
    );
  });

  it("returns 404 for a custom ID when the session user is absent from the Activity instance", async () => {
    const fixture = await createWidgetFixture({
      fetchGuard: guardedJsonFetch({ instanceUsers: ["99"] }),
    });
    const widgetId = await fixture.widget();
    const response = await fixture.request(`custom_id=${widgetId}&instance_id=instance-1`);
    expect(response.status).toBe(404);
  });
});

describe("Discord Activity shell assets", () => {
  it("serves the generated SDK from a dist plugin root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-activity-dist-"));
    const vendorAssetPath = path.join(root, "dist/extensions/discord/assets/embedded-app-sdk.mjs");
    try {
      await fs.mkdir(path.dirname(vendorAssetPath), { recursive: true });
      await fs.writeFile(vendorAssetPath, "export class DiscordSDK {}\n");
      const base = await startServer(createActivityTestRuntime(), { vendorAssetPath });

      const vendor = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
      expect(vendor.status).toBe(200);
      await expect(vendor.text()).resolves.toContain("DiscordSDK");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves the shell and module", async () => {
    const base = await startServer(createActivityTestRuntime());
    const shell = await fetch(`${base}/discord/activity/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<script type="module" src="./shell.js">');
    const script = await fetch(`${base}/discord/activity/shell.js`);
    const scriptBody = await script.text();
    expect(scriptBody).toContain('from "./vendor/embedded-app-sdk.mjs"');
    expect(scriptBody).toContain("url.pathname.slice(gatewayPrefix.length)");
    expect(scriptBody).toContain("instance_id: sdk.instanceId");
    expect(scriptBody).not.toContain("channel_id: sdk.channelId");
    expect(scriptBody).toContain('frame.setAttribute("sandbox", "allow-scripts")');
  });

  it("retries the vendor asset read after a transient failure", async () => {
    const readVendorAsset = vi
      .fn<(assetPath: string) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValue(Buffer.from("export class DiscordSDK {}\n"));
    const base = await startServer(createActivityTestRuntime(), { readVendorAsset });

    const first = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(first.status).toBe(404);
    const second = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(second.status).toBe(200);
    await expect(second.text()).resolves.toContain("DiscordSDK");
    expect(readVendorAsset).toHaveBeenCalledTimes(2);
  });
});
