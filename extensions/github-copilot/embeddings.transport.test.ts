import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DiagnosticsChannel } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const resolveFirstGithubTokenMock = vi.hoisted(() => vi.fn());
const resolveCopilotRuntimeAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./auth.js", () => ({ resolveFirstGithubToken: resolveFirstGithubTokenMock }));

vi.mock("./runtime-auth.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotRuntimeAuth: resolveCopilotRuntimeAuthMock,
}));

import { githubCopilotMemoryEmbeddingProviderAdapter } from "./embeddings.js";

const servers: Array<() => Promise<void>> = [];
const DISCOVERY_MODELS_BODY = JSON.stringify({
  data: [{ id: "text-embedding-3-small", supported_endpoints: ["/v1/embeddings"] }],
});
const discovery = { status: 200, body: DISCOVERY_MODELS_BODY };
const createOptions = { config: {}, agentDir: "/tmp/test-agent", model: "" };
const create = (
  remote?: Parameters<typeof githubCopilotMemoryEmbeddingProviderAdapter.create>[0]["remote"],
) => githubCopilotMemoryEmbeddingProviderAdapter.create({ ...createOptions, remote });
type Route = { status: number; body: string } | ((response: ServerResponse) => void);

async function startCopilotServer(handle: {
  models: Route;
  embeddings?: Route;
  observeRequest?: (request: IncomingMessage, body: string) => void;
}) {
  const requests: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Drain the request body so keep-alive sockets close cleanly.
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    handle.observeRequest?.(req, body);
    requests.push(`${req.method} ${req.url}`);
    const isEmbeddings = req.method === "POST" && req.url === "/embeddings";
    const route = isEmbeddings && handle.embeddings ? handle.embeddings : handle.models;
    if (typeof route === "function") {
      route(res);
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(route.body);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  servers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );

  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function pointTokenAt(baseUrl: string): void {
  resolveCopilotRuntimeAuthMock.mockResolvedValue({
    apiKey: "copilot_test_token_abc",
    source: "test",
    baseUrl,
  });
}

// Prove forced masking even when the operator disables log redaction.
function withRedactionDisabledConfig(): () => void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-redact-off-"));
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ logging: { redactSensitive: "off" } }));
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  return () => {
    if (previous === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

beforeEach(() => {
  resolveFirstGithubTokenMock.mockResolvedValue({
    githubToken: "gh_test_token_123",
    hasProfile: false,
  });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  resolveFirstGithubTokenMock.mockReset();
  resolveCopilotRuntimeAuthMock.mockReset();
});

it.each(["headers", "trickling body"])(
  "aborts model discovery with stalled %s within its operation deadline",
  async (phase) => {
    let bodyReceived = false;
    let connectionClosed = false;
    const server = await startCopilotServer({
      models: (response) => {
        const trickle =
          phase === "trickling body" ? setInterval(() => response.write(" "), 100) : undefined;
        // Bound a missing-timeout failure without leaving a hanging request.
        const finish = setTimeout(() => response.end(DISCOVERY_MODELS_BODY), 15_000);
        response.on("close", () => {
          connectionClosed = true;
          clearInterval(trickle);
          clearTimeout(finish);
        });
      },
    });
    const bodyChannel = channel("undici:request:bodyChunkReceived");
    const onBody = (message: unknown) => {
      const { request } = message as DiagnosticsChannel.RequestBodyChunkReceivedMessage;
      if (String(request.origin) === server.baseUrl && request.path === "/models") {
        bodyReceived = true;
      }
    };
    bodyChannel.subscribe(onBody);
    const realSetTimeout = globalThis.setTimeout;
    // Scale long deadlines, preserving Undici's timer pump and body trickle.
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) =>
        realSetTimeout(
          callback,
          delay !== undefined && delay >= 1_000 ? Math.ceil(delay / 10) : delay,
          ...args,
        ),
      );
    const startedAt = performance.now();

    try {
      await expect(
        create({ baseUrl: server.baseUrl, apiKey: "copilot-test-only" }),
      ).rejects.toThrow("request timed out");

      expect(performance.now() - startedAt).toBeLessThan(1_500);
      expect(bodyReceived).toBe(phase === "trickling body");
      await vi.waitFor(() => expect(connectionClosed).toBe(true));
      expect(server.requests).toEqual(["GET /models"]);
    } finally {
      bodyChannel.unsubscribe(onBody);
      timeoutSpy.mockRestore();
    }
  },
  20_000,
);

