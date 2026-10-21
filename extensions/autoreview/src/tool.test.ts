import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createAutoReviewTool } from "./tool.js";

type Host = Parameters<typeof createAutoReviewTool>[0];
type Command = Host["runtime"]["system"]["runCommandWithTimeout"];
type CommandOptions = Exclude<Parameters<Command>[1], number>;
const jsonResult = (value: unknown, code = 0, stderr = "") => ({
  code,
  stdout: JSON.stringify(value),
  stderr,
});
const params = { mode: "local" as const };
const prompt = "Review the frozen shipping change.";
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
    result?: Partial<Awaited<ReturnType<Command>>>;
    helperFailure?: string;
    request?: Record<string, unknown>;
    next?: Record<string, unknown>;
  } = {},
) {
  const request = {
    protocol: "autoreview-exec-v1",
    run_id: "fixture-run",
    pass: 1,
    passes: 1,
    prompt,
    prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    model: "fixture/preferred",
    thinking: null,
    max_result_bytes: 2_000_000,
    admitted_model: true,
    engine_timeout_seconds: null,
    ...overrides.request,
  };
  const helper = Promise.withResolvers<ReturnType<typeof jsonResult>>();
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
      stdout: "complete",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "normal",
      noOutputTimedOut: false,
      ...overrides.result,
    };
  });
  const admitted = vi.fn<(selection: { model: string | null; explicit: boolean }) => void>();
  const context: OpenClawPluginToolContext<2> = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    runtimeConfig: { tools: rootTools, agents: { entries: { caller: { tools: callerTools } } } },
    modelExecution: {
      cliEntryPath: "/host/openclaw/openclaw.mjs",
      async run(selection, action, signal) {
        admitted(selection);
        const activeSignal = signal ?? new AbortController().signal;
        const result = await action(scope(activeSignal, selection.model ?? "fixture/default"));
        activeSignal.throwIfAborted();
        return result;
      },
    },
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
            helper.resolve(
              jsonResult(
                {
                  code: 1,
                  report: overrides.helperFailure ? null : report,
                  status: overrides.helperFailure
                    ? null
                    : { report_produced: true, effective_models: [request.model] },
                },
                response?.status === "done" ? 1 : 2,
                overrides.helperFailure ??
                  (response?.status === "done" ? "" : "reviewer unavailable"),
              ),
            );
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return jsonResult(
          argv.some((arg) => arg.endsWith("/1.request.json"))
            ? request
            : { ...request, pass: 2, ...overrides.next },
        );
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
    argv: () => command.mock.calls[0]![0],
  };
}

