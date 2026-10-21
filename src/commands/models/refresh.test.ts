import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../../cli/failure-output.js";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), getConfig: vi.fn(() => ({})) }));
// mock-isolation: Output tests exercise an offline refresh; admission has separate boundary coverage.
vi.mock("../../cli/local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({
    runLocal,
  }: Parameters<typeof import("../../cli/local-state-owner.js").runWithLocalStateOwner>[0]) =>
    runLocal({
      env: process.env,
      config: mocks.getConfig(),
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
}));
vi.mock("../../model-catalog/remote-refresh.js", () => ({
  refreshRemoteModelCatalog: mocks.refresh,
}));

import { modelsRefreshCommand } from "./refresh.js";

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function expectNoFailureOutput(commandRuntime: ReturnType<typeof runtime>) {
  expect(commandRuntime.log).not.toHaveBeenCalled();
  expect(commandRuntime.error).not.toHaveBeenCalled();
  expect(commandRuntime.exit).not.toHaveBeenCalled();
}

beforeEach(() => mocks.refresh.mockReset());

describe("models refresh", () => {
  it.each(["updated", "fresh", "disabled"] as const)("prints %s human results", async (status) => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce(
      status === "disabled"
        ? { status, providers: 0, models: 0 }
        : { status, providers: 2, models: 3, generatedAt: 1_753_500_000_000 },
    );
    await modelsRefreshCommand({}, commandRuntime);
    expect(commandRuntime.log).toHaveBeenLastCalledWith(
      status === "disabled"
        ? "Remote catalog refresh is disabled (models.catalogRefresh.enabled=false)"
        : expect.stringContaining(`Remote catalog refresh: ${status}`),
    );
  });

  it("delegates refresh failures to the canonical CLI error owner", async () => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "error",
      providers: 0,
      models: 0,
      error: "boom",
    });

    const execution = modelsRefreshCommand({ json: true }, commandRuntime);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message: "Remote catalog refresh failed: boom",
      humanOutput: "Remote catalog refresh failed: boom",
      machineOutput: "Remote catalog refresh failed: boom",
    });
    expect(commandRuntime.writeJson).not.toHaveBeenCalled();
    expectNoFailureOutput(commandRuntime);
  });

  it("preserves the JSON domain payload", async () => {
    const result = {
      status: "fresh",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
      nextCheckInMs: 1_000,
    };
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce(result);

    await modelsRefreshCommand({ json: true }, commandRuntime);

    expect(commandRuntime.writeJson).toHaveBeenCalledWith(result, 0);
    expectNoFailureOutput(commandRuntime);
  });
});
