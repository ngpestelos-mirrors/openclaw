import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { gatewayDirectStopEntrypoints } from "../cli-entrypoint.test-support.js";
import { createProcessFixtures } from "./run-loop-process.test-support.js";

const fixtures = createProcessFixtures("restart liveness cleanup failed", 5_000);
const moduleUrl = (entry: Parameters<typeof resolveRuntimeWorkerUrl>[0]) =>
  JSON.stringify(resolveRuntimeWorkerUrl(entry).href);

const childScript = `
  import fs from "node:fs";
  import http from "node:http";
  import { runGatewayLoop } from ${moduleUrl(gatewayDirectStopEntrypoints.runLoop)};
  import { setGatewayRestartPolicy } from ${moduleUrl(gatewayDirectStopEntrypoints.restartPolicy)};
  import { fileLogTransport } from ${moduleUrl(gatewayDirectStopEntrypoints.fileLogTransport)};
  const faultPath = process.argv[1];
  const closeFailure = process.argv[2];
  setGatewayRestartPolicy({ allowExternal: true });
  let starts = 0;
  try {
    process.once("beforeExit", () => process.stdout.write("natural-exit\\n"));
    process.exitCode = await runGatewayLoop({
      ownsProcessLifecycle: true,
      start: async () => {
        const attempt = ++starts;
        process.stdout.write("start:" + attempt + "\\n");
        if (fs.existsSync(faultPath)) {
          process.stdout.write("waiting:" + starts + "\\n");
          throw new Error("fixture startup refused");
        }
        const server = http.createServer((_request, response) => response.end("ready"));
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        process.stdout.write("ready:" + attempt + "\\n");
        return {
          getTailscaleIngressEndpoint: () => undefined,
          startupSettled: Promise.resolve(),
          close: async () => {
            if (closeFailure === "pending") {
              fileLogTransport.setAppenderForTests(() => {
                process.stdout.write("append:pending\\n");
                return new Promise(() => {});
              });
              process.stdout.write("close:pending\\n");
              return new Promise(() => {});
            }
            await new Promise((resolve, reject) => {
              server.close(error => error ? reject(error) : resolve());
            });
            if (closeFailure) {
              process.stdout.write("http-closed:" + attempt + "\\n");
              const error = new TypeError("fixture close owner failed");
              error.stack = "TypeError: fixture close owner failed\\n    at closeOwner (fixture.js:12:3)";
              throw error;
            }
            process.stdout.write("closed:" + attempt + "\\n");
          },
        };
      },
    });
    process.stdout.write("loop-returned:" + process.exitCode + "\\n");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
`;

