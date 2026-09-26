import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { cronRunLogEntryToDetail } from "../../cron/run-history-detail.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { cronHistoryHandler } from "./cron-history.js";
import { createCronJob } from "./cron.validation.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const publication = vi.hoisted(() => ({
  afterVerification: () => {},
  verified: false,
}));
vi.mock("../../cron/store/read-only.js", () => ({
  readCronRunRecords: async () => [
    {
      id: "record",
      jobId: "cron-1",
      runId: "internal",
      createdAt: 1,
      endedAt: 2,
      status: "succeeded",
      agentId: "main",
      sessionKey: "agent:main:cron:cron-1:run:record",
      detail: cronRunLogEntryToDetail(
        {
          jobId: "cron-1",
          action: "finished",
          ts: 2,
          runAtMs: 1,
          runId: "public",
          sessionId: "recorded-generation",
          status: "ok",
        },
        { storeKey: "/synthetic/cron" },
      ),
    },
  ],
}));
vi.mock("../../config/sessions/session-history-worker-runtime.js", () => ({
  readSessionHistoryPageInWorker: async () => ({ sessionKey: "agent:main:cron:cron-1" }),
}));
vi.mock("./chat-history-handler.js", () => ({
  handleChatHistoryRequest: async (opts: {
    retainedTranscript: { verifyRetainedState: () => Promise<boolean> };
    respond: RespondFn;
  }) => {
    publication.verified = await opts.retainedTranscript.verifyRetainedState();
    publication.afterVerification();
    opts.respond(true, { messages: [{ role: "assistant", content: "private" }] });
  },
}));

it.each(["client", "grant"] as const)(
  "rechecks %s authority synchronously after retained-state verification",
  async (change) => {
    const cron = new CronService({
      storePath: "/synthetic/cron",
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent() {},
      requestHeartbeat() {},
      runIsolatedAgentJob: async () => ({ status: "ok" }),
    });
    const job = createCronJob({
      agentId: "main",
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    vi.spyOn(cron, "readJob").mockResolvedValue(job);
    vi.spyOn(cron, "getJob").mockReturnValue(job);
    const instance = createOperationalRunInstanceRef("publication-run");
    const claim = { jobId: job.id, expiresAtMs: Date.now() + 60_000 };
    const client: GatewayClient = {
      connect: {} as GatewayClient["connect"],
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:cron:cron-1:run:reader",
          operationalRunInstance: instance,
          delegatedAuthority: {
            kind: "local",
            operationalRunInstance: instance,
            lifecycleGeneration: "fixture",
            claimId: "fixture",
          },
          cronSelfManagementContext: claim,
        },
      },
    };
    let current = true;
    publication.verified = false;
    publication.afterVerification = () => {
      if (change === "client") {
        current = false;
      } else {
        claim.expiresAtMs = Date.now() - 1;
      }
    };
    const respond = vi.fn<RespondFn>();
    const params = { id: job.id, runId: "public" };
    try {
      await cronHistoryHandler({
        req: { type: "req", id: "history", method: "cron.history", params },
        params,
        client,
        respond,
        context: createDirectChatContext({
          cron,
          cronStorePath: "/synthetic/cron",
          getRuntimeConfig: () => ({}),
        }),
        isWebchatConnect: () => false,
        hasCurrentClientAuthority: () => current,
      });
      expect(publication.verified).toBe(true);
      expect(respond.mock.calls).toHaveLength(1);
      expect(respond.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
    } finally {
      cron.stop();
      vi.restoreAllMocks();
    }
  },
);
