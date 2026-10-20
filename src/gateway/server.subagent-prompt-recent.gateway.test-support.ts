import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  listSubagentRunsForRequester,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolvePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
} from "./gateway-provider-fixture.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const RUN_ID = "run-gw-prompt-recent";
const CHILD_SESSION_KEY = "agent:main:subagent:gw-prompt-recent";
const PARENT_SESSION_KEY = "agent:main:main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function resetGatewayState(): Promise<void> {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
  await resetSubagentRegistryForTests({ persist: false });
}

afterEach(resetGatewayState);

async function runParentAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  message: string,
  sessionKey = PARENT_SESSION_KEY,
): Promise<void> {
  const runId = randomUUID();
  const accepted = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(accepted.status).toBe("accepted");
  const completed = await client.request<{ status?: string }>(
    "agent.wait",
    { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(completed.status).toBe("ok");
}

describe("Completed child results on a real parent-agent turn", () => {
  test.each(["lifecycle", "outstanding"] as const)(
    "later parent model request includes the completed child: %s",
    { timeout: 90_000 },
    async (kind) => {
      const home = tempDirs.make("openclaw-gw-subagent-prompt-recent-");
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(workspace, { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      const environment = {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
      };
      const env = captureEnv([
        ...Object.keys(environment),
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_TEST_MINIMAL_GATEWAY",
      ]);
      for (const [key, value] of Object.entries(environment)) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      await resetGatewayState();

      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          requests.push(await readProviderBody(request));
          writeOpenAiResponsesText(response, {
            text: "ok",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });

      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      try {
        const provider = buildMockOpenAiResponsesProvider(
          await listenProvider(providerServer),
          "prompt-recent",
        );
        const token = `prompt-recent-${process.pid}`;
        const cfg = {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: { slots: { memory: "none" } },
          tools: {
            profile: "coding",
            ...(kind === "outstanding" ? { deny: ["sessions_spawn"] } : {}),
          },
        } satisfies OpenClawConfig;

        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "vitest-subagent-prompt-recent",
        });
        await gateway.server.startupSettled;

        const firstCursor = requests.length;
        await runParentAgentTurn(gateway.client, "first parent turn");
        const firstParentTurn = requests.slice(firstCursor).join("\n");
        expect(firstParentTurn).not.toContain("## Recently Completed Subagents");

        if (kind === "outstanding") {
          const result = `Retained-result-${randomUUID()}`;
          const endedAt = Date.now() - 7_200_000;
          const childSessionId = "persisted-outstanding-session";
          const childScope = {
            agentId: "main",
            sessionKey: CHILD_SESSION_KEY,
            storePath: resolvePhysicalSessionStorePath({ sessionKey: CHILD_SESSION_KEY }, cfg),
          };
          await upsertSessionEntryCore(childScope, {
            sessionId: childSessionId,
            updatedAt: endedAt,
          });
          await persistSessionTranscriptTurn(
            { ...childScope, sessionId: childSessionId },
            {
              cwd: workspace,
              config: cfg,
              runId: "persisted-outstanding-result",
              expectedSessionId: childSessionId,
              touchSessionEntry: false,
              updateMode: "none",
              messages: [
                {
                  message: {
                    role: "assistant",
                    phase: "final_answer",
                    stopReason: "stop",
                    content: [{ type: "text", text: result }],
                  },
                  now: endedAt,
                },
              ],
            },
          );
          const retained: SubagentRunRecord = {
            runId: "persisted-outstanding-result",
            childSessionKey: CHILD_SESSION_KEY,
            childSessionIdentity: { sessionId: childSessionId },
            requesterSessionKey: PARENT_SESSION_KEY,
            requesterStorePath: resolvePhysicalSessionStorePath(
              { sessionKey: PARENT_SESSION_KEY },
              cfg,
            ),
            requesterAgentId: "main",
            requesterDisplayKey: "main",
            task: "read the retained result",
            cleanup: "keep",
            expectsCompletionMessage: true,
            createdAt: endedAt - 1_000,
            execution: { status: "terminal", endedAt, outcome: { status: "ok" } },
            completion: {
              required: true,
              resultText: result,
              capturedAt: endedAt,
              terminalReply: { disposition: "visible", text: result },
            },
            delivery: { status: "failed" },
          };
          // Publish retained custody through the owner without registering an active child.
          persistRegistryFixture(new Map([[retained.runId, retained]]), [retained.runId]);
          const before = loadSubagentRegistryFromSqlite().get(retained.runId);
          const cursor = requests.length;
          await runParentAgentTurn(gateway.client, "Continue using any outstanding child result.");
          const parentRequest = requests.slice(cursor).join("\n");
          expect(parentRequest).toContain("## Child results awaiting delivery");
          expect(parentRequest).toContain(result);
          expect(parentRequest).not.toContain("## Recently Completed Subagents");
          expect(loadSubagentRegistryFromSqlite().get(retained.runId)).toEqual(before);
          const unrelatedCursor = requests.length;
          await runParentAgentTurn(
            gateway.client,
            "Summarize this session.",
            "agent:main:unrelated",
          );
          expect(requests.slice(unrelatedCursor).join("\n")).not.toContain(result);
          return;
        }

        await registerSubagentRun({
          runId: RUN_ID,
          childSessionKey: CHILD_SESSION_KEY,
          childAgentId: "main",
          sessionEntry: { sessionId: "gw-prompt-recent-child" },
          requesterSessionKey: PARENT_SESSION_KEY,
          requesterDisplayKey: "main",
          task: "summarize the inbox",
          taskName: "summarize_inbox",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
        const endedAt = Date.now();
        emitAgentEvent({
          runId: RUN_ID,
          stream: "lifecycle",
          data: {
            phase: "end",
            endedAt,
            terminalReply: { disposition: "visible", text: "done" },
          },
        });
        await expect
          .poll(
            () =>
              listSubagentRunsForRequester(PARENT_SESSION_KEY).find((row) => row.runId === RUN_ID)
                ?.execution.status,
          )
          .toBe("terminal");

        const laterCursor = requests.length;
        await runParentAgentTurn(gateway.client, "later parent turn");
        const laterParentTurn = requests.slice(laterCursor).join("\n");
        // The real completion owner may finish requester settlement before this
        // later turn starts. Both projections must preserve child discovery;
        // the persisted-outstanding case above separately pins pending custody.
        const hasOutstanding = laterParentTurn.includes("## Child results awaiting delivery");
        const hasRecent = laterParentTurn.includes("## Recently Completed Subagents");
        expect(hasOutstanding || hasRecent).toBe(true);
        expect(laterParentTurn).toContain(RUN_ID);
        expect(laterParentTurn).toContain(CHILD_SESSION_KEY);
        expect(laterParentTurn).not.toContain("## Active Subagents");
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close({ reason: "subagent prompt recent proof complete" });
        }
        await closeProvider(providerServer);
        env.restore();
      }
    },
  );
});
