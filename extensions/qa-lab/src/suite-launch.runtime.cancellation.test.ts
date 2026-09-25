import fs from "node:fs/promises";
import path from "node:path";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { QaSuiteCleanupError, QaSuiteInfraError } from "./errors.js";
import * as evidenceSummary from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { runQaSuite, runQaSuiteWithInfraRetry } from "./suite-launch.runtime.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import {
  runQaFlowSuiteCleanupPlan,
  throwQaSuiteCleanupErrors,
  type QaSuiteRunParams,
  type QaSuiteSummaryJson,
} from "./suite.js";

// Register shared mocks before production imports, independent of import sorting.
const {
  blockNextQaFlowSuite,
  blockNextQaTestFileRun,
  createDeferred,
  makeTempRepo,
  prepareDockerE2eEnvironment,
  replaceFileAtomicMock,
  requireDefaultQaFlowSuiteImplementation,
  runPluginCommandWithTimeout,
  runQaFlowSuite,
  runQaTestFileScenarios,
} = await vi.hoisted(() => import("./suite-launch.runtime.test-support.js"));

describe("qa suite runtime cancellation", () => {
  it("does not retry an infrastructure failure after cancellation", async () => {
    const controller = new AbortController();
    const failure = new QaSuiteInfraError("agent_wait_failed", "agent.wait failed");
    const run = vi.fn(async () => {
      controller.abort(new Error("suite cancelled"));
      throw failure;
    });

    await expect(runQaSuiteWithInfraRetry(run, 1, controller.signal)).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not retain a recovered confirmed-cleanup failure as terminal", async () => {
    const diagnostic = Object.assign(new Error("cleanup socket reset"), {
      code: "ECONNRESET",
    });
    runQaFlowSuite.mockImplementationOnce(async () => {
      const cleanupFailures = await runQaFlowSuiteCleanupPlan({
        cleanupTransportBeforeGatewayStop: async () => {},
        cleanupTransportAfterGatewayStop: async () => {},
        stopGateway: async () => ({
          process: "confirmed-stopped",
          errors: [diagnostic],
        }),
        disposeAgentHarnesses: async () => {},
        finishLab: async () => {},
      });
      throwQaSuiteCleanupErrors({
        cleanupFailures,
        runFailed: false,
        runError: undefined,
      });
    });
    const result = await runQaSuite({
      repoRoot: await makeTempRepo("qa-unified-cleanup-retry-"),
      providerMode: "mock-openai",
      concurrency: 1,
      scenarioIds: ["channel-chat-baseline", "control-ui-chat-flow-playwright"],
    });
    expect(result.executionKind).toBe("suite");
    expect(runQaFlowSuite).toHaveBeenCalledTimes(2);
    expect(runQaTestFileScenarios).toHaveBeenCalledOnce();
    expect(result.result.scenarios.map(({ status }) => status)).toEqual(["pass", "pass"]);
    await fs.access(result.result.reportPath);
  });

  it("stops sibling retries after fatal cleanup and joins admitted work", async () => {
    const repoRoot = await makeTempRepo("qa-unified-fatal-retry-");
    const outputDir = path.join(repoRoot, "out");
    const makeAttempt = (id: string) => ({
      id,
      attempts: 0,
      started: createDeferred(),
      release: createDeferred(),
      captured: createDeferred(),
    });
    const fatalTask = makeAttempt("fatal");
    const retryTask = makeAttempt("retry");
    const healthyTask = makeAttempt("healthy");
    const queuedTask = makeAttempt("queued");
    const tasks = [fatalTask, retryTask, healthyTask, queuedTask];
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const fatal = new QaSuiteCleanupError([new Error("unconfirmed child")], "fatal cleanup");
    const infra = new QaSuiteInfraError("agent_wait_failed", "sibling infrastructure failure");
    const defaultFlow = requireDefaultQaFlowSuiteImplementation();
    const build = evidenceSummary.buildQaSuiteEvidenceSummary;
    vi.spyOn(evidenceSummary, "buildQaSuiteEvidenceSummary").mockImplementation((params) => {
      const result = build(params);
      for (const row of result.entries) {
        if (row.result.status === "fail") {
          taskById.get(row.test.id)?.captured.resolve();
        }
      }
      return result;
    });
    runQaFlowSuite.mockImplementation(async (params: QaSuiteRunParams) => {
      const task = taskById.get(params.scenarioIds?.[0] ?? "");
      if (!task) {
        throw new Error("unexpected scenario dispatch");
      }
      task.attempts += 1;
      task.started.resolve();
      await task.release.promise;
      if (task === fatalTask) {
        throw fatal;
      }
      if (task === retryTask) {
        throw infra;
      }
      const result = await defaultFlow(params);
      return {
        ...result,
        evidence: {
          ...result.evidence,
          entries: [
            {
              test: { kind: "qa-scenario", id: task.id, title: task.id },
              coverage: [],
              result: { status: "pass" },
            },
          ],
        },
      };
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const published = vi.fn();
    const settled = vi.fn((value: unknown) => value);
    const publish = replaceFileAtomicMock.getMockImplementation();
    if (!publish) {
      throw new Error("expected real artifact publication");
    }
    replaceFileAtomicMock.mockImplementation(async (options) => {
      await publish(options);
      published();
    });
    const run = runQaSuite({
      repoRoot,
      outputDir,
      concurrency: 3,
      providerMode: "mock-openai",
      forwardParentSignals: false,
      channelDriver: "live",
      scenarioIds: tasks.map(({ id }) => id),
      scenarioDefinitions: tasks.map(({ id }) => makeQaSuiteTestScenario(id, { channel: id })),
      adapterFactories: [{ id: "portable-driver", matches: () => true, create: vi.fn() }],
    }).then(settled, settled);
    try {
      await Promise.all([fatalTask, retryTask, healthyTask].map(({ started }) => started.promise));
      fatalTask.release.resolve();
      await fatalTask.captured.promise;
      retryTask.release.resolve();
      await retryTask.captured.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(tasks.map(({ attempts }) => attempts)).toEqual([1, 1, 1, 0]);
      expect(settled).not.toHaveBeenCalled();
      expect(published).not.toHaveBeenCalled();
      healthyTask.release.resolve();
      const terminal = await run;
      if (!(terminal instanceof QaSuiteCleanupError)) {
        throw new Error("expected cleanup failure", { cause: terminal });
      }
      expect(terminal.errors[0]).toBe(fatal);
      expect(published).toHaveBeenCalledTimes(3);
      // SAFETY: all three publications and the joined settlement are asserted above.
      expect(published.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        settled.mock.invocationCallOrder[0]!,
      );
      expect(tasks.map(({ attempts }) => attempts)).toEqual([1, 1, 1, 0]);
      expect(stderr.mock.calls.flat().join("")).not.toContain("[qa-suite] infra retry");
      const summary = JSON.parse(
        await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
      ) as QaSuiteSummaryJson;
      const evidence = evidenceSummary.validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
      );
      expect(evidence.schemaVersion).toBe(3);
      const outcomes = evidenceSummary.projectQaEvidenceScenarioOutcomes(evidence);
      expect(outcomes.map(({ status }) => status)).toEqual(["fail", "fail", "pass", null]);
      expect(summary.counts).toEqual({ total: 3, failed: 2, passed: 1, skipped: 0 });
      expect(summary.scenarios.map(({ name, status }) => [name, status])).toEqual([
        ["fatal", "fail"],
        ["retry", "fail"],
        ["healthy", "pass"],
      ]);
      expect(summary.scenarios[1]).toMatchObject({
        evidenceOccurrenceId: outcomes[1]?.occurrenceId,
        details: expect.stringContaining(infra.message),
      });
      const report = await fs.readFile(path.join(outputDir, "qa-suite-report.md"), "utf8");
      for (const error of [fatal, infra]) {
        expect(report).toContain(error.message);
      }
    } finally {
      tasks.forEach(({ release }) => release.resolve());
      await run;
      replaceFileAtomicMock.mockImplementation(publish);
    }
  });

  it.each(["cancel", "failure"] as const)(
    "publishes native preparation %s without starting queued partitions",
    async (mode) => {
      const repoRoot = await makeTempRepo("qa-suite-preparation-stop-");
      const controller = new AbortController();
      const failure = new Error("native preparation cancelled");
      runPluginCommandWithTimeout.mockImplementationOnce(async () => {
        if (mode === "cancel") {
          controller.abort(failure);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: failure.message };
      });

      const result = await runQaSuite({
        repoRoot,
        outputDir: "out",
        signal: controller.signal,
        forwardParentSignals: false,
        scenarioIds: [
          "dm-chat-baseline",
          "auth-profile-doctor-migration-safety",
          "remote-log-tailing",
          "docker-npm-onboard-channel-agent",
        ],
      });

      expect(runPluginCommandWithTimeout).toHaveBeenCalledTimes(1);
      expect(runQaFlowSuite).not.toHaveBeenCalled();
      expect(runQaTestFileScenarios).not.toHaveBeenCalled();
      expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
      expect(result.result.scenarios).toHaveLength(2);
      expect(result.result.scenarios).toEqual([
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining(failure.message),
        }),
        expect.objectContaining({
          status: "fail",
          details: expect.stringContaining(failure.message),
        }),
      ]);
      await expect(fs.readFile(result.result.reportPath, "utf8")).resolves.toContain(
        failure.message,
      );
    },
  );

  it.each([0, 1])(
    "retains native preparation cleanup failure through publication (command code=%s)",
    async (code) => {
      const repoRoot = await makeTempRepo("qa-suite-preparation-cleanup-");
      const outputDir = path.join(repoRoot, "out");
      const failure = new Error("native preparation process cleanup unconfirmed");
      runPluginCommandWithTimeout.mockResolvedValueOnce({
        code,
        stdout: "",
        stderr: "build output",
      });
      vi.spyOn(processRuntime, "withCommandProcessScope").mockImplementationOnce(async (run) => {
        await run(() => {});
        throw failure;
      });
      const publicationEntered = createDeferred();
      const finishPublication = createDeferred();
      const publish = replaceFileAtomicMock.getMockImplementation();
      if (!publish) {
        throw new Error("expected real artifact publication");
      }
      replaceFileAtomicMock.mockImplementation(async (options) => {
        await publish(options);
        if (options.filePath === path.join(outputDir, "qa-suite-summary.json")) {
          publicationEntered.resolve();
          await finishPublication.promise;
        }
      });
      const settled = vi.fn((value: unknown) => value);
      const run = runQaSuite({
        repoRoot,
        outputDir,
        forwardParentSignals: false,
        scenarioIds: [
          "dm-chat-baseline",
          "auth-profile-doctor-migration-safety",
          "remote-log-tailing",
          "docker-npm-onboard-channel-agent",
        ],
      }).then(settled, settled);
      try {
        await publicationEntered.promise;
        expect(settled).not.toHaveBeenCalled();
        expect(runPluginCommandWithTimeout).toHaveBeenCalledOnce();
        expect(runQaFlowSuite).not.toHaveBeenCalled();
        expect(runQaTestFileScenarios).not.toHaveBeenCalled();
        expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
        const summary = JSON.parse(
          await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
        ) as QaSuiteSummaryJson;
        const evidence = evidenceSummary.validateQaEvidenceSummaryJson(
          JSON.parse(await fs.readFile(path.join(outputDir, "qa-evidence.json"), "utf8")),
        );
        expect(summary.run.status).toBe("completed");
        expect(summary.counts).toEqual({ total: 2, failed: 2, passed: 0, skipped: 0 });
        expect(
          evidenceSummary.projectQaEvidenceScenarioOutcomes(evidence).map(({ status }) => status),
        ).toEqual(["fail", "fail", null, null]);
        expect(await fs.readFile(path.join(outputDir, "qa-suite-report.md"), "utf8")).toContain(
          failure.message,
        );
        finishPublication.resolve();
        const terminal = await run;
        expect(terminal).toBeInstanceOf(QaSuiteCleanupError);
        if (!(terminal instanceof QaSuiteCleanupError)) {
          throw new Error("expected fatal preparation cleanup", { cause: terminal });
        }
        expect(terminal.errors).toHaveLength(1);
        const preparation = terminal.errors[0];
        expect(preparation).toBeInstanceOf(QaSuiteCleanupError);
        if (!(preparation instanceof QaSuiteCleanupError)) {
          throw new Error("expected preparation scope cleanup marker", { cause: preparation });
        }
        expect(preparation.errors).toHaveLength(1);
        expect(preparation.errors[0]).toBe(failure);
        expect(preparation.cause).toBe(failure);
        expect(terminal.cause).toBe(preparation);
      } finally {
        finishPublication.resolve();
        await run;
        replaceFileAtomicMock.mockImplementation(publish);
      }
    },
  );

  it("joins started partitions after cancellation without admitting queued work", async () => {
    const repoRoot = await makeTempRepo("qa-suite-cancel-join-");
    const controller = new AbortController();
    const shared = blockNextQaFlowSuite();
    const testFile = blockNextQaTestFileRun();
    const settled = vi.fn();
    const run = runQaSuite({
      repoRoot,
      outputDir: "out",
      concurrency: 2,
      signal: controller.signal,
      forwardParentSignals: false,
      scenarioIds: [
        "dm-chat-baseline",
        "group-visible-reply-tool",
        "control-ui-chat-flow-playwright",
        "remote-log-tailing",
        "docker-npm-onboard-channel-agent",
      ],
    });
    const observed = run.then(
      (result) => {
        settled();
        return result;
      },
      (error: unknown) => {
        settled();
        throw error;
      },
    );

    try {
      await Promise.all([shared.started, testFile.started]);
      controller.abort(new Error("suite cancelled"));
      shared.release();
      await shared.finished;
      expect(settled).not.toHaveBeenCalled();
      expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
      expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
      testFile.release();
      const result = await observed;

      expect(result.result.scenarios).toHaveLength(2);
      expect(result.result.scenarios.every((scenario) => scenario.status === "pass")).toBe(true);
      expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
      expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
      expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
      for (const child of [runQaFlowSuite, runQaTestFileScenarios]) {
        expect(child).toHaveBeenCalledWith(
          expect.objectContaining({
            signal: controller.signal,
            forwardParentSignals: false,
          }),
        );
      }
      const summary = JSON.parse(await fs.readFile(result.result.summaryPath, "utf8")) as {
        counts: { passed: number; total: number };
      };
      expect(summary.counts).toMatchObject({ passed: 2, total: 2 });
    } finally {
      shared.release();
      testFile.release();
      await observed.catch(() => {});
    }
  });

  it.each([false, true])(
    "joins siblings and preserves cleanup failure through terminal publication (write failure=%s)",
    async (failPublication) => {
      const repoRoot = await makeTempRepo("qa-suite-cleanup-publication-");
      const outputDir = path.join(repoRoot, "out");
      const failure = new QaSuiteCleanupError(
        [new Error("child process group did not settle")],
        "partition cleanup failed",
      );
      const publicationFailure = new Error("terminal report write failed");
      const testFile = blockNextQaTestFileRun();
      const lab = {
        baseUrl: "http://127.0.0.1:43124",
        listenUrl: "http://127.0.0.1:43124",
        runSelfCheck: vi.fn(),
        setControlUi: vi.fn(),
        setLatestReport: vi.fn(),
        setScenarioRun: vi.fn(),
        state: {} as QaLabServerHandle["state"],
        stop: vi.fn(),
      } satisfies QaLabServerHandle;
      const originalPublication = replaceFileAtomicMock.getMockImplementation()!;
      if (failPublication) {
        replaceFileAtomicMock.mockImplementation(async (options) => {
          if (options.filePath === path.join(outputDir, "qa-suite-report.md")) {
            throw publicationFailure;
          }
          return await originalPublication(options);
        });
      }
      runQaFlowSuite.mockRejectedValueOnce(failure);
      const settled = vi.fn();
      const run = runQaSuite({
        lab,
        repoRoot,
        outputDir,
        concurrency: 2,
        scenarioIds: [
          "dm-chat-baseline",
          "group-visible-reply-tool",
          "control-ui-chat-flow-playwright",
          "remote-log-tailing",
          "docker-npm-onboard-channel-agent",
        ],
      });
      const observed = run.then(
        (result) => {
          settled();
          return result;
        },
        (error: unknown) => {
          settled();
          return error;
        },
      );

      try {
        await testFile.started;
        expect(settled).not.toHaveBeenCalled();
        expect(lab.setLatestReport).not.toHaveBeenCalled();
        testFile.release();
        const error = await observed;

        expect(error).toBeInstanceOf(QaSuiteCleanupError);
        expect(error).toMatchObject({
          errors: failPublication ? [failure, publicationFailure] : [failure],
        });
        expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
        expect(runQaTestFileScenarios).toHaveBeenCalledTimes(1);
        expect(prepareDockerE2eEnvironment).not.toHaveBeenCalled();
        if (!failPublication) {
          const summary = JSON.parse(
            await fs.readFile(path.join(outputDir, "qa-suite-summary.json"), "utf8"),
          ) as { counts: { passed: number; failed: number; total: number } };
          expect(summary.counts).toMatchObject({ passed: 1, failed: 1, total: 2 });
          expect(lab.setLatestReport).toHaveBeenCalledWith(
            expect.objectContaining({ outputPath: path.join(outputDir, "qa-suite-report.md") }),
          );
          expect(lab.setScenarioRun).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: "completed" }),
          );
          expect(lab.setLatestReport.mock.invocationCallOrder[0]).toBeLessThan(
            settled.mock.invocationCallOrder[0]!,
          );
        }
      } finally {
        testFile.release();
        await observed;
        replaceFileAtomicMock.mockImplementation(originalPublication);
      }
    },
  );
});
