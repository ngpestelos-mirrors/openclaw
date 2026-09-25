import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, vi } from "vitest";
import { createRuntimePublication } from "../../scripts/lib/runtime-publication.mts";
import { createDeferred } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { formatShimResult } from "./direct-run-entrypoints.test-support.js";
import {
  BUILD_STAMP,
  DIST_ENTRY,
  createCurrentGitSpawnRecorder,
  createExitedProcess,
  createFakeProcess,
  it,
  runNodeCommand,
  setupStampedProject,
} from "./run-node.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.for([
  { mode: "build", signal: "SIGINT" },
  { mode: "runtime", signal: "SIGTERM" },
] as const)(
  "joins canceled $mode preparation before cleanup ($signal)",
  async ({ mode, signal }, { tmp }) => {
    await setupStampedProject(tmp, { trackConfig: true });
    const before = fs.readFileSync(path.join(tmp, DIST_ENTRY), "utf8");
    const fakeProcess = createFakeProcess();
    const { spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const cli = vi.fn(spawn);
    const build = vi.fn(async () => 0);
    const postbuild = vi.fn(async () => {});
    const started = createDeferred();
    const release = createDeferred();
    const copy = fs.promises.cp.bind(fs.promises);
    let privateRoot = "";
    let writerJoined = false;
    const copySpy = vi
      .spyOn(fs.promises, "cp")
      .mockImplementation(async (source, destination, options) => {
        if (!privateRoot) {
          privateRoot = path.dirname(String(destination));
          started.resolve();
          await release.promise;
          await copy(source, destination, options);
          writerJoined = true;
          return;
        }
        await copy(source, destination, options);
      });
    const attempt = runNodeCommand(tmp, {
      process: fakeProcess,
      spawn: cli,
      spawnSync,
      runBuild: build,
      runRuntimePostBuild: postbuild,
      env:
        mode === "build"
          ? { OPENCLAW_FORCE_BUILD: "1" }
          : { OPENCLAW_FORCE_RUNTIME_POSTBUILD: "1" },
    });
    let outcome: Awaited<typeof attempt> | undefined;
    try {
      await started.promise;
      fakeProcess.emit(signal);
      expect(writerJoined).toBe(false);
      expect(fs.existsSync(privateRoot)).toBe(true);
      expect(fs.existsSync(path.join(tmp, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(true);
    } finally {
      release.resolve();
      // Even a failing boundary assertion must join the admitted copy before
      // the fixture retires its checkout.
      outcome = await attempt;
      copySpy.mockRestore();
    }
    expect(outcome).toBe(process.platform === "win32" ? (signal === "SIGINT" ? 130 : 143) : signal);
    expect(writerJoined).toBe(true);
    expect(build).not.toHaveBeenCalled();
    expect(postbuild).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmp, DIST_ENTRY), "utf8")).toBe(before);
    expect(fs.existsSync(privateRoot)).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(false);
    expect(fakeProcess.listenerCount(signal)).toBe(0);
  },
);

it.for(["candidate copy", "first swap", "last swap", "cleanup"] as const)(
  "does not launch the CLI after cancellation during %s",
  async (boundary, { tmp }) => {
    await setupStampedProject(tmp, {
      trackConfig: true,
      files: { "packages/ai/dist/index.js": "old package" },
    });
    const original = fs.readFileSync(path.join(tmp, DIST_ENTRY), "utf8");
    const stamp = fs.readFileSync(path.join(tmp, BUILD_STAMP), "utf8");
    const fakeProcess = createFakeProcess();
    const { spawn, spawnSync } = createCurrentGitSpawnRecorder();
    const cli = vi.fn(spawn);
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
      fakeProcess.emit("SIGTERM");
    };
    const copy = fs.promises.cp.bind(fs.promises);
    vi.spyOn(fs.promises, "cp").mockImplementation(async (source, destination, options) => {
      await copy(source, destination, options);
      if (boundary === "candidate copy" && String(destination).endsWith("candidate")) {
        interrupt();
      }
    });
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      rename(source, destination);
      if (
        String(source).endsWith("candidate") &&
        String(destination) ===
          path.join(tmp, boundary === "first swap" ? "dist" : "packages/ai/dist") &&
        boundary.endsWith("swap")
      ) {
        interrupt();
      }
    });
    const remove = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (boundary === "cleanup" && path.basename(String(target)).startsWith("source-build-")) {
        interrupt();
      }
      await remove(target, options);
    });
    const outcome = await runNodeCommand(tmp, {
      process: fakeProcess,
      spawn: cli,
      spawnSync,
      env: { OPENCLAW_FORCE_BUILD: "1" },
      runBuild: async ({ cwd }) => {
        fs.writeFileSync(path.join(cwd!, DIST_ENTRY), "candidate");
        fs.writeFileSync(path.join(cwd!, "packages/ai/dist/index.js"), "candidate package");
        return 0;
      },
    });
    expect(interrupted).toBe(true);
    expect(outcome).toBe(process.platform === "win32" ? 143 : "SIGTERM");
    expect(cli).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmp, DIST_ENTRY), "utf8")).toBe(
      boundary === "cleanup" ? "candidate" : original,
    );
    expect(fs.readFileSync(path.join(tmp, "packages/ai/dist/index.js"), "utf8")).toBe(
      boundary === "cleanup" ? "candidate package" : "old package",
    );
    expect(fs.readFileSync(path.join(tmp, BUILD_STAMP), "utf8")).toBe(stamp);
    expect(fs.readdirSync(path.join(tmp, ".artifacts"))).not.toContainEqual(
      expect.stringMatching(/^source-build-/),
    );
    expect(fs.readdirSync(tmp)).not.toContainEqual(expect.stringMatching(/^\.openclaw-runtime-/));
    expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
  },
);

