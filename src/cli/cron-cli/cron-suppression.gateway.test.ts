// Boundary proof: real silent dispatch, service persistence, Gateway handlers, and CLI rendering.
// The agent-output input and RPC transport are test boundaries; no provider or channel send is claimed.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { prepareAgentRunTerminalReply } from "../../agents/agent-run-terminal-reply.js";
import { resolveCronDeliveryPlan } from "../../cron/delivery-plan.js";
import { dispatchCronDelivery } from "../../cron/isolated-agent/delivery-dispatch.js";
import { makeBaseParams } from "../../cron/isolated-agent/delivery-dispatch.test-fixtures.js";
import { readCronRunHistoryPageForTests } from "../../cron/run-history.test-support.js";
import { CronService, type CronEvent } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import type { RespondFn } from "../../gateway/server-methods/types.js";
import {
  captureGatewayRootWorkReleaseObserver as observeRelease,
  getActiveGatewayRootWorkCount as activeRootCount,
  getActiveGatewayRootWorkHolders as activeRootHolders,
} from "../../process/gateway-work-admission.js";
import { ExitError } from "../../runtime.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const mocks = vi.hoisted(() => ({
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
  callGatewayFromCli: vi.fn(),
}));

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return { ...actual, callGatewayFromCli: mocks.callGatewayFromCli };
});
vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return { ...actual, defaultRuntime: mocks.runtime };
});

const { registerCronCli } = await import("../cron-cli.js");
const announce = { mode: "announce", channel: "telegram", to: "123456" } as const;
const waitOptions = ["--wait", "--wait-timeout", "10s", "--poll-interval", "10ms"];
const executionError = "fixture agent execution failed";
const deliveryError = "fixture delivery route unavailable";
const phases = [
  ["silent", "ok", "succeeded", "not-delivered", false],
  ["delivery-error", "ok", "succeeded", "not-delivered", false],
  ["required-delivery-error", "error", "failed", "not-delivered", false],
  ["execution-error", "error", "failed", "unknown", undefined],
  ["silent", "ok", "succeeded", "not-delivered", false],
  ["not-requested", "ok", "succeeded", "not-requested", false],
] as const;

type Suppression = Pick<CronEvent, "deliverySuppressionReason">;
type Release = "settled" | "reset";

async function runCli<T = unknown>(args: string[]) {
  for (const mock of Object.values(mocks.runtime)) {
    mock.mockClear();
  }
  const program = new Command().exitOverride();
  registerCronCli(program);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["cron", ...args], { from: "user" });
  } catch (error) {
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exitCode = error.code;
  }
  expect(mocks.runtime.error).not.toHaveBeenCalled();
  return {
    text: mocks.runtime.log.mock.calls.map(([line]) => String(line)).join("\n"),
    json: mocks.runtime.writeJson.mock.calls.at(-1)?.[0] as T,
    exitCode,
  };
}

function installGatewayTransport(cron: CronService, storePath: string) {
  const invoke = async (method: string, params: Record<string, unknown> = {}) => {
    const handler = expectDefined(cronHandlers[method], `missing Gateway method ${method}`);
    const respond = vi.fn<RespondFn>();
    await handler({
      req: {} as never,
      client: null,
      params,
      respond,
      context: { cron, cronStorePath: storePath, getRuntimeConfig: () => ({}) } as never,
    } as never);
    const [ok, payload, error] = expectDefined(
      respond.mock.calls.at(-1),
      `${method} returned no response`,
    );
    expect(ok, error?.message).toBe(true);
    // JSON wire encoding drops undefined fields; structuredClone would preserve them.
    // oxlint-disable-next-line unicorn/prefer-structured-clone
    return JSON.parse(JSON.stringify(payload)) as unknown;
  };
  mocks.callGatewayFromCli.mockImplementation(
    async (method: string, _options: unknown, params?: Record<string, unknown>) =>
      invoke(method, params),
  );
  return invoke;
}

afterEach(() => {
  mocks.callGatewayFromCli.mockReset();
  vi.restoreAllMocks();
});

