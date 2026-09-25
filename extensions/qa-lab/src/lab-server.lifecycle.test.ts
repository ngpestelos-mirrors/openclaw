import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readQaJsonBody } from "./bus-server.js";
import { startQaLabServer, type QaLabScenarioRun, type QaLabServerHandle } from "./lab-server.js";

const mocks = vi.hoisted(() => ({
  runSuite: vi.fn(),
  runScenario: vi.fn(),
  gatewayStopped: vi.fn(),
  loadModels: vi.fn(),
  acquireCapture: vi.fn(),
  releaseCapture: vi.fn(),
}));

vi.mock("./suite-launch.runtime.js", () => ({ runQaSuite: mocks.runSuite }));
vi.mock("./scenario.js", () => ({ runQaScenario: mocks.runScenario }));
vi.mock("./model-catalog.runtime.js", () => ({ loadQaRunnerModelOptions: mocks.loadModels }));
vi.mock("./bus-server.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bus-server.js")>();
  return { ...actual, readQaJsonBody: vi.fn(actual.readQaJsonBody) };
});
vi.mock("openclaw/plugin-sdk/qa-channel", () => ({
  qaChannelPlugin: {
    config: {
      resolveAccount: (_cfg: unknown, accountId: string) => ({ accountId }),
    },
    gateway: {
      startAccount: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
          } else {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        await mocks.gatewayStopped();
      },
    },
  },
  setQaChannelRuntime: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  resolveDebugProxySettings: () => ({ proxyUrl: "" }),
  acquireDebugProxyCaptureStore: mocks.acquireCapture,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const labs: QaLabServerHandle[] = [];
const suiteInput = {
  channelDriver: "qa-channel",
  providerMode: "mock-openai",
  scenarioIds: ["dm-chat-baseline"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runSuite.mockReset();
  mocks.runScenario.mockResolvedValue({
    name: "Synthetic Slack-class roundtrip",
    status: "pass",
    steps: [{ name: "roundtrip", status: "pass" }],
  });
  mocks.gatewayStopped.mockReset();
  mocks.releaseCapture.mockReset();
  mocks.loadModels.mockResolvedValue([]);
  mocks.acquireCapture.mockReturnValue({
    store: { listSessions: () => [] },
    release: mocks.releaseCapture,
  });
});

afterEach(async () => {
  await Promise.allSettled(labs.splice(0).map((lab) => lab.stop()));
  vi.restoreAllMocks();
});

async function startLab() {
  const repoRoot = tempDirs.make("qa-lab-lifecycle-");
  const outputPath = path.join(repoRoot, "self-check.md");
  const lab = await startQaLabServer({ repoRoot, outputPath });
  labs.push(lab);
  return { lab, repoRoot, outputPath };
}

async function post(lab: QaLabServerHandle, route: string, body?: unknown) {
  return await fetch(`${lab.listenUrl}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function outcomes(lab: QaLabServerHandle): Promise<QaLabScenarioRun | null> {
  const response = await fetch(`${lab.listenUrl}/api/outcomes`);
  const payload = (await response.json()) as { run: QaLabScenarioRun | null };
  return payload.run;
}

function holdReportWrite(outputPath: string) {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const writeFile = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (file === outputPath) {
      entered.resolve();
      await release.promise;
    }
    await writeFile(file, data, options);
  });
  return { entered, release };
}

describe("QA Lab accepted-run lifecycle", () => {
  it("drains the accepted suite and its summary read before releasing shared resources", async () => {
    const { lab, repoRoot } = await startLab();
    const suiteEntered = createDeferred<void>();
    const finishSuite = createDeferred<void>();
    const summaryEntered = createDeferred<void>();
    const finishSummary = createDeferred<void>();
    const gatewayStopping = createDeferred<void>();
    const finishGateway = createDeferred<void>();
    const summaryPath = path.join(repoRoot, "qa-suite-summary.json");
    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        run: { status: "completed" },
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
        scenarios: [{ name: "Channel chat baseline", status: "pass", steps: [] }],
      }),
    );
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (file === summaryPath) {
        summaryEntered.resolve();
        await finishSummary.promise;
      }
      return await readFile(file, options);
    });
    mocks.gatewayStopped.mockImplementation(async () => {
      gatewayStopping.resolve();
      await finishGateway.promise;
    });
    mocks.runSuite.mockImplementation(async ({ lab: suppliedLab }) => {
      expect(suppliedLab).toBe(lab);
      suiteEntered.resolve();
      await finishSuite.promise;
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        scenarios: [{ id: "dm-chat-baseline", name: "Channel chat baseline", status: "pass" }],
      });
      return {
        result: {
          outputDir: repoRoot,
          evidencePath: path.join(repoRoot, "qa-evidence.json"),
          reportPath: path.join(repoRoot, "qa-suite-report.md"),
          report: "# Completed suite\n",
          summaryPath,
        },
      };
    });
    await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
    const reset = vi.spyOn(lab.state, "reset");
    try {
      const response = await post(lab, "/api/scenario/suite", suiteInput);
      expect(response.status).toBe(202);
      await response.json();
      await suiteEntered.promise;
      expect(reset).toHaveBeenCalledOnce();

      const stopping = lab.stop();
      expect(lab.stop()).toBe(stopping);
      await outcomes(lab);
      expect(mocks.gatewayStopped).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalledOnce();

      finishSuite.resolve();
      await summaryEntered.promise;
      await outcomes(lab);
      expect(mocks.gatewayStopped).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();

      finishSummary.resolve();
      await gatewayStopping.promise;
      expect(await outcomes(lab)).toMatchObject({
        status: "completed",
        counts: { passed: 1 },
      });
      const bootstrap = await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json();
      expect(bootstrap).toMatchObject({
        runner: { status: "completed" },
        latestReport: { markdown: "# Completed suite\n" },
      });
      expect(mocks.loadModels).not.toHaveBeenCalled();
      expect(mocks.releaseCapture).not.toHaveBeenCalled();

      finishGateway.resolve();
      await stopping;
      expect(lab.stop()).toBe(stopping);
      await lab.stop();
      expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
      expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      expect(reset).toHaveBeenLastCalledWith(true);
    } finally {
      finishSuite.resolve();
      finishSummary.resolve();
      finishGateway.resolve();
    }
  });

  it.each(["direct", "http"] as const)(
    "drains a %s self-check through report publication and rejects overlapping runs",
    async (entrypoint) => {
      const { lab, outputPath } = await startLab();
      const write = holdReportWrite(outputPath);
      const gatewayStopping = createDeferred<void>();
      const finishGateway = createDeferred<void>();
      mocks.gatewayStopped.mockImplementation(async () => {
        gatewayStopping.resolve();
        await finishGateway.promise;
      });
      const run =
        entrypoint === "direct"
          ? lab.runSelfCheck()
          : post(lab, "/api/scenario/self-check").then(async (response) => {
              expect(response.status).toBe(200);
              return await response.json();
            });
      const settled = run.catch((error: unknown) => error);
      try {
        await write.entered.promise;
        const running = await outcomes(lab);
        expect(running).toMatchObject({ status: "running", counts: { running: 1 } });
        for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
          const response = await post(lab, route, suiteInput);
          expect(response.status).toBe(409);
          await response.json();
        }
        await expect(lab.runSelfCheck()).rejects.toThrow("QA run already in progress");
        expect(await outcomes(lab)).toEqual(running);
        expect(mocks.runScenario).toHaveBeenCalledOnce();
        expect(mocks.runSuite).not.toHaveBeenCalled();

        const stopping = lab.stop();
        await outcomes(lab);
        expect(mocks.gatewayStopped).not.toHaveBeenCalled();
        write.release.resolve();
        const result = await settled;
        expect(result).toMatchObject({ outputPath });
        expect(await fs.readFile(outputPath, "utf8")).toContain("Synthetic Slack-class roundtrip");
        await gatewayStopping.promise;
        expect(await outcomes(lab)).toMatchObject({
          status: "completed",
          startedAt: running?.startedAt,
          counts: { passed: 1, failed: 0, running: 0 },
        });
        const report = await (await fetch(`${lab.listenUrl}/api/report`)).json();
        expect(report).toMatchObject({ report: { outputPath } });
        finishGateway.resolve();
        await stopping;
      } finally {
        write.release.resolve();
        finishGateway.resolve();
        await settled;
      }
    },
  );

  it.each(["direct", "http"] as const)(
    "records a failed %s self-check when report publication rejects",
    async (entrypoint) => {
      const { lab, outputPath } = await startLab();
      const write = holdReportWrite(outputPath);
      const failure = new Error("self-check report write failed");
      const run =
        entrypoint === "direct"
          ? lab.runSelfCheck()
          : post(lab, "/api/scenario/self-check").then(async (response) => {
              expect(response.status).toBe(500);
              return await response.json();
            });
      const settled = run.catch((error: unknown) => error);
      try {
        await write.entered.promise;
        const running = await outcomes(lab);
        write.release.reject(failure);
        const result = await settled;
        if (entrypoint === "direct") {
          expect(result).toBe(failure);
        } else {
          expect(result).toEqual({ error: failure.message });
        }
        expect(await outcomes(lab)).toMatchObject({
          kind: "self-check",
          status: "completed",
          startedAt: running?.startedAt,
          finishedAt: expect.any(String),
          counts: { total: 1, failed: 1, passed: 0, running: 0 },
          scenarios: [{ status: "fail", details: failure.message }],
        });
        expect(await (await fetch(`${lab.listenUrl}/api/report`)).json()).toEqual({ report: null });
        // A failure already delivered to its caller is not replayed by a later stop.
        await expect(lab.stop()).resolves.toBeUndefined();
      } finally {
        write.release.resolve();
        await settled;
      }
    },
  );

  it("fences requests awaiting their suite body without resetting or launching work", async () => {
    const { lab } = await startLab();
    const bodyEntered = createDeferred<void>();
    const finishBody = createDeferred<void>();
    const gatewayStopping = createDeferred<void>();
    const finishGateway = createDeferred<void>();
    const readBody = vi.mocked(readQaJsonBody).getMockImplementation()!;
    vi.mocked(readQaJsonBody).mockImplementationOnce(async (...args) => {
      bodyEntered.resolve();
      await finishBody.promise;
      return await readBody(...args);
    });
    mocks.gatewayStopped.mockImplementation(async () => {
      gatewayStopping.resolve();
      await finishGateway.promise;
    });
    lab.state.addInboundMessage({
      conversation: { id: "retained", kind: "direct" },
      senderId: "operator",
      text: "accepted state",
    });
    const snapshot = lab.state.getSnapshot();
    const reset = vi.spyOn(lab.state, "reset");
    const pending = post(lab, "/api/scenario/suite", suiteInput);
    try {
      await bodyEntered.promise;
      const stopping = lab.stop();
      await gatewayStopping.promise;
      finishBody.resolve();
      const response = await pending;
      expect(response.status).toBe(503);
      await response.json();
      await expect(lab.runSelfCheck()).rejects.toThrow("QA Lab is stopping");
      for (const route of ["/api/reset", "/api/scenario/self-check", "/api/scenario/suite"]) {
        const rejected = await post(lab, route, suiteInput);
        expect(rejected.status).toBe(503);
        await rejected.json();
      }
      const capture = await fetch(`${lab.listenUrl}/api/capture/sessions`);
      expect(capture.status).toBe(503);
      await capture.json();
      await (await fetch(`${lab.listenUrl}/api/bootstrap`)).json();
      expect(mocks.loadModels).not.toHaveBeenCalled();
      expect(mocks.acquireCapture).not.toHaveBeenCalled();
      expect(mocks.runSuite).not.toHaveBeenCalled();
      expect(mocks.runScenario).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(lab.state.getSnapshot()).toEqual(snapshot);
      finishGateway.resolve();
      await stopping;
    } finally {
      finishBody.resolve();
      finishGateway.resolve();
      await pending.catch(() => undefined);
    }
  });

  it("preserves the accepted failure and every cleanup failure in one cached stop", async () => {
    const { lab, outputPath } = await startLab();
    const write = holdReportWrite(outputPath);
    const runError = new Error("self-check write failed");
    const gatewayError = new Error("gateway stop failed");
    const captureError = new Error("capture release failed");
    mocks.gatewayStopped.mockRejectedValue(gatewayError);
    mocks.releaseCapture.mockImplementation(() => {
      throw captureError;
    });
    await (await fetch(`${lab.listenUrl}/api/capture/sessions`)).json();
    const run = lab.runSelfCheck().catch((error: unknown) => error);
    try {
      await write.entered.promise;
      const stopping = lab.stop();
      const stopped = stopping.catch((error: unknown) => error);
      expect(lab.stop()).toBe(stopping);
      await outcomes(lab);
      write.release.reject(runError);
      expect(await run).toBe(runError);
      const error = await stopped;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        cause: runError,
        errors: [runError, gatewayError, captureError],
      });
      expect(lab.stop()).toBe(stopping);
      await expect(lab.stop()).rejects.toBe(error);
      expect(mocks.gatewayStopped).toHaveBeenCalledOnce();
      expect(mocks.releaseCapture).toHaveBeenCalledOnce();
      await expect(fetch(`${lab.listenUrl}/healthz`)).rejects.toThrow();
    } finally {
      write.release.resolve();
      await run;
    }
  });
});
