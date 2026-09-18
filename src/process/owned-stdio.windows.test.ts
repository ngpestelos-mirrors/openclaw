import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createStubChild } from "./supervisor/adapters/child.test-support.js";

const native = vi.hoisted(() => ({
  spawn: vi.fn(),
  koffiAvailable: true,
  launcherAvailable: true,
  inspect: vi.fn<() => number[]>(),
  terminate: vi.fn(),
  close: vi.fn(() => true),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: native.spawn,
}));
vi.mock("node:module", async (original) => {
  const actual = await original<typeof import("node:module")>();
  const createRequire = (...args: Parameters<typeof actual.createRequire>) =>
    new Proxy(actual.createRequire(...args), {
      apply: (target, receiver, argumentsList) =>
        argumentsList[0] === "koffi"
          ? (() => {
              if (!native.koffiAvailable) throw new Error("Cannot find module koffi");
              return {};
            })()
          : Reflect.apply(target, receiver, argumentsList),
    });
  return new Proxy(actual, {
    get: (target, property, receiver) =>
      property === "createRequire" ? createRequire : Reflect.get(target, property, receiver),
  });
});
vi.mock("./supervisor/service-child-windows-job-native.ts", () => ({
  createWindowsJobBindings: () => ({
    assertLayouts() {},
    CreateJobObjectW: () => 1n,
    requireHandle: (handle: bigint) => handle,
    SetExtendedLimits: () => true,
    TerminateJobObject: native.terminate,
    CloseHandle: native.close,
    readJobProcessIds: native.inspect,
    lastError: (operation: string) => new Error(operation),
  }),
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (target: Parameters<typeof actual.existsSync>[0]) =>
      String(target).includes("managed-windows-job-launcher")
        ? native.launcherAvailable
        : actual.existsSync(target),
  };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let createOwnedStdioProcess: typeof import("./owned-stdio.js").createOwnedStdioProcess;
let closeOwnedStdioProcess: typeof import("./owned-stdio.js").closeOwnedStdioProcess;
let createProcessSupervisor: typeof import("./supervisor/supervisor.js").createProcessSupervisor;
let stub: ReturnType<typeof createStubChild>;
beforeEach(async () => {
  vi.resetModules();
  ({ createOwnedStdioProcess, closeOwnedStdioProcess } = await import("./owned-stdio.js"));
  ({ createProcessSupervisor } = await import("./supervisor/supervisor.js"));
  native.koffiAvailable = true;
  native.launcherAvailable = true;
  Object.defineProperty(process, "platform", { value: "win32" });
  stub = createStubChild();
  native.inspect.mockReset().mockReturnValue([1234]);
  native.close.mockReset().mockReturnValue(true);
  native.terminate.mockReset().mockImplementation(() => {
    native.inspect.mockReturnValue([]);
    stub.child.stdout?.emit("end");
    stub.child.stderr?.emit("end");
    stub.emitClose(0);
    return true;
  });
  native.spawn.mockReset().mockImplementation((_command, args) => {
    stub.child.send = vi.fn((message: unknown, ...sendArgs: unknown[]) => {
      if (message && typeof message === "object" && "command" in message) {
        stub.child.emit("message", { job: args[1], type: "spawned", pid: 5678 });
      }
      const callback = sendArgs.findLast((value) => typeof value === "function");
      if (typeof callback === "function") {
        callback(null);
      }
      return true;
    });
    queueMicrotask(() => {
      stub.child.emit("spawn");
      stub.child.emit("message", { job: args[1], type: "ready" });
    });
    return stub.child;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
});

it("joins the retained Windows Job after the root exits with descendants still holding stdio", async () => {
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  child.onStdout(() => {});
  child.onStderr(() => {});
  try {
    expect(child.waitForExtinction).toBeTypeOf("function");
    expect(child.pid).toBe(5678);
    const observed = createDeferred();
    native.inspect.mockImplementation(() => {
      observed.resolve();
      return [9876];
    });
    stub.emitExit(0);
    const confirmed = vi.fn();
    void child.waitForExtinction!().then(confirmed);
    await observed.promise;
    expect(confirmed).not.toHaveBeenCalled();
    await closeOwnedStdioProcess(child, { force: true });
    expect(confirmed).toHaveBeenCalledWith({ status: "confirmed" });
    expect(native.terminate).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  } finally {
    native.inspect.mockReturnValue([]);
    stub.emitClose(0);
    child.dispose();
  }
});

it("retains a failed Job observation as cleanup uncertainty", async () => {
  const cause = new Error("Job accounting unavailable");
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  native.inspect.mockImplementation(() => {
    throw cause;
  });
  stub.emitExit(0);
  stub.emitClose(0);
  await expect(closeOwnedStdioProcess(child)).rejects.toBe(cause);
  expect(native.close).toHaveBeenCalledOnce();
});

it("publishes an empty Job's cleanup before the root completion", async () => {
  const child = await createOwnedStdioProcess({
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  let confirmed = false;
  const extinction = child.waitForExtinction!().then(() => {
    confirmed = true;
  });
  native.inspect.mockReturnValue([]);
  stub.emitExit(0);
  stub.emitClose(0);
  try {
    await child.wait();
    expect(confirmed).toBe(true);
  } finally {
    await extinction;
    child.dispose();
  }
});

it.each(["koffi", "launcher"] as const)(
  "spawns without %s and reports unavailable Job certification",
  async (missing) => {
    native.koffiAvailable = missing !== "koffi";
    native.launcherAvailable = missing !== "launcher";
    const child = await createOwnedStdioProcess({
      argv: [process.execPath, "fixture"],
      exactEnv: true,
    });
    expect(native.spawn).toHaveBeenCalledWith(process.execPath, ["fixture"], expect.any(Object));
    stub.emitExit(0);
    stub.emitClose(0);
    await expect(child.wait()).resolves.toEqual({ code: 0, signal: null });
    await expect(child.waitForExtinction!()).resolves.toEqual({
      status: "uncertain",
      reason: "job-unavailable",
    });
    await expect(closeOwnedStdioProcess(child)).resolves.toBeUndefined();
    expect(native.terminate).not.toHaveBeenCalled();
    expect(native.close).not.toHaveBeenCalled();
  },
);

it("preserves unavailable certification through a supervised exec session", async () => {
  native.koffiAvailable = false;
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({
    mode: "child",
    argv: [process.execPath, "fixture"],
    exactEnv: true,
  });
  stub.child.stdout?.emit("end");
  stub.child.stderr?.emit("end");
  stub.emitExit(0);
  stub.emitClose(0);
  await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, reason: "exit" });
  await expect(run.waitForExtinction!()).resolves.toEqual({
    status: "uncertain",
    reason: "job-unavailable",
  });
  await supervisor.shutdown();
});
