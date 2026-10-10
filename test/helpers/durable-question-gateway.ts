import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayClientOptions } from "../../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";
import { acquireGatewayTestClient } from "./gateway-client.js";
import { writeOpenAiResponsesSse, writeOpenAiResponsesText } from "./openai-responses-sse.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";
import { createDeferred } from "./promise.js";

/** Real provider transport and CLI process; no question/admission owners are mocked. */
export async function createDurableQuestionGateway(
  signal: AbortSignal,
  options?: { config?: Record<string, unknown> },
) {
  const asked = createDeferred();
  const continued = createDeferred<string>();
  const busyStarted = createDeferred();
  const busyRelease = createDeferred();
  let busyIssued = false;
  let continuationCount = 0;
  const failed = createDeferred<never>();
  void failed.promise.catch(() => {});
  let issued = false;
  let ordinal = 0;
  const provider = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const text = Buffer.concat(chunks).toString("utf8");
          const body: unknown = JSON.parse(text);
          if (!isRecord(body) || request.url !== "/v1/responses") {
            throw new Error(`Unexpected provider route ${request.url}`);
          }
          ordinal += 1;
          const nativeTools =
            Array.isArray(body.tools) &&
            body.tools.some((tool) => isRecord(tool) && tool.name === "ask_user");
          if (nativeTools && text.includes("DURABLE_ASK_PROOF") && !issued) {
            issued = true;
            const args = JSON.stringify({
              questions: [
                {
                  id: "choice",
                  header: "Deployment",
                  question: "Which environment?",
                  options: [
                    { label: "Staging", description: "Test deployment" },
                    { label: "Production", description: "Live deployment" },
                  ],
                },
              ],
              timeoutSeconds: 900,
            });
            const item = {
              type: "function_call",
              id: "fc_durable_question",
              call_id: "call_durable_question",
              name: "ask_user",
              arguments: args,
            };
            const later = {
              type: "function_call",
              id: "fc_later_side_effect",
              call_id: "call_later_side_effect",
              name: "exec",
              arguments: JSON.stringify({
                command: "echo started > durable-question-side-effect-started",
              }),
            };
            writeOpenAiResponsesSse(response, [
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { ...item, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 0,
                item_id: item.id,
                delta: args,
              },
              { type: "response.output_item.done", output_index: 0, item },
              {
                type: "response.output_item.added",
                output_index: 1,
                item: { ...later, arguments: "" },
              },
              {
                type: "response.function_call_arguments.delta",
                output_index: 1,
                item_id: later.id,
                delta: later.arguments,
              },
              { type: "response.output_item.done", output_index: 1, item: later },
              {
                type: "response.completed",
                response: {
                  id: "resp_question",
                  status: "completed",
                  output: [item, later],
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
              },
            ]);
            asked.resolve();
            return;
          }
          const isContinuation = text.includes(
            "The previously requested user question has resolved.",
          );
          if (
            nativeTools &&
            text.includes("DURABLE_BUSY_PROOF") &&
            !busyIssued &&
            !isContinuation
          ) {
            busyIssued = true;
            busyStarted.resolve();
            await busyRelease.promise;
            if (!response.destroyed) {
              writeOpenAiResponsesText(response, {
                text: "DURABLE_BUSY_TURN_COMPLETED",
                messageId: `msg_${ordinal}`,
                responseId: `resp_${ordinal}`,
              });
            }
            return;
          }
          const reply = isContinuation
            ? "DURABLE_CONTINUATION_USED_STAGING"
            : "Synthetic durable question session";
          if (isContinuation) {
            if (!text.includes("Staging")) {
              throw new Error("Continuation lost committed answer context");
            }
            continuationCount++;
            continued.resolve(text);
          }
          writeOpenAiResponsesText(response, {
            text: reply,
            messageId: `msg_${ordinal}`,
            responseId: `resp_${ordinal}`,
          });
        })().catch((error: unknown) => {
          failed.reject(error);
          response.destroy(error instanceof Error ? error : undefined);
        });
      }),
  });
  const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${provider.claim.port}/v1`);
  const instance = await createOpenClawTestInstance({
    name: "durable-question",
    signal,
    startTimeoutMs: 120_000,
    config: {
      update: { checkOnStart: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      agents: {
        defaults: {
          heartbeat: { every: "0m" },
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          [model.providerId]: {
            ...model.config,
            agentRuntime: { id: "openclaw" },
            request: { allowPrivateNetwork: true },
          },
        },
      },
      tools: { codeMode: false, exec: { host: "gateway", security: "full", ask: "off" } },
      ...options?.config,
    },
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      VITEST: undefined,
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
  });
  const identity = loadOrCreateDeviceIdentity({
    path: instance.state.path("durable-device.sqlite"),
  });
  return {
    instance,
    model,
    asked: asked.promise,
    continued: continued.promise,
    busyStarted: busyStarted.promise,
    releaseBusy: () => busyRelease.resolve(),
    get continuationCount() {
      return continuationCount;
    },
    failed: failed.promise,
    connect: (onEvent?: GatewayClientOptions["onEvent"]) =>
      acquireGatewayTestClient(
        {
          url: instance.url,
          token: instance.gatewayToken,
          deviceIdentity: identity,
          clientName: "gateway-client",
          mode: "backend",
          clientVersion: "test",
          platform: process.platform,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.questions"],
          onEvent,
        },
        {
          timeoutMs: 30_000,
          timeoutMessage: "durable question client did not connect",
          closeMessage: "durable question client closed",
          signal,
        },
      ),
    async cleanup() {
      busyRelease.resolve();
      try {
        await instance.cleanup();
      } finally {
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      }
    },
  };
}
