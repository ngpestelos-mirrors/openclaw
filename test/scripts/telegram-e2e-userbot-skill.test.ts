import childProcess, { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createDeferred, raceWithTimeoutResult } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptsDir = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");
const testNodeExecPath = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commandOptions = { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 } as const;

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (!hasNodeErrorCode(error, "ESRCH") && !hasNodeErrorCode(error, "EPERM"))
    ) {
      throw error;
    }
  }
}

async function killProcessTrees(roots: number[]) {
  if (!roots.length) {
    return;
  }
  const pids = new Set(roots);
  const groups = new Set(roots);
  // Freeze before killing: detached descendants must not fork or lose their ancestry.
  for (const group of groups) {
    signalGroup(group, "SIGSTOP");
  }
  try {
    let changed;
    do {
      changed = false;
      const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,ppid=,pgid="]);
      const rows = stdout
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/u).map(Number));
      let discovered;
      do {
        discovered = false;
        for (const [pid, ppid, pgid] of rows) {
          // Linux kernel threads report pgid 0; they are never test descendants.
          if (!pid || ppid === undefined || !pgid) {
            continue;
          }
          if (pids.has(pid) || pids.has(ppid) || groups.has(pgid)) {
            if (!groups.has(pgid)) {
              groups.add(pgid);
              signalGroup(pgid, "SIGSTOP");
              changed = true;
            }
            if (!pids.has(pid)) {
              pids.add(pid);
              discovered = changed = true;
            }
          }
        }
      } while (discovered);
    } while (changed);
  } finally {
    for (const group of groups) {
      signalGroup(group, "SIGKILL");
    }
  }
}

type NodeTestResult = {
  file: string;
  output: string;
  code: number | null;
  closed: boolean;
  error?: Error;
};

function startNodeTests(files: string[]) {
  // Separate reporters preserve completed files even when another file hangs.
  return files.map((file) => {
    const child = childProcess.spawn(
      testNodeExecPath,
      ["--test", "--test-isolation=none", "--test-reporter=spec", file],
      { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const result: NodeTestResult = { file, output: "", code: null, closed: false };
    const capture = (chunk: string) => {
      result.output += chunk;
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", capture);
    }
    child.on("error", (error) => {
      result.error = error;
    });
    const completion = new Promise<void>((resolve) => {
      child.once("close", (code) => {
        result.code = code;
        result.closed = true;
        resolve();
      });
    });
    return { child, result, completion };
  });
}

async function runNodeTests(
  runs: ReturnType<typeof startNodeTests>,
  deadline: Promise<unknown> | number,
) {
  const completed = Promise.all(runs.map((run) => run.completion));
  const settled = completed.then(() => false);
  const overrun = await (typeof deadline === "number"
    ? raceWithTimeoutResult(settled, deadline, true)
    : Promise.race([settled, deadline.then(() => true)]));
  const unfinished = new Set(overrun ? runs.filter((run) => !run.result.closed) : []);
  if (unfinished.size) {
    await killProcessTrees([...unfinished].flatMap(({ child }) => (child.pid ? [child.pid] : [])));
    await raceWithTimeoutResult(completed, 5_000, undefined);
  }
  const failures = runs.flatMap((run) => {
    const { file, output, code, closed, error } = run.result;
    if (unfinished.has(run)) {
      return [`${file}: unfinished at deadline; closed=${closed}\n${output.slice(-8_192)}`];
    }
    return code !== 0 || error
      ? [`${file}: exit=${code}${error ? `; ${error.message}` : ""}\n${output}`]
      : [];
  });
  return { results: runs.map((run) => run.result), failure: failures.join("\n\n") };
}

function requireSuccess(command: string, args: string[]) {
  const result = spawnSync(command, args, commandOptions);
  expect(result.error, `${result.stdout}${result.stderr}`).toBeUndefined();
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
}

function scriptTests(suffix: string) {
  return fs
    .readdirSync(scriptsDir)
    .filter((entry) => entry.endsWith(suffix))
    .toSorted()
    .map((entry) => path.join(scriptsDir, entry));
}

describe("repository Telegram E2E skill", () => {
  it("registers its UI metadata through the skill interface", () => {
    const descriptor = parse(
      fs.readFileSync(".agents/skills/telegram-e2e-userbot/agents/openai.yaml", "utf8"),
    );
    expect(Object.keys(descriptor)).toEqual(["interface"]);
    expect(descriptor.interface.default_prompt).toContain("$telegram-e2e-userbot");
  });

  it("passes its Node test suite", async () => {
    const tests = scriptTests(".test.mjs");
    expect(tests.length).toBeGreaterThan(0);
    const { failure } = await runNodeTests(startNodeTests(tests), 110_000);
    expect(failure, failure).toBe("");
  });

  it("attributes unfinished files and kills detached descendants at the deadline", async () => {
    const root = tempDirs.make("telegram-suite-deadline-");
    const ok = path.join(root, "ok.test.mjs");
    const hang = path.join(root, "hang.test.mjs");
    const socketReady = createDeferred();
    const socketClosed = createDeferred();
    let runs: ReturnType<typeof startNodeTests> = [];
    let socket: net.Socket | undefined;
    const server = net.createServer((connection) => {
      socket = connection;
      connection.once("close", () => socketClosed.resolve());
      connection.resume();
      socketReady.resolve();
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture port");
      }
      fs.writeFileSync(ok, 'import test from "node:test"; test("passes", () => {});');
      fs.writeFileSync(
        hang,
        `
        import test from "node:test";
        import { spawn } from "node:child_process";
        test("hangs", async () => {
          spawn(process.execPath, ["-e", 'require("node:net").connect(${address.port}, "127.0.0.1")'], { detached: true, stdio: "ignore" });
          await new Promise(() => {});
        });
      `,
      );
      runs = startNodeTests([ok, hang]);
      // Both observable events gate the deadline, independent of child scheduling.
      const deadline = Promise.all([socketReady.promise, runs[0]!.completion]);
      const { results, failure } = await runNodeTests(runs, deadline);
      expect(failure).toContain("hang.test.mjs: unfinished at deadline; closed=true");
      expect(results.find((result) => result.file === ok)).toMatchObject({ code: 0, closed: true });
      await socketClosed.promise;
    } finally {
      await killProcessTrees(
        runs.flatMap(({ child }) =>
          child.pid && child.exitCode === null && child.signalCode === null ? [child.pid] : [],
        ),
      );
      socket?.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each(["pending", "exited"])("settles a %s triage fixture after readiness fails", (mode) => {
    const preload = new URL("../fixtures/triage-fixture-startup.mjs", import.meta.url);
    preload.searchParams.set("mode", mode);
    const result = spawnSync(
      testNodeExecPath,
      [
        "--import",
        preload.href,
        "--test",
        "--test-isolation=none",
        "--test-name-pattern=^emits interleaved visible and reasoning blocks$",
        path.join(scriptsDir, "triage-mock-openai.test.mjs"),
      ],
      commandOptions,
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain("AssertionError");
    expect(output).toContain("mock-openai listening");
    expect(result.stderr).toContain(
      `triage-fixture-exited:${mode === "exited" ? "42" : "SIGTERM"}`,
    );
  });

  it("passes its Python test suite", () => {
    const tests = scriptTests(".test.py");
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      requireSuccess("python3", [test]);
    }
  });
});