it("cron CLI distinguishes silence from failures across repeated runs", async ({ signal }) => {
  await withOpenClawTestState(
    { layout: "home", prefix: "openclaw-cron-cli-suppression-" },
    async (state) => {
      await state.writeConfig({});
      const storePath = state.statePath("cron", "jobs.json");
      const events: CronEvent[] = [];
      let runReleased: Promise<Release> | undefined;
      let phase: (typeof phases)[number][0] = "silent";
      const runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"] = async ({
        job,
        abortSignal,
        deliveryAttemptFence,
      }) => {
        const released = createDeferred<Release>();
        expectDefined(observeRelease(), "missing cron root work admission")(released.resolve);
        runReleased = released.promise;
        if (phase === "execution-error") {
          throw new Error(executionError);
        }
        const { text, terminalReply } = prepareAgentRunTerminalReply({
          rawText: phase === "silent" ? "NO_REPLY" : "Actionable update",
        });
        const sessionId = randomUUID();
        const sessionKey = `agent:main:cron:${job.id}:run:${sessionId}`;
        const now = Date.now();
        const base = makeBaseParams({ synthesizedText: text, runStartedAt: now });
        const dispatch = await dispatchCronDelivery({
          ...base,
          deliveryAttemptFence,
          job,
          agentSessionKey: sessionKey,
          runSessionKey: sessionKey,
          sessionId,
          lifecycleRevision: randomUUID(),
          sessionUpdatedAt: now,
          timeoutMs: 5_000,
          resolvedDelivery:
            phase === "delivery-error" || phase === "required-delivery-error"
              ? { ok: false, mode: "explicit", error: new Error(deliveryError) }
              : base.resolvedDelivery,
          deliveryPlan: resolveCronDeliveryPlan(job),
          deliveryRequested: phase !== "not-requested",
          skipDelivery: terminalReply.disposition === "silent" ? "silent" : undefined,
          deliveryBestEffort: job.delivery?.bestEffort === true,
          abortSignal,
          isAborted: () => abortSignal?.aborted === true,
          abortReason: () => "fixture aborted",
        });
        const failure = dispatch.disposition?.kind === "error" ? dispatch.disposition : undefined;
        return {
          status: failure ? "error" : "ok",
          error: failure?.error,
          errorKind: failure?.errorKind,
          sessionId,
          sessionKey,
          delivered: dispatch.delivered,
          deliveryAttempted: dispatch.deliveryAttempted,
          deliveryError: dispatch.deliveryError,
          deliverySuppressionReason: dispatch.deliverySuppressionReason,
          deliveryState: dispatch.deliveryState,
        };
      };
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        defaultAgentId: "main",
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
        onEvent: (event) => {
          if (event.action === "finished") {
            events.push(event);
          }
        },
      });
      const invoke = installGatewayTransport(cron, storePath);
      try {
        await cron.start();
        const job = await cron.add({
          name: "idle-check",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "Check for work; reply NO_REPLY when idle." },
          delivery: announce,
        });
        const historyQuery = { storeKey: cronStoreKey(storePath), jobId: job.id };
        const readHistory = () => readCronRunHistoryPageForTests(historyQuery);
        for (const [phaseName, status, completion, delivery, delivered] of phases) {
          phase = phaseName;
          await cron.update(job.id, {
            delivery:
              phase === "not-requested"
                ? { mode: "none" }
                : { ...announce, bestEffort: phase === "delivery-error" },
          });
          runReleased = undefined;
          const run = await runCli<{ run: Suppression }>(["run", job.id, ...waitOptions]);
          const failed = status === "error";
          expect(run.exitCode).toBe(failed ? 1 : 0);
          // CLI completion can observe history before the queued run releases its root.
          const pending = expectDefined<Promise<Release>>(runReleased, "cron run did not start");
          expect(await withinTest(pending, signal)).toBe("settled");
          expect(activeRootCount(), `${phase}: ${activeRootHolders().join(", ")}`).toBe(0);

          const reason = phase === "silent" ? "silent" : undefined;
          const { state: saved } = expectDefined(
            (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id),
            "expected persisted cron job",
          );
          expect(saved).toMatchObject({ lastRunStatus: status, lastDeliveryStatus: delivery });
          expect(saved.lastDelivered).toBe(delivered);
          const latest = readHistory().entries[0];
          const outcome = { status, completionStatus: completion };
          expect(latest).toMatchObject({ ...outcome, deliveryStatus: delivery });
          expect(latest?.delivered).toBe(delivered);
          expect(run.json).toMatchObject({
            completed: true,
            ...outcome,
            run: { ...outcome, deliveryStatus: delivery },
          });
          if (phase === "silent" || phase === "not-requested") {
            expect([saved.lastError, saved.lastDeliveryError, latest?.deliveryError]).toEqual(
              Array(3).fill(undefined),
            );
          } else {
            expect(saved.lastDeliveryError).toContain(
              phase === "execution-error" ? executionError : deliveryError,
            );
          }
          const get = (await runCli<CronJob & Suppression>(["get", job.id])).json;
          const compact = (await invoke("cron.list", { compact: true })) as { jobs: Suppression[] };
          const listJson = (await runCli<{ jobs: CronJob[] }>(["list", "--json"])).json;
          expect([
            saved.deliverySuppressionReason,
            latest?.deliverySuppressionReason,
            events.at(-1)?.deliverySuppressionReason,
            run.json.run.deliverySuppressionReason,
            get.deliverySuppressionReason,
            get.state.deliverySuppressionReason,
            compact.jobs[0]?.deliverySuppressionReason,
            listJson.jobs[0]?.state.deliverySuppressionReason,
          ]).toEqual(Array(8).fill(reason));
          const list = await runCli(["list"]);
          const show = await runCli(["show", job.id]);
          if (isRich()) {
            const color = failed
              ? theme.error
              : phase === "delivery-error"
                ? theme.warn
                : theme.success;
            const probe = color("probe");
            const expectedAnsi = probe.slice(0, probe.indexOf("probe"));
            expect(expectedAnsi).not.toBe("");
            expect.soft(list.text).toContain(`${expectedAnsi}${status}`);
          }
          if (phase === "silent") {
            for (const text of [list.text, show.text]) {
              expect.soft(text).toMatch(/silent|suppressed/i);
              expect.soft(text).not.toContain("ok (not delivered)");
            }
          } else if (phase === "delivery-error") {
            expect(list.text).toContain("ok (not delivered)");
            expect(show.text).toContain(`last delivery error: ${deliveryError}`);
          } else {
            expect(show.text).toContain(`status: ${status}`);
            expect(show.text).not.toContain("ok (not delivered)");
          }
        }
        expect(events).toHaveLength(6);
        expect(readHistory().total).toBe(6);
      } finally {
        cron.stop();
      }
    },
  );
}, 30_000);
