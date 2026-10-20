// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred as createVoidDeferred,
} from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../cron/agent-id.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import type { CronJob } from "../cron/types.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(async (_request: GuardedFetchOptions) => ({
    response: new Response(null, { status: 204 }),
    finalUrl: "https://example.invalid/cron",
    release: vi.fn(async () => {}),
  })),
  sendCronAnnouncePayloadStrict: vi.fn(),
  resolveDeliveryTarget: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(
    async (_cfg, _agentId, target) => ({
      ok: true,
      channel: target.channel ?? "discord",
      to: target.to ?? "channel:ops",
      accountId: target.accountId,
      threadId: target.threadId,
      mode: "explicit",
    }),
  ),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  };
});

vi.mock("../cron/isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof deliveryTarget>()),
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert as sendGatewayCronFailureAlertBase,
} from "./server-cron-notifications.js";

type FailureAlertParams = Parameters<typeof sendGatewayCronFailureAlertBase>[0];
const sendGatewayCronFailureAlert = (params: Partial<FailureAlertParams>) =>
  sendGatewayCronFailureAlertBase({
    job: createCompletionWebhookJob(),
    channel: "discord",
    to: "channel:ops",
    mode: "announce",
    deps: {} as CliDeps,
    logger: { warn: vi.fn() },
    resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    payload: { text: "cron failed" },
    routing: { defaultAgentId: "main" },
    onDeliverySettled: async () => {},
    ...params,
  });

function sentFailureAlert() {
  return {
    status: "sent" as const,
    results: [],
    receipt: { primaryPlatformMessageId: undefined, platformMessageIds: [], parts: [], sentAt: 0 },
  };
}

function waitForFast(assertion: () => void | Promise<void>) {
  return vi.waitFor(assertion, { interval: 1 });
}

function webhookRequestBody() {
  const body = mocks.fetchWithSsrFGuard.mock.calls[0]?.[0].init?.body;
  if (typeof body !== "string") {
    throw new Error("expected webhook request body");
  }
  return JSON.parse(body);
}

function createWebhookJob(delivery: NonNullable<CronJob["delivery"]>): CronJob {
  return makeCronJob({
    id: "cron-notification-admission",
    name: "notification admission",
    createdAtMs: 1,
    updatedAtMs: 1,
    payload: { kind: "agentTurn", message: "hello" },
    delivery,
  });
}

function createCompletionWebhookJob(url = "https://example.invalid/cron"): CronJob {
  return createWebhookJob({
    mode: "announce",
    completionDestination: { mode: "webhook", to: url },
  });
}

const webhookSsrfPolicy = { allowedHostnames: ["127.0.0.1"] };
const webhookSsrfPolicyRequest = expect.objectContaining({ policy: webhookSsrfPolicy });

function expectWebhookSsrfPolicy() {
  expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(webhookSsrfPolicyRequest);
}

function dispatchCompletion(
  job: CronJob,
  overrides: Partial<Parameters<typeof dispatchGatewayCronFinishedNotifications>[0]> = {},
) {
  dispatchGatewayCronFinishedNotifications({
    evt: { jobId: job.id, action: "finished", status: "ok", summary: "done" },
    job,
    logger: { warn: vi.fn() },
    ...overrides,
  });
}

const runAtMs = Date.parse("2026-01-15T15:30:00.000Z");
const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [
        { label: "Log in to Codex", action: { type: "command" as const, command: "/login codex" } },
      ],
    },
  ],
};

const sensitiveSummary =
  "action-required output preserved:\nVisit www.example.com/device and enter code 123456\nLog in with token=opaque-secret-value";

function commandDiagnostics(severity: "warn" | "error", message = sensitiveSummary) {
  return {
    summary: sensitiveSummary,
    entries: [{ ts: 1, source: "exec" as const, severity, message }],
  };
}

function commandJob(id: string, argv: string[], severity: "warn" | "error") {
  return {
    ...createCompletionWebhookJob(),
    id,
    name: id,
    payload: { kind: "command" as const, argv },
    state: {
      lastDiagnosticSummary: sensitiveSummary,
      lastDiagnostics: commandDiagnostics(severity),
    },
  };
}