function startFixture(initialFailure = false, closeFailure = "", executable = process.execPath) {
  const directory = fixtures.make("openclaw-restart-liveness-");
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  const pendingClose = closeFailure === "pending";
  const bin = path.join(directory, "bin");
  if (pendingClose) {
    fs.mkdirSync(bin);
    // This fixture owns a short native deadline, independent of the service policy.
    fs.writeFileSync(
      path.join(bin, "launchctl"),
      `#!/bin/sh\nprintf '\\tstate = SIGTERMed\\n\\texit timeout = 10\\n\\tpid = %s\\n' "$(cat "$0.pid")"\n`,
      { mode: 0o755 },
    );
  }
  const faultPath = path.join(directory, "startup-fault");
  const logFile = path.join(directory, "gateway.jsonl");
  const stateDir = path.join(directory, "state");
  fs.writeFileSync(
    path.join(directory, "openclaw.json"),
    JSON.stringify({ logging: { level: "info", file: logFile } }),
  );
  if (initialFailure) {
    fs.writeFileSync(faultPath, "refuse");
  }
  const child = spawn(
    executable,
    [
      "--inspect-port=127.0.0.1:0",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      childScript,
      faultPath,
      closeFailure,
    ],
    {
      env: {
        PATH: pendingClose ? `${bin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
        HOME: home,
        TMPDIR: directory,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
        OPENCLAW_NO_RESPAWN: "1",
        ...(pendingClose ? { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway.test" } : {}),
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
        ESBUILD_WORKER_THREADS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const tracked = fixtures.ownChild(child);
  if (pendingClose) {
    // Native queries may run through the spawn broker, so report the fixture's PID.
    fs.writeFileSync(path.join(bin, "launchctl.pid"), String(child.pid));
  }
  const output = () => tracked.output.stdout + tracked.output.stderr;
  const waitForOutput = (text: string) =>
    vi.waitFor(() => expect(output()).toContain(text), { timeout: 45_000, interval: 25 });
  return { ...tracked, faultPath, logFile, stateDir, waitForOutput, output };
}

async function expectFailedRestartWaiting(
  fixture: ReturnType<typeof startFixture>,
  attempt: number,
) {
  expect(fixture.child.kill("SIGUSR2")).toBe(true);
  await fixture.waitForOutput(`waiting:${attempt}`);
  // Only the parent observes an idle interval. A child timer or IPC channel
  // would hide the lost-process regression after its real listener closes.
  expect(
    await Promise.race([
      fixture.closed.then((exit) => ({ exit })),
      delay(750).then(() => "waiting"),
    ]),
    fixture.output(),
  ).toBe("waiting");
}

function readStabilityBundle(fixture: ReturnType<typeof startFixture>) {
  const directory = path.join(fixture.stateDir, "logs", "stability");
  const files = fs.readdirSync(directory);
  expect(files).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(directory, files[0]!), "utf8"));
}

describe("runGatewayLoop failed-restart process lifetime", { timeout: 60_000 }, () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("attaches the Node debugger on SIGUSR1 and restarts only on SIGUSR2", async () => {
    const fixture = startFixture(false, "", resolveTestNodeExecPath());
    await fixture.waitForOutput("ready:1");
    expect(fixture.child.kill("SIGUSR1")).toBe(true);
    await fixture.waitForOutput("Debugger listening on ws://127.0.0.1:");
    const inspectorUrl = fixture.output().match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
    expect(inspectorUrl).toBeDefined();
    const debuggerSocket = new WebSocket(inspectorUrl!);
    try {
      await once(debuggerSocket, "open");
      const reply = once(debuggerSocket, "message");
      debuggerSocket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "process.pid" },
        }),
      );
      const [data] = await reply;
      expect(JSON.parse(String(data))).toMatchObject({
        id: 1,
        result: { result: { value: fixture.child.pid } },
      });
      expect(fixture.output()).not.toContain("start:2");
    } finally {
      const closed = once(debuggerSocket, "close");
      debuggerSocket.close();
      await closed;
    }
    expect(fixture.child.kill("SIGUSR2")).toBe(true);
    await fixture.waitForOutput("ready:2");
    expect(fixture.child.kill("SIGTERM")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    expect(fixture.output()).toContain("natural-exit");
  });

  it.skipIf(process.platform !== "darwin")(
    "retains the hard watchdog when shutdown and its log append never settle",
    async () => {
      const fixture = startFixture(false, "pending");
      await fixture.waitForOutput("ready:1");
      expect(fixture.child.kill("SIGTERM")).toBe(true);
      await fixture.waitForOutput("close:pending");
      expect(await fixture.closed, fixture.output()).toEqual([null, "SIGKILL"]);
      expect(fixture.output()).not.toContain("natural-exit");
      expect(fixture.output()).not.toContain("loop-returned:");
      expect(fixture.output()).toContain("append:pending");
      expect(readStabilityBundle(fixture)).toMatchObject({
        reason: "gateway.stop_shutdown_timeout",
      });
    },
  );

  posixIt("naturally exits nonzero when native close rejects", async () => {
    const fixture = startFixture(false, "rejected");
    const error = { name: "TypeError", message: "fixture close owner failed" };
    await fixture.waitForOutput("ready:1");
    expect(fixture.child.kill("SIGUSR2")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([1, null]);
    expect(fixture.output()).toContain("http-closed:1");
    expect(fixture.output()).toContain("loop-returned:1");
    expect(fixture.output()).toContain("natural-exit");
    expect(fixture.output()).not.toContain("shutdown deadline reached");
    expect(readStabilityBundle(fixture)).toMatchObject({
      reason: "gateway.restart_close_failed",
      error,
      evidence: {
        shutdown: {
          step: "gateway-server-close",
          errors: [
            {
              ...error,
              stack: "TypeError: fixture close owner failed\n    at closeOwner (fixture.js:12:3)",
            },
          ],
        },
      },
    });
    expect(fs.readFileSync(fixture.logFile, "utf8")).toContain(
      "shutdown step failed (gateway server close): fixture close owner failed",
    );
    expect(fixture.output()).not.toContain("start:2");
  });

  posixIt("recovers in-process after repeated failed restarts", async () => {
    const fixture = startFixture();
    await fixture.waitForOutput("ready:1");
    fs.writeFileSync(fixture.faultPath, "refuse");
    await expectFailedRestartWaiting(fixture, 2);
    await expectFailedRestartWaiting(fixture, 3);
    fs.unlinkSync(fixture.faultPath);
    expect(fixture.child.kill("SIGUSR2")).toBe(true);
    await fixture.waitForOutput("ready:4");
    expect(fixture.child.kill("SIGTERM")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([0, null]);
  });

  posixIt("exits cleanly on SIGTERM while waiting after a failed restart", async () => {
    const fixture = startFixture();
    await fixture.waitForOutput("ready:1");
    fs.writeFileSync(fixture.faultPath, "refuse");
    await expectFailedRestartWaiting(fixture, 2);
    expect(fixture.child.kill("SIGTERM")).toBe(true);
    expect(await fixture.closed, fixture.output()).toEqual([0, null]);
    expect(fixture.output()).not.toContain("start:3");
  });

  posixIt("releases process ownership when initial startup rejects", async () => {
    const fixture = startFixture(true);
    expect(await fixture.closed, fixture.output()).toEqual([1, null]);
    expect(fixture.output()).toContain("fixture startup refused");
    expect(fixture.output()).not.toContain("Process will stay alive");
  });
});