it("uses canonical settings and transfers complete output", async () => {
  const output = "x".repeat(100000);
  const test = fixture({
    result: { stdout: output },
    request: {
      config_override: {
        models: { providers: { fixture: { localService: { command: "/untrusted/host" } } } },
      },
      agent_override: { skills: ["private-host-skill"] },
    },
  });
  const result = await test.execute();
  const text = JSON.stringify({
    report,
    status: { report_produced: true, effective_models: ["fixture/preferred"] },
  });
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(test.response()).toMatchObject({ status: "done", output, model: "fixture/preferred" });
  for (const flag of ["--model", "--thinking", "--engine-timeout-seconds", "--max-review-passes"]) {
    expect(test.helperArgv()).not.toContain(flag);
  }
  const argv = test.argv();
  expect(argv).toEqual(expect.arrayContaining(["--code-mode", "direct"]));
  for (const flag of ["--model", "--thinking", "--timeout"]) {
    expect(argv).not.toContain(flag);
  }
  const overrides = argv.flatMap((arg, index) =>
    arg === "--config-override" ? [JSON.parse(argv[index + 1]!)] : [],
  );
  const caller = {
    skills: [],
    contextInjection: "never",
    nativeRuntimeConsent: [],
    model: { primary: "fixture/preferred", fallbacks: [] },
    tools: restrictedTools("Fixture/Preferred"),
  };
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
        entries: { caller },
      },
    },
  ]);
  expect(test.admitted.mock.calls[0]![0]).toEqual({ model: "fixture/preferred", explicit: false });
  await expect(fs.stat(path.dirname(test.cwd()!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses changed defaults and forwards requested overrides", async () => {
  const test = fixture({ request: { model: "fixture/new-default", thinking: "high" } });
  await test.execute({ ...params, maxPriority: "P2", passes: 12, timeoutSeconds: 900 });
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
  expect(test.argv()).toEqual(expect.arrayContaining(["--thinking", "high"]));
});

it.each([{ model: "fixture/substituted" }, { passes: 3 }])(
  "rejects a substituted later plan: %j",
  async (next) => {
    const test = fixture({ request: { passes: 2 }, next });
    await expect(test.execute()).rejects.toThrow("substituted prepared pass");
    expect(test.command).toHaveBeenCalledOnce();
  },
);

it.each([
  ["old helper", { admitted_model: undefined }, params, "update the Auto Review skill"],
  [
    "model substitution",
    { model: "fixture/substituted" },
    { ...params, model: "fixture/preferred" },
    "substituted prepared pass",
  ],
  ["pass count", {}, { passes: 0 }, "Invalid Auto Review arguments"],
  ["timeout", {}, { timeoutSeconds: 0 }, "Invalid Auto Review arguments"],
  ["host binary", {}, { openclawBin: "/untrusted" }, "Invalid Auto Review arguments"],
] as const)("rejects %s before execution", async (_name, request, input, error) => {
  const test = fixture({ request });
  await expect(test.execute({ ...params, ...input })).rejects.toThrow(error);
  expect(test.command).not.toHaveBeenCalled();
});

it.each([
  [{ code: 1, termination: "exit" }, "exit 1, exit, cleanup normal"],
  [{ code: null, termination: "timeout", killed: true }, "exit none, timeout"],
] as const)(
  "reports CLI failure %j with bounded redacted diagnostics",
  async (result, diagnostic) => {
    const test = fixture({
      result: {
        ...result,
        stderr: `${"x".repeat(5000)}\nAuthorization: Bearer unrelated-fake-secret-token`,
      },
    });
    const failure = await test.execute().catch((error: unknown) => error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected reviewer failure");
    }
    expect(failure.message).toContain("reviewer unavailable");
    expect(failure.message).toContain(`Reviewer command failed (${diagnostic}`);
    expect(failure.message).not.toContain("unrelated-fake-secret-token");
    expect(failure.message.length).toBeLessThan(4300);
    expect(test.response()).toMatchObject({ status: "failed", output: null, model: null });
    expect(test.command).toHaveBeenCalledOnce();
  },
);

it("preserves helper diagnostics without a report", async () => {
  const diagnostic =
    "source changed after the review bundle was created; rerun autoreview against the updated tree";
  await expect(fixture({ helperFailure: diagnostic }).execute()).rejects.toThrow(diagnostic);
});

it.each(["installation", "authority"])("requires protected %s", (requirement) => {
  const { host, context } = fixture();
  if (requirement === "installation") {
    context.sandbox!.installedSkillRoots = {};
  } else {
    context.modelExecution = undefined;
  }
  expect(createAutoReviewTool(host, context)).toBeNull();
});

it.each([null, 900.25])(
  "retains canonical per-pass timeout %s across the complete plan",
  async (timeoutSeconds) => {
    const test = fixture({ request: { passes: 2, engine_timeout_seconds: timeoutSeconds } });
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

it.each(["caller", "model authority"])(
  "cancels the helper and reviewer after %s revocation",
  async (owner) => {
    const test = fixture();
    const caller = new AbortController();
    const model = new AbortController();
    const started = Promise.withResolvers<CommandOptions>();
    const cancellation = new Error("Review cancelled");
    if (owner === "model authority") {
      test.context.modelExecution!.run = async (_selection, action) =>
        await action(scope(model.signal));
    }
    test.command.mockImplementation(async (_argv, options) => {
      if (typeof options === "number") {
        throw new Error("expected process options");
      }
      started.resolve(options);
      const cancelled = Promise.withResolvers<Awaited<ReturnType<Command>>>();
      options.signal?.addEventListener("abort", () => cancelled.reject(cancellation), {
        once: true,
      });
      return await cancelled.promise;
    });
    const result = test.execute(params, caller.signal);
    const rejected = expect(result).rejects.toThrow("Review cancelled");
    const options = await started.promise;
    (owner === "caller" ? caller : model).abort(cancellation);
    await rejected;
    expect(options.signal?.aborted).toBe(true);
    expect(test.response()).toBeUndefined();
    await expect(fs.stat(path.dirname(options.cwd!))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
