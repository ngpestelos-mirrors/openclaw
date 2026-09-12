import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { readPersistedSharedAuthProfileStateRaw } from "../../../../src/agents/auth-profiles/sqlite.js";
import { coerceAuthProfileState } from "../../../../src/agents/auth-profiles/state.js";
import { connectGatewayClient } from "../../../../src/gateway/test-helpers.e2e.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";

const MODEL = "openai/gpt-5.5";
const UTILITY_MODEL_ID = "quota-test-utility";
const PROFILE_ID = "openai:quota";
const ACCOUNT_ID = "quota-test-account";
const MARKER = "QUOTA_TURN_OK";
const RECHECK_ADVANCE_MS = 300_100;
type BlockSource = "wham" | "codex_rate_limits";
type Phase =
  | "healthy"
  | "initial-exhaustion"
  | "ordinary-rate-limit"
  | "ordinary-rate-limit-with-capacity"
  | "ordinary-rate-limit-with-exhausted-usage"
  | "exhausted"
  | "additional-exhaustion"
  | "workspace-exhaustion"
  | "spending-exhaustion"
  | "malformed-usage"
  | "restored"
  | "revoked";
type RequestRecord = {
  phase: Phase;
  transport: "http" | "websocket";
  path: string;
  method: string | undefined;
  headers: IncomingMessage["headers"];
  rawHeaders: string[];
  body: string | undefined;
  bodyBase64?: string;
  authorization: string | undefined;
  accountId: string | string[] | undefined;
};
type ChatHistory = {
  messages: Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
  }>;
};
type HeldUsageResponse = {
  phase: Phase;
  path: string;
  status: number;
  body: string;
  capturedAt: number;
  releasedAt?: number;
  releaseReason?: "explicit" | "deadline" | "aborted";
};