it.each([
  ["model discovery", 401, "authentication failed", "ghu_", "UNIQUESECRET", false],
  ["embeddings", 429, "rate limit exceeded", "gho_", "UNIQUEEMBSECRET", false],
  ["model discovery", 403, "forbidden", "ghu_", "UNIQUEOFFSECRET", true],
] as const)(
  "redacts %s HTTP %i over real transport",
  async (stage, status, message, prefix, fragment, redactOff) => {
    const secret = `${prefix}AAAA${fragment}XXXX111122223333`;
    const restoreConfig = redactOff ? withRedactionDisabledConfig() : undefined;
    try {
      const failure = {
        status,
        body: JSON.stringify({ error: { message }, access_token: secret }),
      };
      const server = await startCopilotServer({
        models: stage === "embeddings" ? discovery : failure,
        ...(stage === "embeddings" ? { embeddings: failure } : {}),
      });
      pointTokenAt(server.baseUrl);
      let caught: Error | undefined;
      try {
        const result = await create();
        if (stage === "embeddings") {
          await result.provider?.embed("hello", { inputType: "query" });
        }
      } catch (error) {
        caught = error as Error;
      }
      expect(server.requests).toEqual([
        "GET /models",
        ...(stage === "embeddings" ? ["POST /embeddings"] : []),
      ]);
      expect(caught?.message).toContain(`GitHub Copilot ${stage} HTTP ${status}`);
      expect(caught?.message).toContain(message);
      expect(caught?.message).not.toContain(secret);
      expect(caught?.message).not.toContain(fragment);
    } finally {
      restoreConfig?.();
    }
  },
);

it.each(["profile", "custom"])(
  "preserves %s authentication and embedding wire requests",
  async (auth) => {
    const observed: Array<[string | undefined, unknown, unknown, string]> = [];
    const server = await startCopilotServer({
      models: discovery,
      observeRequest: (request, body) => {
        observed.push([
          request.headers.authorization,
          request.headers["copilot-integration-id"],
          request.headers["x-proof"],
          body,
        ]);
      },
      embeddings: (response) => {
        const vectors =
          server.requests.length === 2
            ? [[0, 3, 4]]
            : [
                [1, 0, 2],
                [0, 3, 0],
              ];
        const data = vectors.map(([index, ...embedding]) => ({ index, embedding }));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data }));
      },
    });
    pointTokenAt(server.baseUrl);

    const result = await create({
      ...(auth === "custom" ? { baseUrl: server.baseUrl, apiKey: "explicit-test-token" } : {}),
      headers: { Authorization: "replaced-test-token", "X-Proof": "forwarded" },
    });
    expect(await result.provider?.embed("hello", { inputType: "query" })).toEqual([0.6, 0.8]);
    expect(await result.provider?.embedBatch(["first", { text: "second" }])).toEqual([
      [1, 0],
      [0, 1],
    ]);

    expect(server.requests).toEqual(["GET /models", "POST /embeddings", "POST /embeddings"]);
    const authorization = `Bearer ${auth === "custom" ? "explicit-test-token" : "copilot_test_token_abc"}`;
    expect(observed).toEqual(
      [
        "",
        JSON.stringify({ model: "text-embedding-3-small", input: ["hello"] }),
        JSON.stringify({ model: "text-embedding-3-small", input: ["first", "second"] }),
      ].map((body) => [authorization, "copilot-developer-cli", "forwarded", body]),
    );
    expect(resolveFirstGithubTokenMock).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
    expect(resolveCopilotRuntimeAuthMock).toHaveBeenCalledTimes(auth === "custom" ? 0 : 1);
  },
);
