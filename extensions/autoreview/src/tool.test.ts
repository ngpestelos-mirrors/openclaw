import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createAutoReviewTool } from "./tool.js";

type Host = Parameters<typeof createAutoReviewTool>[0];
type Command = Host["runtime"]["system"]["runCommandWithTimeout"];
const params = { mode: "local" as const };
const report = {
  findings: [{ title: "[P2] Keep the threshold inclusive" }],
  verdict: "request_changes",
};
const emptyTools = { allow: [], alsoAllow: [] };
const restrictedTools = (provider: string) => ({
  ...emptyTools,
  byProvider: { [provider]: emptyTools },
  sandbox: { tools: emptyTools },
});
const scope = (signal: AbortSignal, model = "fixture/preferred") => ({
  model,
  agentId: "caller",
  signal,
  assertCurrent: () => signal.throwIfAborted(),
});
const rootTools = {
  allow: ["exec"],
  byProvider: { FIXTURE: { alsoAllow: ["process"] } },
  sandbox: { tools: { allow: ["read"] } },
};
const callerTools = {
  alsoAllow: ["autoreview"],
  byProvider: { "Fixture/Preferred": { allow: ["write"] } },
  sandbox: { tools: { alsoAllow: ["process"] } },
  codeMode: { enabled: true },
};