function expectSecretsRedacted(text: string) {
  for (const secret of ["www.example.com/device", "123456", "opaque-secret-value"]) {
    expect(text).not.toContain(secret);
  }
}

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {}),
    }));
    mocks.sendCronAnnouncePayloadStrict.mockResolvedValue(sentFailureAlert());
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    setActiveDegradedSecretOwners([]);
  });

  it.each([
    {
      name: "captured default",
      jobAgentId: undefined,
      defaultAgentId: "alpha",
      recipient: "alpha",
    },
    {
      name: "explicit job owner",
      jobAgentId: "gamma",
      defaultAgentId: "alpha",
      recipient: "gamma",
    },
    {
      name: "captured absence",
      jobAgentId: undefined,
      defaultAgentId: undefined,
      recipient: undefined,
    },
  ])(
    "routes a failure alert using $name instead of the live default",
    async ({ jobAgentId, defaultAgentId, recipient }) => {
      const job = createWebhookJob({ mode: "announce", channel: "discord", to: "channel:ops" });
      job.agentId = jobAgentId;
      job.sessionKey = "agent:session-owner:main";
      const resolveCronAgent = vi.fn((requested?: string | null) => ({
        agentId: requested ?? "beta",
        cfg: {},
      }));
      const onDeliverySettled = vi.fn(async () => {});
      if (recipient) {
        mocks.resolveDeliveryTarget.mockResolvedValueOnce({
          ok: true,
          channel: "discord",
          to: "resolved-channel",
          accountId: "resolved-account",
          threadId: 7,
          mode: "explicit",
        });
      }
      const delivery = sendGatewayCronFailureAlert({
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent,
        job,
        routing: defaultAgentId ? { defaultAgentId } : {},
        accountId: "requested-account",
        threadId: 42,
        onDeliverySettled,
      });
      if (recipient) {
        await delivery;
        expect(resolveCronAgent).toHaveBeenCalledExactlyOnceWith(recipient);
        expect(mocks.resolveDeliveryTarget).toHaveBeenCalledExactlyOnceWith(
          {},
          recipient,
          expect.objectContaining({
            channel: "discord",
            to: "channel:ops",
            accountId: "requested-account",
            threadId: 42,
          }),
          { inheritSessionThread: undefined },
        );
        expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentId: recipient,
            target: expect.objectContaining({
              channel: "discord",
              to: "resolved-channel",
              accountId: "resolved-account",
              threadId: 7,
            }),
          }),
        );
        expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
          delivered: true,
          status: "delivered",
        });
      } else {
        await expect(delivery).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
        await expect(delivery).rejects.toMatchObject({ code: "AGENT_SELECTION_REQUIRED" });
        expect(resolveCronAgent).not.toHaveBeenCalled();
        expect(mocks.resolveDeliveryTarget).not.toHaveBeenCalled();
        expect(mocks.sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
        expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
        expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
          delivered: false,
          status: "not-delivered",
          error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
        });
      }
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it.each(["announce", "webhook"] as const)(
    "records non-delivery when admission refuses a %s failure alert",
    async (mode) => {
      markGatewayRestartDraining();
      const onDeliverySettled = vi.fn(async () => {});
      await expect(
        sendGatewayCronFailureAlert({
          mode,
          to: mode === "webhook" ? "https://example.invalid/failure" : "channel:ops",
          onDeliverySettled,
        }),
      ).rejects.toThrow("Gateway is restarting");
      expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
        delivered: false,
        status: "not-delivered",
        error: "Gateway is restarting. Please try again shortly.",
      });
      expect(mocks.sendCronAnnouncePayloadStrict).not.toHaveBeenCalled();
      expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("settles already-admitted cron notifications while draining rejects unrelated work", async () => {
    const webhookDelivery = createVoidDeferred();
    const failureDelivery = createVoidDeferred();
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async () => {
      await webhookDelivery.promise;
      return {
        response: new Response(null, { status: 204 }),
        finalUrl: "https://example.invalid/cron",
        release: vi.fn(async () => {}),
      };
    });
    mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(async () => {
      await failureDelivery.promise;
      return sentFailureAlert();
    });
    const job = createCompletionWebhookJob();
    const parentAdmission = tryBeginGatewayRootWorkAdmission();
    if (!parentAdmission) {
      throw new Error("expected parent Gateway work admission");
    }
    const suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspensionAdmission?.drain()).toBe(true);

    try {
      let failureAlert: Promise<void> | undefined;
      await parentAdmission.run(async () => {
        dispatchCompletion(job);
        failureAlert = sendGatewayCronFailureAlert({
          job,
          accountId: "bot-a",
          threadId: 42,
          mode: "announce",
        });
        await waitForFast(() => {
          expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
          expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce();
        });
        expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
          expect.objectContaining({ timeoutMs: 10_000 }),
        );
        expect(getActiveGatewayRootWorkCount()).toBe(3);
      });
      parentAdmission.release();

      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(getActiveGatewayRootWorkCount()).toBe(2);
      webhookDelivery.resolve();
      await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
      failureDelivery.resolve();
      await failureAlert;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    } finally {
      webhookDelivery.resolve();
      failureDelivery.resolve();
      parentAdmission.release();
      suspensionAdmission?.release();
    }
  });

  it("keeps webhook delivery cold when its token owner is unavailable", async () => {
    const logger = { warn: vi.fn() };
    const job = createCompletionWebhookJob();
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "cron-webhook",
        state: "unavailable",
        paths: ["cron.webhookToken"],
        refKeys: ["env:default:MISSING_WEBHOOK_TOKEN"],
        reason: "secret provider failed",
      },
    ]);

    dispatchCompletion(job, { logger });

    await waitForFast(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          err: expect.stringContaining("Secret owner capability:cron-webhook"),
        }),
        "cron: webhook delivery failed",
      ),
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("reports and releases an unsuccessful completion webhook", async () => {
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(null, { status: 500 }),
      finalUrl: "https://example.invalid/cron",
      release,
    });
    const logger = { warn: vi.fn() };
    const job = createCompletionWebhookJob("https://example.invalid/cron?token=must-not-be-logged");

    dispatchCompletion(job, { logger });

    await waitForFast(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: job.id,
          source: "completionDestination",
          err: expect.stringContaining("500"),
          webhookUrl: "https://example.invalid/cron",
        }),
        "cron: webhook delivery failed",
      ),
    );
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("must-not-be-logged");
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  });

  it("cancels an unread webhook response before releasing its guard", async () => {
    const cleanupOrder: string[] = [];
    const onDeliverySettled = vi.fn(async () => {});
    const response = new Response(
      new ReadableStream({
        cancel() {
          cleanupOrder.push("cancel");
        },
      }),
      { status: 200 },
    );
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response,
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {
        cleanupOrder.push("release");
      }),
    });

    await sendGatewayCronFailureAlert({
      job: createWebhookJob({
        mode: "webhook",
        to: "https://example.invalid/cron",
      }),
      channel: "last",
      mode: "webhook",
      to: "https://example.invalid/cron",
      onDeliverySettled,
    });

    expect(cleanupOrder).toEqual(["cancel", "release"]);
    expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
      delivered: true,
      status: "delivered",
    });
  });

  it("releases Gateway admission when webhook response cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => {});
      const response = new Response(
        new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
      );
      mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
        response,
        finalUrl: "https://example.invalid/cron",
        release,
      });

      const delivery = sendGatewayCronFailureAlert({
        job: createWebhookJob({
          mode: "webhook",
          to: "https://example.invalid/cron",
        }),
        channel: "last",
        mode: "webhook",
        to: "https://example.invalid/cron",
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(release).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toBeUndefined();
      expect(release).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: "missing", to: undefined },
    { name: "invalid", to: "ftp://example.invalid/failure" },
  ])("rejects a $name failure-alert webhook target", async ({ to }) => {
    await expect(
      sendGatewayCronFailureAlert({ channel: "last", mode: "webhook", to }),
    ).rejects.toThrow(/webhook requires/);
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it.each([
    { phase: "dispatch", failure: "timeout", status: "unknown" },
    { phase: "dispatch", failure: "dns", status: "not-delivered" },
    { phase: "redirect", failure: "dns", status: "unknown" },
    { phase: "response", failure: "http", status: "not-delivered" },
  ] as const)(
    "settles a failure-alert webhook $failure error after $phase as $status",
    async ({ phase, failure, status }) => {
      const error =
        failure === "dns"
          ? Object.assign(new Error("getaddrinfo ENOTFOUND"), {
              code: "ENOTFOUND",
              syscall: "getaddrinfo",
            })
          : failure === "timeout"
            ? Object.assign(new Error("webhook response timed out"), { name: "TimeoutError" })
            : new Error("network unavailable");
      const errorMessage =
        failure === "http" ? "Webhook request failed with HTTP 500" : error.message;
      const onDeliverySettled = vi.fn(async () => {});
      mocks.fetchWithSsrFGuard.mockImplementationOnce(async (request) => {
        request.beforeRequest?.();
        if (phase === "redirect") {
          request.onResponse?.(302);
        }
        if (phase === "response") {
          request.onResponse?.(500);
          return {
            response: new Response(null, { status: 500 }),
            finalUrl: "https://example.invalid/failure",
            release: vi.fn(async () => {}),
          };
        }
        throw error;
      });

      await expect(
        sendGatewayCronFailureAlert({
          channel: "last",
          mode: "webhook",
          to: "https://example.invalid/failure",
          onDeliverySettled,
        }),
      ).rejects.toThrow(errorMessage);
      expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
        delivered: status === "unknown" ? undefined : false,
        status,
        error: errorMessage,
      });
      expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    },
  );

  it("delivers a failed required delivery completion webhook without a summary", async () => {
    const event = {
      status: "ok",
      deliveryStatus: "not-delivered",
      deliveryError: "channel unavailable",
    } as const;
    const logger = { warn: vi.fn() };
    const job = createCompletionWebhookJob();

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        completionStatus: "failed",
        ...event,
      },
      job,
      logger,
      ssrfPolicy: webhookSsrfPolicy,
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce());
    expectWebhookSsrfPolicy();
    expect(webhookRequestBody()).toMatchObject({
      jobId: job.id,
      action: "finished",
      completionStatus: "failed",
      ...event,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps a successful completion without a summary silent", () => {
    const job = createCompletionWebhookJob();

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "ok",
        completionStatus: "succeeded",
      },
      job,
      logger: { warn: vi.fn() },
    });

    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("keeps failure-alert admission until settled persistence completes", async () => {
    const settlement = createVoidDeferred();
    const onDeliverySettled = vi.fn(async () => {
      await settlement.promise;
    });
    const job = createWebhookJob({ mode: "announce", channel: "discord", to: "channel:ops" });

    const delivery = sendGatewayCronFailureAlert({ job, onDeliverySettled });

    await waitForFast(() => expect(onDeliverySettled).toHaveBeenCalledOnce());
    expect(getActiveGatewayRootWorkCount()).toBe(1);
    settlement.resolve();
    await delivery;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it.each([
    { description: "ignores cancellation", recipientReached: false },
    {
      description: "ignores cancellation after reaching the recipient",
      recipientReached: true,
    },
  ])(
    "releases failure alert admission when a stalled sender $description",
    async ({ recipientReached }) => {
      vi.useFakeTimers();
      try {
        let deliverySignal: AbortSignal | undefined;
        const senderEntered = createVoidDeferred();
        const onDeliverySettled = vi.fn(async () => {});
        mocks.sendCronAnnouncePayloadStrict.mockImplementationOnce(
          ({
            abortSignal,
            onDeliveryAttempt: reportDeliveryAttempt,
          }: {
            abortSignal: AbortSignal;
            onDeliveryAttempt?: (reachedRecipient: boolean) => void;
          }) =>
            new Promise<void>(() => {
              deliverySignal = abortSignal;
              if (recipientReached) {
                reportDeliveryAttempt?.(true);
              }
              senderEntered.resolve();
            }),
        );
        const job = createWebhookJob({ mode: "announce", channel: "discord", to: "channel:ops" });

        const delivery = sendGatewayCronFailureAlert({ job, onDeliverySettled });
        const deliveryOutcome = delivery.then(
          () => undefined,
          (error: unknown) => error,
        );

        await awaitGateBeforeSettlement(
          senderEntered.promise,
          delivery,
          "failure alert settled before entering the stalled sender",
        );
        expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(deliverySignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(9_999);
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        expect(deliverySignal?.aborted).toBe(false);
        expect(onDeliverySettled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(deliverySignal?.aborted).toBe(true);
        await expect(deliveryOutcome).resolves.toEqual(
          expect.objectContaining({ message: "cron: failure alert announcement timed out" }),
        );
        expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
          delivered: recipientReached ? undefined : false,
          status: recipientReached ? "unknown" : "not-delivered",
          error: "cron: failure alert announcement timed out",
        });
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("defers detached completion delivery while suspension is prepared", async () => {
    const job = createCompletionWebhookJob();
    const suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspensionAdmission?.commit()).toBe(true);

    dispatchCompletion(job);

    await Promise.resolve();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);

    expect(suspensionAdmission?.release()).toBe(true);
    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
  });

  it("rejects credential-bearing completion webhook targets before fetch", () => {
    const logger = {
      warn: vi.fn(),
    };
    const credentialUrl = new URL("https://example.invalid/hook?token=placeholder");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    const job = createWebhookJob({
      mode: "announce",
      completionDestination: {
        mode: "webhook",
        to: credentialUrl.href,
      },
    });

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: job.id,
        deliveryTo: "https://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("redacts command action-required summaries before webhook completion delivery", async () => {
    const logger = { warn: vi.fn() };
    const job = commandJob("cron-command-webhook-redact", ["echo", "ok"], "warn");

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "ok",
        summary: sensitiveSummary,
        diagnostics: commandDiagnostics(
          "warn",
          "argv: node -e Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value",
        ),
        job,
      },
      job,
      logger,
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
    const body = webhookRequestBody();
    expect(body.diagnostics.summary).toBe(body.summary);
    for (const text of [body.summary, body.diagnostics.entries[0].message]) {
      for (const marker of ["[redacted-url]", "[redacted-code]", "token=***"]) {
        expect(text).toContain(marker);
      }
      expectSecretsRedacted(text);
    }
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
  });

  it("omits failed command summaries and diagnostics from completion webhook delivery", async () => {
    const logger = { warn: vi.fn() };
    const job = commandJob(
      "cron-command-webhook-failed-redact",
      ["node", "-e", "process.exit(7)"],
      "error",
    );

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "command exited with code 7",
        summary: sensitiveSummary,
        diagnostics: commandDiagnostics("error"),
        job,
      },
      job,
      logger,
    });

    await waitForFast(() => expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1));
    const body = webhookRequestBody();
    expect(body).toMatchObject({
      action: "finished",
      jobId: job.id,
      status: "error",
      error: "command exited with code 7",
    });
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("diagnostics");
    expect(body.job.state).not.toHaveProperty("lastDiagnosticSummary");
    expect(body.job.state).not.toHaveProperty("lastDiagnostics");
    expectSecretsRedacted(JSON.stringify(body));
  });

  it("keeps failure webhook messages stable and adds structured runAtMs", async () => {
    const job = makeCronJob({
      delivery: {
        mode: "announce",
        completionDestination: { mode: "webhook", to: "https://example.invalid/cron" },
      },
    });
    await sendGatewayCronFailureAlert({
      runAtMs,
      resolveCronAgent: () => ({
        agentId: "main",
        cfg: { agents: { defaults: { userTimezone: "America/New_York" } } },
      }),
      job,
      payload: { text: "cron failed" },
      channel: "last",
      mode: "webhook",
      to: "https://example.invalid/cron",
      ssrfPolicy: webhookSsrfPolicy,
    });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ policy: webhookSsrfPolicy }),
    );
    expect(webhookRequestBody()).toEqual({
      jobId: job.id,
      jobName: job.name,
      message: "cron failed",
      runAtMs,
    });
  });

  it.each([
    {
      name: "without a public origin",
      gateway: undefined,
      expectedText: "cron failed\nRun started: 2026-01-15 10:30 EST",
    },
    {
      name: "with a public origin",
      gateway: {
        publicOrigin: "https://gateway.example",
        controlUi: { basePath: "/control" },
      },
      expectedText:
        "cron failed\nRun started: 2026-01-15 10:30 EST\nInspect: https://gateway.example/control/automations?job=job-1&run=cron%3Ajob-1%3A1768491000000",
    },
  ])(
    "composes failure alert details $name without dropping presentation",
    async ({ gateway, expectedText }) => {
      const job = makeCronJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "channel:ops",
        },
      });

      await sendGatewayCronFailureAlert({
        runAtMs,
        resolveCronAgent: () => ({
          agentId: "main",
          cfg: { agents: { defaults: { userTimezone: "America/New_York" } }, gateway },
        }),
        job,
        payload: {
          text: "cron failed",
          presentation: structuredClone(presentation),
        },
        channel: "telegram",
        to: "channel:ops",
        mode: "announce",
      });

      expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            text: expectedText,
            presentation,
          },
        }),
      );
    },
  );
});
