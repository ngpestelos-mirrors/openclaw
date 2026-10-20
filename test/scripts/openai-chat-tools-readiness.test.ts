import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { json } from "node:stream/consumers";
import { afterEach, expect, it } from "vitest";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const toolResponse =
  '{"choices":[{"finish_reason":"tool_calls","message":{"content":null,"tool_calls":[{"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris, France\\"}"}}]}}]}';

it("waits for agent admission before chat tools despite healthy RPC", async ({ signal }) => {
  const workDir = tempDirs.make("openai-chat-tools-ready-");
  const entry = join(workDir, "healthy-rpc.mjs");
  const clientLog = join(workDir, "client.log");
  writeFileSync(entry, "process.exit(0);\n");
  const readinessPending = createDeferred();
  const admit = createDeferred();
  const requests: string[] = [];
  const chatRequests: Array<[string | undefined, string | string[] | undefined, unknown]> = [];
  let ready = false;
  // Exercise startup-to-client ordering, not config, cold recall, or a live model.
  const scenario = readFileSync("scripts/e2e/lib/openai-chat-tools/scenario.sh", "utf8");
  const start = scenario.indexOf('gateway_pid="$(openclaw_e2e_start_gateway');
  const end = scenario.indexOf(
    '\nif [ "${OPENCLAW_FROZEN_TARGET_SESSION_COLD_STORAGE_MODE:-required}"',
    start,
  );
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const fixture = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer(async (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        if (request.url === "/readyz") {
          if (requests.length === 1) {
            response.writeHead(503).end('{"ready":false,"failing":["agent-database:main"]}');
            return;
          }
          readinessPending.resolve();
          await admit.promise;
          ready = true;
          response.end('{"ready":true}');
          return;
        }
        if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        if (!ready) {
          response
            .writeHead(503, { "Retry-After": "1" })
            .end("Agent database is starting. Please retry.");
          return;
        }
        const body: unknown = await json(request);
        chatRequests.push([
          request.headers.authorization,
          request.headers["x-openclaw-model"],
          body,
        ]);
        response.end(toolResponse);
      }),
  });
  const script = `
set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_start_gateway() { printf '%s' "$$"; }
sleep() { :; }
entry="$FIXTURE_ENTRY"
GATEWAY_LOG="$FIXTURE_GATEWAY_LOG"
CLIENT_LOG="$FIXTURE_CLIENT_LOG"
TOKEN="$OPENCLAW_GATEWAY_TOKEN"
MODEL_REF="$FIXTURE_MODEL"
${scenario.slice(start, end)}
`;
  const child = spawn("/bin/bash", ["-c", script], {
    env: {
      ...process.env,
      PORT: String(fixture.claim.port),
      OPENCLAW_GATEWAY_TOKEN: "chat-tools-fixture-token",
      FIXTURE_ENTRY: entry,
      FIXTURE_GATEWAY_LOG: join(workDir, "gateway.log"),
      FIXTURE_CLIENT_LOG: clientLog,
      FIXTURE_MODEL: "openai/fixture-model",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  }
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        readinessPending.promise,
        closed.then((code) => {
          throw new Error(`scenario exited (${code}) before agent readiness: ${output}
${readFileSync(clientLog, "utf8")}`);
        }),
        "scenario exited before readiness",
      ),
      signal,
    );
    expect(requests).toEqual(["GET /readyz", "GET /readyz"]);
    expect(chatRequests).toEqual([]);
    admit.resolve();
    expect(await withinTest(closed, signal), output).toBe(0);
    const posts = requests.filter((request) => request.startsWith("POST "));
    expect(posts).toEqual(["POST /v1/chat/completions"]);
    expect(chatRequests).toEqual([
      [
        "Bearer chat-tools-fixture-token",
        "openai/fixture-model",
        expect.objectContaining({ model: "openclaw", stream: false, tool_choice: "auto" }),
      ],
    ]);
    expect(JSON.parse(readFileSync(clientLog, "utf8"))).toMatchObject({
      ok: true,
      toolName: "get_weather",
      args: { city: "Paris, France" },
    });
  } finally {
    admit.resolve();
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === "win32") {
        child.kill("SIGKILL");
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    }
    await closed;
    fixture.listener.closeAllConnections();
    await fixture.releaseListener();
    await fixture.claim.release();
  }
});