function syntheticAccessToken(expires = Date.UTC(2036, 0, 1)) {
  return [
    { alg: "none" },
    {
      "https://api.openai.com/auth": {
        chatgpt_account_id: ACCOUNT_ID,
        chatgpt_user_id: "quota-test-user",
        chatgpt_plan_type: "pro",
      },
      exp: Math.floor(expires / 1000),
      email: "quota@example.invalid",
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .concat("synthetic")
    .join(".");
}

function assistantTexts(history: ChatHistory): string[] {
  return history.messages
    .filter((message) => message.role === "assistant")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n"),
    );
}

async function startQuotaProvider(source: BlockSource) {
  let phase: Phase = "healthy";
  let nextSuccessObserver: (() => void) | undefined;
  let nextUsageHold: { arrived: Deferred<HeldUsageResponse>; released: Deferred<void> } | undefined;
  const heldUsageResponses: HeldUsageResponse[] = [];
  const resetAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const requests: RequestRecord[] = [];
  const responses: Array<{
    phase: Phase;
    path: string;
    value: unknown;
    headers?: Record<string, string>;
  }> = [];
  const errors: string[] = [];
  const primaryExhausted = () => phase === "initial-exhaustion" || phase === "exhausted";
  const exhausted = () => phase !== "healthy" && phase !== "restored" && phase !== "revoked";
  const recordRequest = (
    request: IncomingMessage,
    body: string | undefined,
    transport: RequestRecord["transport"],
    bodyBytes?: Buffer,
  ) => {
    requests.push({
      phase,
      transport,
      path: request.url ?? "",
      method: request.method,
      headers: request.headers,
      rawHeaders: request.rawHeaders,
      body,
      bodyBase64: bodyBytes?.toString("base64"),
      authorization: request.headers.authorization,
      accountId: request.headers["chatgpt-account-id"],
    });
  };
  const usage = () => {
    const usageExhausted =
      primaryExhausted() || phase === "ordinary-rate-limit-with-exhausted-usage";
    const window = (seconds: number, usedPercent = usageExhausted ? 100 : 2) => ({
      used_percent: usedPercent,
      limit_window_seconds: seconds,
      reset_at: resetAt,
      reset_after_seconds: resetAt - Math.floor(Date.now() / 1000),
    });
    return {
      plan_type: "pro",
      rate_limit: {
        allowed: !usageExhausted,
        limit_reached: usageExhausted,
        primary_window: window(18_000),
        secondary_window: window(604_800),
      },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      additional_rate_limits:
        phase === "additional-exhaustion"
          ? [
              {
                limit_name: "Additional Codex capacity",
                metered_feature: "codex_other",
                rate_limit: {
                  allowed: false,
                  limit_reached: true,
                  primary_window: window(18_000, 100),
                  secondary_window: null,
                },
              },
            ]
          : [],
      spend_control:
        phase === "malformed-usage"
          ? { reached: "invalid" }
          : phase === "spending-exhaustion"
            ? { reached: true }
            : null,
      rate_limit_reached_type:
        phase === "workspace-exhaustion" ? { type: "workspace_owner_credits_depleted" } : null,
    };
  };
  const failure = () => {
    const headers: Record<string, string> =
      primaryExhausted() && source === "codex_rate_limits"
        ? {
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": String(resetAt),
            "x-codex-secondary-used-percent": "100",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-at": String(resetAt),
          }
        : {};
    return {
      type: "error",
      status: phase === "revoked" ? 401 : 429,
      error:
        phase === "revoked"
          ? {
              type: "invalid_request_error",
              code: "invalid_api_key",
              message: "Invalid authentication token",
            }
          : phase === "ordinary-rate-limit" ||
              phase === "ordinary-rate-limit-with-capacity" ||
              phase === "ordinary-rate-limit-with-exhausted-usage"
            ? {
                type: "rate_limit_error",
                code: "rate_limit_exceeded",
                message: "Too many requests",
              }
            : {
                type: "usage_limit_reached",
                message: "The usage limit has been reached",
                plan_type: "pro",
                ...(source === "codex_rate_limits" ? { resets_at: resetAt } : {}),
              },
      headers,
    };
  };
  const successEvents = () => {
    const observe = nextSuccessObserver;
    nextSuccessObserver = undefined;
    observe?.();
    const id = randomUUID().replaceAll("-", "");
    const item = {
      type: "message",
      id: `msg${id}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: MARKER, annotations: [] }],
    };
    const response = {
      id: `resp${id}`,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 0 },
      },
    };
    return [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: MARKER,
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ];
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const bodyBytes = Buffer.concat(chunks);
      const encoding = request.headers["content-encoding"];
      const decoded =
        encoding === undefined
          ? bodyBytes
          : encoding === "zstd"
            ? zstdDecompressSync(bodyBytes)
            : undefined;
      recordRequest(request, decoded?.toString(), "http", bodyBytes);
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const json = (
        status: number,
        value: unknown,
        headers: Record<string, string> = {},
        responsePhase = phase,
      ) => {
        responses.push({ phase: responsePhase, path: requestPath, value, headers });
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(value));
      };
      if (requestPath === "/core-wham/usage" || requestPath === "/backend-api/wham/usage") {
        // Preserve the native block source only on the original quota failure.
        if (
          requestPath === "/core-wham/usage" &&
          ((source === "codex_rate_limits" && phase === "initial-exhaustion") ||
            phase === "ordinary-rate-limit")
        ) {
          json(503, { error: { message: "Usage view temporarily unavailable" } });
        } else if (phase === "revoked") {
          json(403, { error: { message: "Account deactivated" } });
        } else {
          const value = usage();
          const hold = requestPath === "/core-wham/usage" ? nextUsageHold : undefined;
          if (hold) {
            nextUsageHold = undefined;
            const captured: HeldUsageResponse = {
              phase,
              path: requestPath,
              status: 200,
              body: JSON.stringify(value),
              capturedAt: Date.now(),
            };
            heldUsageResponses.push(captured);
            hold.arrived.resolve(captured);
            const interrupted = createDeferredCore<"deadline" | "aborted">();
            const timer = setTimeout(() => interrupted.resolve("deadline"), 2800);
            const onClose = () => interrupted.resolve("aborted");
            response.once("close", onClose);
            try {
              captured.releaseReason = await Promise.race([
                hold.released.promise.then(() => "explicit" as const),
                interrupted.promise,
              ]);
              captured.releasedAt = Date.now();
              if (captured.releaseReason !== "aborted") {
                json(captured.status, value, {}, captured.phase);
              }
            } finally {
              clearTimeout(timer);
              response.off("close", onClose);
            }
          } else {
            json(200, value);
          }
        }
      } else if (requestPath === "/oauth/token") {
        if (phase === "revoked") {
          json(400, { error: "invalid_grant", error_description: "Refresh token revoked" });
        } else {
          json(200, {
            access_token: syntheticAccessToken(),
            refresh_token: "synthetic-rotated-refresh",
            expires_in: 3600,
          });
        }
      } else if (requestPath.endsWith("/models")) {
        json(200, { models: [] });
      } else if (requestPath.endsWith("/responses")) {
        if (exhausted() || phase === "revoked") {
          const event = failure();
          json(event.status, { error: event.error }, event.headers);
        } else {
          const events = successEvents();
          responses.push({ phase, path: requestPath, value: events });
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of events) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        }
      } else {
        json(404, { error: { message: "No synthetic fixture for this route" } });
      }
    })().catch((error: unknown) => {
      errors.push(String(error));
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on("error", (error) => errors.push(String(error)));
      websocket.on("message", (raw) => {
        recordRequest(request, raw.toString(), "websocket");
        const events = exhausted() || phase === "revoked" ? [failure()] : successEvents();
        for (const event of events) {
          responses.push({ phase, path: request.url ?? "", value: event });
          websocket.send(JSON.stringify(event));
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind loopback");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    responses,
    heldUsageResponses,
    errors,
    setPhase(next: Phase) {
      phase = next;
    },
    observeNextSuccess(observer: () => void) {
      nextSuccessObserver = observer;
    },
    holdNextUsage() {
      if (nextUsageHold) {
        throw new Error("A usage response hold is already armed");
      }
      const hold = {
        arrived: createDeferredCore<HeldUsageResponse>(),
        released: createDeferredCore<void>(),
      };
      nextUsageHold = hold;
      return { arrived: hold.arrived.promise, release: () => hold.released.resolve() };
    },
    async stop() {
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe.each([
  {
    source: "wham",
    expiresDuringBlock: false,
    scopedCooldown: false,
    availableProbeCooldown: false,
    staleUsageAfterSuccess: false,
  },
  {
    source: "codex_rate_limits",
    expiresDuringBlock: false,
    scopedCooldown: false,
    availableProbeCooldown: false,
    staleUsageAfterSuccess: false,
  },
  {
    source: "wham",
    expiresDuringBlock: true,
    scopedCooldown: false,
    availableProbeCooldown: false,
    staleUsageAfterSuccess: false,
  },
  {
    source: "codex_rate_limits",
    expiresDuringBlock: false,
    scopedCooldown: true,
    availableProbeCooldown: false,
    staleUsageAfterSuccess: false,
  },
  {
    source: "codex_rate_limits",
    expiresDuringBlock: false,
    scopedCooldown: true,
    availableProbeCooldown: true,
    staleUsageAfterSuccess: false,
  },
  {
    source: "codex_rate_limits",
    expiresDuringBlock: false,
    scopedCooldown: true,
    availableProbeCooldown: false,
    staleUsageAfterSuccess: true,
  },
] as const)(
  "Gateway quota reset ($source, expired=$expiresDuringBlock, scoped=$scopedCooldown, available=$availableProbeCooldown, stale-success=$staleUsageAfterSuccess)",
  ({
    source,
    expiresDuringBlock,
    scopedCooldown,
    availableProbeCooldown,
    staleUsageAfterSuccess,
  }) => {
    it(
      "recovers the next chat after upstream capacity returns without admitting exhausted or revoked auth",
      { timeout: 600_000 },
      async (context) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quota-reset-"));
        context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
        const provider = await startQuotaProvider(source);
        context.onTestFinished(() => provider.stop());
        const clockFile = path.join(root, "clock-offset");
        await fs.writeFile(clockFile, "0");
        let offset = 0;
        const advanceClock = async (
          advanceMs = expiresDuringBlock ? 2 * 86_400_000 + RECHECK_ADVANCE_MS : RECHECK_ADVANCE_MS,
        ) => {
          offset += advanceMs;
          await fs.writeFile(`${clockFile}.next`, String(offset));
          await fs.rename(`${clockFile}.next`, clockFile);
        };
        const preload = new URL("./quota-reset-preload.mjs", import.meta.url);
        preload.searchParams.set("fixture", provider.baseUrl);
        preload.searchParams.set("clock", clockFile);
        const requireCodex = createRequire(
          new URL("../../../../extensions/codex/package.json", import.meta.url),
        );
        const launcher = path.join(
          path.dirname(requireCodex.resolve("@openai/codex/package.json")),
          "bin/codex.js",
        );
        const gateway = await createOpenClawTestInstance({
          name: `quota-reset-${source}`,
          gatewayCommandPrefix: [process.execPath, "--import", preload.href],
          startTimeoutMs: 120_000,
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_AGENT_HARNESS_FALLBACK: "none",
          },
          config: {
            gateway: { controlUi: { enabled: false } },
            ...(scopedCooldown
              ? {
                  models: {
                    providers: {
                      openai: {
                        baseUrl: "https://chatgpt.com/backend-api/codex",
                        api: "openai-chatgpt-responses" as const,
                        auth: "oauth" as const,
                        models: ["gpt-5.5", UTILITY_MODEL_ID].map((id) => ({
                          id,
                          name: id,
                          reasoning: false,
                          input: ["text" as const],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: 128_000,
                          maxTokens: 4096,
                        })),
                      },
                    },
                  },
                }
              : {}),
            plugins: {
              enabled: true,
              allow: ["codex", "openai"],
              entries: {
                codex: {
                  enabled: true,
                  config: {
                    appServer: {
                      mode: "yolo",
                      command: process.execPath,
                      args: [
                        launcher,
                        "app-server",
                        "-c",
                        `chatgpt_base_url="${provider.baseUrl}/backend-api"`,
                        "-c",
                        `openai_base_url="${provider.baseUrl}/v1"`,
                      ],
                      requestTimeoutMs: 60_000,
                    },
                  },
                },
              },
            },
            agents: {
              defaults: {
                model: { primary: MODEL, fallbacks: [] },
                models: { [MODEL]: { agentRuntime: { id: "codex" } } },
                ...(scopedCooldown ? { utilityModel: `openai/${UTILITY_MODEL_ID}` } : {}),
                workspace: "~/workspace",
                skipBootstrap: true,
                timeoutSeconds: 90,
                sandbox: { mode: "off" },
              },
            },
          },
        });
        context.onTestFinished(() => gateway.cleanup());
        // Doctor imports without refreshing a credential outside its one-day warning window.
        const expires = expiresDuringBlock ? Date.now() + 2 * 86_400_000 : Date.UTC(2036, 0, 1);
        const access = syntheticAccessToken(expires);
        await gateway.state.writeText(
          "agents/main/agent/auth-profiles.json",
          JSON.stringify({
            version: 1,
            profiles: {
              [PROFILE_ID]: {
                type: "oauth",
                provider: "openai",
                access,
                refresh: "synthetic-refresh",
                expires,
                accountId: ACCOUNT_ID,
              },
            },
            order: { openai: [PROFILE_ID] },
          }),
        );
        const doctor = await gateway.cli(["doctor", "--fix", "--yes", "--non-interactive"], {
          timeoutMs: 120_000,
        });
        expect(doctor.code, doctor.stderr).toBe(0);
        await gateway.startGateway();
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${gateway.port}`,
          token: gateway.gatewayToken,
          clientName: "cli",
          mode: "cli",
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        context.onTestFinished(() => client.stopAndWait());
        const sessionKey = `agent:main:quota-${randomUUID()}`;
        const turns: unknown[] = [];
        const stats = () =>
          coerceAuthProfileState(readPersistedSharedAuthProfileStateRaw(gateway.env)).usageStats?.[
            PROFILE_ID
          ];
        const evidence = () =>
          JSON.stringify(
            {
              requests: provider.requests,
              responses: provider.responses,
              heldUsageResponses: provider.heldUsageResponses,
              errors: provider.errors,
              turns,
              stats: stats(),
              gateway: gateway.logs(),
            },
            null,
            2,
          );
        const turn = async (key = sessionKey) => {
          const before = assistantTexts(
            await client.request<ChatHistory>("chat.history", { sessionKey: key, limit: 100 }),
          );
          const started = await client.request<{ runId: string; status: string }>("chat.send", {
            sessionKey: key,
            message: `Return ${MARKER}.`,
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(started.status, evidence()).toBe("started");
          const terminal = await client.request<{ status: string; error?: unknown }>(
            "agent.wait",
            { runId: started.runId, timeoutMs: 100_000 },
            { timeoutMs: 105_000 },
          );
          const history = await client.request<ChatHistory>("chat.history", {
            sessionKey: key,
            limit: 100,
          });
          turns.push({ started, terminal, history });
          const after = assistantTexts(history);
          expect(["ok", "error"], JSON.stringify({ terminal, evidence: evidence() })).toContain(
            terminal.status,
          );
          return { status: terminal.status, output: after.slice(before.length) };
        };
        expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
        if (staleUsageAfterSuccess) {
          const companionSessionKey = `agent:main:quota-companion-${randomUUID()}`;
          expect(await turn(companionSessionKey), evidence()).toEqual({
            status: "ok",
            output: [MARKER],
          });
          const warmCompanion = await client.request<{ answer: string }>(
            "sessions.companion.ask",
            { sessionKey: companionSessionKey, question: `Return ${MARKER}.` },
            { timeoutMs: 100_000 },
          );
          turns.push({ warmCompanion });
          expect(warmCompanion.answer, evidence()).toBe(MARKER);
          const beforeOverlap = stats();
          turns.push({ beforeOverlap });
          expect(beforeOverlap?.blockedUntil, evidence()).toBeUndefined();
          expect(beforeOverlap?.blockedReason, evidence()).toBeUndefined();

          provider.setPhase("ordinary-rate-limit-with-exhausted-usage");
          const hold = provider.holdNextUsage();
          const olderCompanion = client
            .request(
              "sessions.companion.ask",
              { sessionKey: companionSessionKey, question: "Return the older request's answer." },
              { timeoutMs: 100_000 },
            )
            .then(
              (result) => ({ status: "ok", result }),
              (error: unknown) => ({ status: "error", error: String(error) }),
            );
          try {
            await expect
              .poll(() => provider.heldUsageResponses.length, { timeout: 2800, interval: 10 })
              .toBe(1);
            const captured = await hold.arrived;
            expect(captured.status, evidence()).toBe(200);
            expect(JSON.parse(captured.body), evidence()).toMatchObject({
              rate_limit: {
                allowed: false,
                limit_reached: true,
                primary_window: { used_percent: 100 },
                secondary_window: { used_percent: 100 },
              },
            });
            provider.setPhase("healthy");
            expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
            const newerSuccessCompletedAt = Date.now();
            const beforeRelease = stats();
            turns.push({ newerSuccessCompletedAt, beforeRelease });
            expect(captured.releaseReason, evidence()).toBeUndefined();
            expect(beforeRelease?.blockedUntil, evidence()).toBeUndefined();
            expect(newerSuccessCompletedAt, evidence()).toBeGreaterThanOrEqual(captured.capturedAt);
            hold.release();
            const olderResult = await olderCompanion;
            const afterRelease = stats();
            turns.push({ olderResult, afterRelease });
            expect(olderResult.status, evidence()).toBe("error");
            expect(captured.releaseReason, evidence()).toBe("explicit");
            expect(captured.releasedAt, evidence()).toBeGreaterThanOrEqual(newerSuccessCompletedAt);
            expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
            expect(afterRelease?.blockedUntil, evidence()).toBeUndefined();
            expect(afterRelease?.blockedReason, evidence()).toBeUndefined();
            for (const request of provider.requests.filter(
              (entry) => entry.path.endsWith("/responses") || entry.path === "/core-wham/usage",
            )) {
              expect(request.authorization, evidence()).toBe(`Bearer ${access}`);
            }
            expect(provider.errors, evidence()).toEqual([]);
          } finally {
            hold.release();
            await olderCompanion;
          }
          return;
        }
        const quotaSessions =
          source === "codex_rate_limits"
            ? [sessionKey, `agent:main:quota-${randomUUID()}`, `agent:main:quota-${randomUUID()}`]
            : [sessionKey];
        for (const key of quotaSessions.slice(1)) {
          expect(await turn(key), evidence()).toEqual({ status: "ok", output: [MARKER] });
        }
        provider.setPhase("initial-exhaustion");
        for (const blocked of await Promise.all(quotaSessions.map((key) => turn(key)))) {
          expect(blocked.status, evidence()).toBe("error");
          expect(blocked.output, evidence()).not.toContain(MARKER);
        }
        expect(stats(), evidence()).toMatchObject({
          blockedSource: source,
          blockedReason: "subscription_limit",
        });
        expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + 86_400_000);

        if (availableProbeCooldown) {
          expect(stats(), evidence()).toMatchObject({
            blockedModel: "gpt-5.5",
            blockedScope: "model",
          });
          await advanceClock();
          provider.setPhase("ordinary-rate-limit-with-capacity");
          await expect(
            client.request(
              "sessions.companion.ask",
              { sessionKey, question: `Return ${MARKER}.` },
              { timeoutMs: 100_000 },
            ),
            evidence(),
          ).rejects.toThrow();
          const afterUtilityFailure = stats();
          turns.push({ afterUtilityFailure });
          expect(afterUtilityFailure, evidence()).toMatchObject({
            cooldownModel: UTILITY_MODEL_ID,
            cooldownReason: "rate_limit",
          });
          const ordinaryCooldown = afterUtilityFailure?.cooldownUntil;
          expect(ordinaryCooldown, evidence()).toBeGreaterThan(Date.now() + offset);
          expect(provider.responses, evidence()).toContainEqual({
            phase: "ordinary-rate-limit-with-capacity",
            path: "/core-wham/usage",
            value: expect.objectContaining({
              rate_limit: expect.objectContaining({
                allowed: true,
                limit_reached: false,
                primary_window: expect.objectContaining({ used_percent: 2 }),
                secondary_window: expect.objectContaining({ used_percent: 2 }),
              }),
            }),
            headers: {},
          });
          let beforeRecoveryReply: ReturnType<typeof stats>;
          provider.observeNextSuccess(() => {
            beforeRecoveryReply = stats();
            turns.push({ beforeRecoveryReply });
          });
          provider.setPhase("restored");
          expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
          expect(beforeRecoveryReply?.blockedUntil, evidence()).toBeUndefined();
          expect(beforeRecoveryReply, evidence()).toMatchObject({
            cooldownModel: UTILITY_MODEL_ID,
            cooldownReason: "rate_limit",
            cooldownUntil: ordinaryCooldown,
          });
          expect(provider.errors, evidence()).toEqual([]);
          return;
        }

        if (scopedCooldown) {
          provider.setPhase("ordinary-rate-limit");
          for (let attempt = 0; attempt < 4; attempt++) {
            await expect(
              client.request(
                "sessions.companion.ask",
                {
                  sessionKey,
                  question: `Return ${MARKER}.`,
                },
                { timeoutMs: 100_000 },
              ),
              evidence(),
            ).rejects.toThrow();
            expect(stats(), evidence()).toMatchObject({
              blockedModel: "gpt-5.5",
              blockedScope: "model",
              cooldownModel: UTILITY_MODEL_ID,
              cooldownReason: "rate_limit",
            });
            if (attempt < 3) {
              const cooldownUntil = stats()?.cooldownUntil;
              expect(cooldownUntil, evidence()).toEqual(expect.any(Number));
              if (cooldownUntil === undefined) {
                throw new Error("Companion failure did not persist its retry deadline");
              }
              await advanceClock(Math.max(1, cooldownUntil - Date.now() - offset + 1));
            }
          }
          provider.setPhase("restored");
          await advanceClock();
          expect(stats()?.cooldownUntil, evidence()).toBeGreaterThan(Date.now() + offset);
          expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
          expect(stats()?.blockedUntil, evidence()).toBeUndefined();
          expect(provider.errors, evidence()).toEqual([]);
          return;
        }

        if (source === "codex_rate_limits") {
          const originalGeneration = stats();
          expect(originalGeneration?.lastFailureAt, evidence()).toEqual(expect.any(Number));
          expect(originalGeneration?.failureCounts?.rate_limit, evidence()).toBeGreaterThan(0);
          for (const phase of [
            "additional-exhaustion",
            "workspace-exhaustion",
            "spending-exhaustion",
            "malformed-usage",
          ] as const) {
            provider.setPhase(phase);
            await advanceClock();
            const additionalLimitTurn = await turn();
            expect(additionalLimitTurn.status, evidence()).toBe("error");
            expect(additionalLimitTurn.output, evidence()).not.toContain(MARKER);
            const retained = stats();
            expect(retained?.blockedReason, evidence()).toBe("subscription_limit");
            expect(retained?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + offset);
            expect(retained?.lastFailureAt, evidence()).toBe(originalGeneration?.lastFailureAt);
            expect(retained?.failureCounts, evidence()).toEqual(originalGeneration?.failureCounts);
            const additionalLimitRequests = provider.requests.filter(
              (request) => request.phase === phase,
            );
            expect(
              additionalLimitRequests.filter((request) => request.path === "/core-wham/usage"),
              evidence(),
            ).not.toHaveLength(0);
            // A fresh exhausted bucket must not become another failed inference attempt.
            expect(
              additionalLimitRequests.filter(
                (request) =>
                  request.transport === "websocket" || request.path.endsWith("/responses"),
              ),
              evidence(),
            ).toEqual([]);
          }
        }

        provider.setPhase("exhausted");
        if (!expiresDuringBlock) {
          await advanceClock();
        }
        const exhaustedTurn = await turn();
        expect(exhaustedTurn.status, evidence()).toBe("error");
        expect(exhaustedTurn.output, evidence()).not.toContain(MARKER);
        expect(stats()?.blockedUntil, evidence()).toBeGreaterThan(Date.now() + offset);

        provider.setPhase("restored");
        const earlyRetry = await turn();
        expect(earlyRetry.status, evidence()).toBe("error");
        expect(earlyRetry.output, evidence()).not.toContain(MARKER);
        expect(
          provider.requests.filter(
            (request) => request.phase === "restored" && request.path === "/core-wham/usage",
          ),
          evidence(),
        ).toEqual([]);
        await advanceClock();
        expect(await turn(), evidence()).toEqual({ status: "ok", output: [MARKER] });
        expect(stats()?.blockedUntil, evidence()).toBeUndefined();
        if (expiresDuringBlock) {
          const refreshRequests = provider.requests.filter(
            (request) => request.path === "/oauth/token",
          );
          expect(refreshRequests, evidence()).toHaveLength(1);
          expect(refreshRequests[0]?.body, evidence()).toContain("synthetic-refresh");
        }
        expect(
          provider.requests.filter(
            (request) => request.phase === "restored" && request.path === "/core-wham/usage",
          ),
          evidence(),
        ).not.toHaveLength(0);
        expect(
          provider.requests.filter(
            (request) => request.phase === "restored" && request.path.endsWith("/responses"),
          ),
          evidence(),
        ).not.toHaveLength(0);

        provider.setPhase("revoked");
        const revoked = await turn();
        expect(revoked.status, evidence()).toBe("error");
        expect(revoked.output, evidence()).not.toContain(MARKER);
        await advanceClock();
        const revokedAgain = await turn();
        expect(revokedAgain.status, evidence()).toBe("error");
        expect(revokedAgain.output, evidence()).not.toContain(MARKER);
        for (const request of provider.requests.filter(
          (entry) => entry.path.endsWith("/responses") || entry.path === "/core-wham/usage",
        )) {
          const refreshed =
            expiresDuringBlock && (request.phase === "restored" || request.phase === "revoked");
          // The native process retains its real clock and may reuse the bound session's token.
          if (refreshed && request.path.endsWith("/responses")) {
            expect([`Bearer ${access}`, `Bearer ${syntheticAccessToken()}`], evidence()).toContain(
              request.authorization,
            );
            expect(request.accountId, evidence()).toBe(ACCOUNT_ID);
          } else {
            expect(request.authorization, evidence()).toBe(
              `Bearer ${refreshed ? syntheticAccessToken() : access}`,
            );
          }
        }
        for (const request of provider.requests.filter(
          (entry) => entry.path === "/core-wham/usage",
        )) {
          expect(request.accountId, evidence()).toBe(ACCOUNT_ID);
        }
        expect(provider.errors, evidence()).toEqual([]);
      },
    );
  },
);