function fixture(
  overrides: {
    model?: string;
    passes?: number;
    settingsModel?: string;
    settingsThinking?: string;
    output?: string;
    stderr?: string;
    exitCode?: number;
    helperFailure?: string;
    extraRequestFields?: Record<string, unknown>;
    secondPass?: Record<string, unknown>;
  } = {},
) {
  const prompt = "Review the frozen shipping change.";
  const reviewModel = overrides.settingsModel ?? "fixture/preferred";
  const reviewThinking = overrides.settingsThinking ?? null;
  const request = {
    protocol: "autoreview-exec-v1",
    run_id: "fixture-run",
    pass: 1,
    passes: overrides.passes ?? 1,
    prompt,
    prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    model: overrides.model ?? reviewModel,
    thinking: reviewThinking,
    max_result_bytes: 2_000_000,
    admitted_model: true,
    engine_timeout_seconds: null,
    ...overrides.extraRequestFields,
  };
  const helper = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  let response:
    | { pass: number; status: string; output: string | null; model: string | null }
    | undefined;
  let cwd: string | undefined;
  let helperArgv: readonly string[] | undefined;
  const command = vi.fn<Command>(async (argv, options) => {
    if (typeof options === "number") {
      throw new Error("expected process options");
    }
    expect(argv.slice(0, 2)).toEqual([process.execPath, "/host/openclaw/openclaw.mjs"]);
    expect(argv).not.toContain("--config");
    expect(argv).not.toContain("--isolated");
    expect(options.baseEnv).toBeUndefined();
    expect(options.input).toBe(prompt);
    expect(options).toMatchObject({ killProcessTree: true, killGraceMs: 5_000 });
    cwd = options.cwd;
    expect(await fs.readdir(cwd!)).toEqual([]);
    return {
      stdout: overrides.output ?? '{"ok":true,"status":"ok","final":"complete"}',
      stderr: overrides.stderr ?? "",
      code: overrides.exitCode ?? 0,
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "normal",
      noOutputTimedOut: false,
    };
  });
  const admitted = vi.fn<(selection: { model: string | null; explicit: boolean }) => void>();
  const run: NonNullable<OpenClawPluginToolContext["modelExecution"]>["run"] = async (
    selection,
    action,
    signal,
  ) => {
    admitted(selection);
    const result = await action(
      scope(signal ?? new AbortController().signal, selection.model ?? "fixture/default"),
    );
    signal?.throwIfAborted();
    return result;
  };
  const context: OpenClawPluginToolContext<2> = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    runtimeConfig: { tools: rootTools, agents: { entries: { caller: { tools: callerTools } } } },
    modelExecution: { cliEntryPath: "/host/openclaw/openclaw.mjs", run },
    sandbox: {
      workspaceDir: "/guest/current-repo",
      installedSkillRoots: { autoreview: "/protected/autoreview" },
      async run({ argv, input, signal }) {
        if (argv.includes("--native-handoff")) {
          helperArgv = argv;
          signal?.addEventListener(
            "abort",
            () => helper.reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
          return helper.promise;
        }
        if (argv.includes("--native-submit")) {
          response = JSON.parse(input!);
          if (response?.status !== "done" || response.pass === request.passes) {
            helper.resolve({
              code: response?.status === "done" ? 1 : 2,
              stdout: JSON.stringify({
                code: 1,
                report: overrides.helperFailure ? null : report,
                status: overrides.helperFailure
                  ? null
                  : { report_produced: true, effective_models: [reviewModel] },
              }),
              stderr:
                overrides.helperFailure ??
                (response?.status === "done" ? "" : "reviewer unavailable"),
            });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: argv.some((arg) => arg.endsWith("/1.request.json"))
            ? JSON.stringify(request)
            : JSON.stringify({ ...request, pass: 2, ...overrides.secondPass }),
          stderr: "",
        };
      },
    },
  };
  const host: Host = { runtime: { system: { runCommandWithTimeout: command } } };
  const tool = createAutoReviewTool(host, context)!;
  return {
    host,
    context,
    command,
    admitted,
    execute: (input: Parameters<typeof tool.execute>[1] = params, signal?: AbortSignal) =>
      tool.execute("review", input, signal),
    response: () => response,
    cwd: () => cwd,
    helperArgv: () => helperArgv,
  };
}

it("uses canonical settings and transfers complete output", async () => {
  const output = JSON.stringify({
    ok: true,
    status: "ok",
    final: "x".repeat(100000),
    model: "preferred",
    provider: "fixture",
  });
  const test = fixture({
    output,
    extraRequestFields: {
      config_override: {
        models: { providers: { fixture: { localService: { command: "/untrusted/host" } } } },
      },
      agent_override: { skills: ["private-host-skill"] },
    },
  });
  const result = await test.execute();
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        report,
        status: { report_produced: true, effective_models: ["fixture/preferred"] },
      }),
    },
  ]);
  expect(test.response()).toMatchObject({ status: "done", output, model: "fixture/preferred" });
  for (const flag of ["--model", "--thinking", "--engine-timeout-seconds", "--max-review-passes"]) {
    expect(test.helperArgv()).not.toContain(flag);
  }
  const argv = test.command.mock.calls[0]![0];
  expect(argv).toEqual(expect.arrayContaining(["--code-mode", "direct"]));
  for (const flag of ["--model", "--thinking", "--timeout"]) {
    expect(argv).not.toContain(flag);
  }
  const overrides = argv.flatMap((arg, index) =>
    arg === "--config-override" ? [JSON.parse(argv[index + 1]!)] : [],
  );
  expect(overrides).toEqual([
    {
      tools: {
        ...restrictedTools("FIXTURE"),
        deny: ["*"],
        toolSearch: false,
        codeMode: { enabled: false },
      },
      agents: {
        defaults: { systemAgent: { agentId: "caller" } },
        entries: {
          caller: {
            skills: [],
            contextInjection: "never",
            nativeRuntimeConsent: [],
            model: { primary: "fixture/preferred", fallbacks: [] },
            tools: restrictedTools("Fixture/Preferred"),
          },
        },
      },
    },
  ]);
  expect(test.admitted.mock.calls[0]![0]).toEqual({ model: "fixture/preferred", explicit: false });
  await expect(fs.stat(path.dirname(test.cwd()!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses changed defaults and forwards requested overrides", async () => {
  const test = fixture({ settingsModel: "fixture/new-default", settingsThinking: "high" });
  await test.execute({
    ...params,
    maxPriority: "P2",
    passes: 12,
    timeoutSeconds: 900,
  });
  expect(test.admitted.mock.calls[0]![0]).toEqual({
    model: "fixture/new-default",
    explicit: false,
  });
  for (const pair of [
    ["--max-priority", "P2"],
    ["--max-review-passes", "12"],
    ["--engine-timeout-seconds", "900"],
  ]) {
    expect(test.helperArgv()).toEqual(expect.arrayContaining(pair));
  }
  expect(test.command.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--thinking", "high"]));
});

it.each([{ model: "fixture/substituted" }, { passes: 3 }])(
  "rejects a substituted later plan: %j",
  async (secondPass) => {
    const test = fixture({ passes: 2, secondPass });
    await expect(test.execute()).rejects.toThrow("substituted prepared pass");
    expect(test.command).toHaveBeenCalledOnce();
  },
);

it("rejects old helpers and substituted explicit models", async () => {
  const old = fixture({ extraRequestFields: { admitted_model: undefined } });
  await expect(old.execute()).rejects.toThrow("update the Auto Review skill");
  expect(old.command).not.toHaveBeenCalled();
  const changed = fixture({ model: "fixture/substituted" });
  await expect(changed.execute({ ...params, model: "fixture/preferred" })).rejects.toThrow(
    "substituted prepared pass",
  );
  expect(changed.command).not.toHaveBeenCalled();
});

it("reports CLI failures with bounded redacted diagnostics", async () => {
  const test = fixture({
    exitCode: 1,
    stderr: `${"x".repeat(5000)}\nAuthorization: Bearer unrelated-fake-secret-token`,
  });
  const failure = await test.execute().catch((error: unknown) => error);
  if (!(failure instanceof Error)) {
    throw new Error("Expected reviewer failure");
  }
  expect(failure.message).toContain("reviewer unavailable");
  expect(failure.message).toContain("Reviewer command failed (exit 1, exit, cleanup normal");
  expect(failure.message).not.toContain("unrelated-fake-secret-token");
  expect(failure.message.length).toBeLessThan(4300);
  expect(test.response()).toMatchObject({ status: "failed", output: null, model: null });
  expect(test.command).toHaveBeenCalledOnce();
});

it("preserves helper diagnostics without a report", async () => {
  const diagnostic =
    "source changed after the review bundle was created; rerun autoreview against the updated tree";
  await expect(fixture({ helperFailure: diagnostic }).execute()).rejects.toThrow(diagnostic);
});

it("requires protected installation and model authority", () => {
  const test = fixture();
  expect(
    createAutoReviewTool(test.host, {
      ...test.context,
      sandbox: { ...test.context.sandbox!, installedSkillRoots: {} },
    }),
  ).toBeNull();
  expect(
    createAutoReviewTool(test.host, { ...test.context, modelExecution: undefined }),
  ).toBeNull();
});

it.each([{ passes: 0 }, { timeoutSeconds: 0 }, { openclawBin: "/untrusted" }])(
  "rejects invalid arguments before execution: %j",
  async (override) => {
    const test = fixture();
    await expect(test.execute({ ...params, ...override })).rejects.toThrow(
      "Invalid Auto Review arguments",
    );
    expect(test.command).not.toHaveBeenCalled();
  },
);

it.each([null, 900.25])(
  "retains canonical per-pass timeout %s across the complete plan",
  async (timeoutSeconds) => {
    const test = fixture({
      passes: 2,
      extraRequestFields: { engine_timeout_seconds: timeoutSeconds },
    });
    await test.execute();
    expect(test.command).toHaveBeenCalledTimes(2);
    for (const [argv, options] of test.command.mock.calls) {
      if (timeoutSeconds === null) {
        expect(argv).not.toContain("--timeout");
      } else {
        expect(argv).toEqual(expect.arrayContaining(["--timeout", "901"]));
      }
      expect(options).toMatchObject({ timeoutMs: timeoutSeconds === null ? undefined : 900_250 });
    }
    expect(test.response()).toMatchObject({ pass: 2, status: "done" });
  },
);

it("reports reviewer timeouts as failures", async () => {
  const test = fixture();
  const run = test.command.getMockImplementation()!;
  test.command.mockImplementation(async (...args) => ({
    ...(await run(...args)),
    code: null,
    killed: true,
    termination: "timeout",
  }));
  await expect(test.execute()).rejects.toThrow("Reviewer command failed (exit none, timeout");
  expect(test.response()).toMatchObject({ status: "failed", output: null });
  expect(test.command).toHaveBeenCalledOnce();
});

it.each(["caller", "model authority"])(
  "cancels the helper and reviewer after %s revocation",
  async (owner) => {
    const test = fixture();
    const caller = new AbortController();
    const model = new AbortController();
    const started = Promise.withResolvers<void>();
    const cancellation = new Error("Review cancelled");
    let reviewerSignal: AbortSignal | undefined;
    let cwd: string | undefined;
    if (owner === "model authority") {
      test.context.modelExecution!.run = async (_selection, action) =>
        await action(scope(model.signal));
    }
    test.command.mockImplementation(async (_argv, options) => {
      if (typeof options === "number") {
        throw new Error("expected process options");
      }
      reviewerSignal = options.signal;
      cwd = options.cwd;
      started.resolve();
      const cancelled = Promise.withResolvers<Awaited<ReturnType<Command>>>();
      options.signal?.addEventListener("abort", () => cancelled.reject(cancellation), {
        once: true,
      });
      return await cancelled.promise;
    });
    const result = test.execute(params, caller.signal);
    const rejected = expect(result).rejects.toThrow("Review cancelled");
    await started.promise;
    (owner === "caller" ? caller : model).abort(cancellation);
    await rejected;
    expect(reviewerSignal?.aborted).toBe(true);
    expect(test.response()).toBeUndefined();
    await expect(fs.stat(path.dirname(cwd!))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