it.for([
  { commandExit: 0, logFailure: false },
  { commandExit: 0, logFailure: true },
  { commandExit: 42, logFailure: false },
  { commandExit: 42, logFailure: true },
])(
  "preserves cancellation during output-log close (exit=$commandExit, logFailure=$logFailure)",
  async ({ commandExit, logFailure }, { tmp }) => {
    await setupStampedProject(tmp, { trackConfig: true });
    const fakeProcess = createFakeProcess();
    const { spawnSync } = createCurrentGitSpawnRecorder();
    const createWriteStream = fs.createWriteStream.bind(fs);
    const streams: fs.WriteStream[] = [];
    const closed: Promise<void>[] = [];
    const messages: string[] = [];
    vi.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
      const stream = createWriteStream(file, options);
      const completion = createDeferred();
      streams.push(stream);
      closed.push(completion.promise);
      stream.once("close", completion.resolve);
      stream.once("finish", () => {
        fakeProcess.emit("SIGTERM");
        if (logFailure) {
          stream.emit("error", new Error("synthetic output-log close failure"));
        }
      });
      return stream;
    });
    try {
      const outcome = await runNodeCommand(tmp, {
        process: fakeProcess,
        spawn: () => createExitedProcess(commandExit),
        spawnSync,
        stderr: {
          write: (message) => {
            messages.push(String(message));
            return true;
          },
        },
        env: { OPENCLAW_RUN_NODE_OUTPUT_LOG: "output.log" },
      });
      expect(outcome).toBe(process.platform === "win32" ? 143 : "SIGTERM");
      expect(messages.join("").includes("synthetic output-log close failure")).toBe(logFailure);
      expect(fakeProcess.listenerCount("SIGTERM")).toBe(0);
    } finally {
      for (const stream of streams) {
        stream.destroy();
      }
      await Promise.all(closed);
    }
  },
);

// One native boundary proof covers the actual shim, signal delivery, private
// copier and managed compiler admission. Other phase transitions stay in-process.
it.runIf(process.platform !== "win32")(
  "preserves an actual staging SIGINT through the source runner shim",
  async ({ tmp }) => {
    const checkout = path.join(tmp, "checkout");
    fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(checkout, ".git"));
    fs.mkdirSync(path.join(checkout, "dist"));
    fs.writeFileSync(path.join(checkout, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(checkout, "dist/entry.js"), "original");
    const compilerMarker = path.join(tmp, "compiler-started");
    const cliMarker = path.join(tmp, "cli-started");
    fs.writeFileSync(
      path.join(checkout, "scripts/build-all.mts"),
      'import fs from "node:fs"; fs.writeFileSync(' +
        JSON.stringify(compilerMarker) +
        ', "started"); fs.writeFileSync("dist/entry.js", "candidate");',
    );
    fs.writeFileSync(
      path.join(checkout, "openclaw.mjs"),
      'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(cliMarker) + ', "started");',
    );
    const hook = path.join(tmp, "interrupt.mjs");
    fs.writeFileSync(
      hook,
      `
import fs from "node:fs";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { registerSourceRunnerServiceFixture } from ${JSON.stringify(pathToFileURL(path.resolve("test/scripts/fixtures/source-runner-service.mjs")).href)};
registerSourceRunnerServiceFixture(${JSON.stringify(process.cwd())});
const cp = fs.promises.cp.bind(fs.promises);
let interrupted = false;
fs.promises.cp = async (...args) => {
  if (!interrupted && String(args[1]).includes("source-build-")) {
    interrupted = true;
    // Signal watchers and a pending Promise do not keep Node alive. Hold an
    // event source until delivery, without a timing-dependent sleep or poll.
    const { port1, port2 } = new MessageChannel();
    port1.on("message", () => {});
    const received = once(process, "SIGINT");
    process.kill(process.pid, "SIGINT");
    await received;
    port1.close();
    port2.close();
    await cp(...args);
    fs.writeFileSync(${JSON.stringify(path.join(tmp, "copy-settled"))}, "settled");
    return;
  }
  return cp(...args);
};
`,
    );
    let actualExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const result = await runNodeScript(
      [path.resolve("scripts/run-node.mjs"), "--version"],
      {
        ...process.env,
        NODE_OPTIONS: "--import=" + pathToFileURL(hook).href,
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        OPENCLAW_FORCE_BUILD: "1",
        OPENCLAW_RUNNER_LOG: "0",
      },
      10_000,
      {
        cwd: checkout,
        requireProcessTreeExit: true,
        onReady(child) {
          child.once("exit", (code, signal) => {
            actualExit = { code, signal };
          });
        },
      },
    );
    expect(result.error, formatShimResult(result)).toBeUndefined();
    expect(
      {
        actualExit,
        status: result.status,
        copySettled: fs.existsSync(path.join(tmp, "copy-settled")),
        compilerStarted: fs.existsSync(compilerMarker),
        cliStarted: fs.existsSync(cliMarker),
        published: fs.readFileSync(path.join(checkout, "dist/entry.js"), "utf8"),
      },
      formatShimResult(result),
    ).toEqual({
      actualExit: { code: null, signal: "SIGINT" },
      status: 130,
      copySettled: true,
      compilerStarted: false,
      cliStarted: false,
      published: "original",
    });
    expect(fs.readdirSync(path.join(checkout, ".artifacts"))).not.toContainEqual(
      expect.stringMatching(/^source-build-/),
    );
    expect(fs.existsSync(path.join(checkout, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(
      false,
    );
  },
);

it("retains originals when rollback authority is lost after cancellation", async ({ tmp }) => {
  const publication = createRuntimePublication();
  const controller = new AbortController();
  const roots = ["first", "second"].map((name) => {
    const destination = path.join(tmp, name);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "value"), "original " + name);
    const entry = publication.stageRoot(destination, tmp);
    fs.mkdirSync(entry.candidate);
    fs.writeFileSync(path.join(entry.candidate, "value"), "candidate " + name);
    entry.changed = true;
    return entry;
  });
  let checks = 0;
  const prepared = publication.finish();
  await expect(
    prepared.publish(async () => {
      checks++;
      if (checks === 2) {
        controller.abort(new Error("cancel publication"));
      }
      if (checks > 2) {
        throw new Error("authority lost");
      }
    }, controller.signal),
  ).rejects.toThrow("Runtime publication and restoration failed");
  await prepared.cleanup();
  expect(checks).toBe(3);
  expect(fs.readFileSync(path.join(roots[0]!.destination, "value"), "utf8")).toBe(
    "candidate first",
  );
  expect(fs.readFileSync(path.join(roots[0]!.previous, "value"), "utf8")).toBe("original first");
  expect(fs.readFileSync(path.join(roots[1]!.destination, "value"), "utf8")).toBe(
    "original second",
  );
  expect(fs.existsSync(roots[1]!.temporary)).toBe(false);
});
